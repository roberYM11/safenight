"""Persistent daily scheduling decisions are driven by source checkpoints, not memory timers."""

from datetime import UTC, datetime, time, timedelta
from typing import Final
from zoneinfo import ZoneInfo

import anyio
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncEngine

from safenight_backend.config import Settings
from safenight_backend.db import session_factory
from safenight_backend.models import SourceCheckpoint, SourceRun
from safenight_backend.runner import CollectionOutcome, CollectionRequest, SourceName, collect

SEOUL: Final = ZoneInfo("Asia/Seoul")
SOURCES: Final[tuple[SourceName, ...]] = ("sdot", "cctv")


async def recheck_windows(
    engine: AsyncEngine,
    settings: Settings,
    window: CollectionRequest,
) -> tuple[CollectionOutcome, ...]:
    """Recheck historical windows once per schedule day independently of the cursor."""
    outcomes: list[CollectionOutcome] = []
    factory = session_factory(engine)
    for offset in range(settings.correction_days, 0, -1):
        end = window.end - timedelta(days=offset - 1)
        start = end - timedelta(days=1)
        async with factory() as session:
            completed = await session.scalar(
                select(SourceRun.id)
                .where(
                    SourceRun.source == window.source,
                    SourceRun.status == "success",
                    SourceRun.window_start == start,
                    SourceRun.window_end == end,
                    SourceRun.started_at >= window.end,
                )
                .limit(1)
            )
        if completed is not None:
            continue
        outcome = await collect(engine, settings, CollectionRequest(window.source, start, end))
        outcomes.append(outcome)
        if outcome.status != "success":
            break
    return tuple(outcomes)


async def run_due(
    engine: AsyncEngine, settings: Settings, now: datetime
) -> tuple[CollectionOutcome, ...]:
    """Catch up whole KST days in order; a failed date never silently disappears."""
    local = now.astimezone(SEOUL)
    target = datetime.combine(local.date(), time.min, tzinfo=SEOUL)
    if (local.hour, local.minute) < (settings.collection_hour, settings.collection_minute):
        target -= timedelta(days=1)
    outcomes: list[CollectionOutcome] = []
    factory = session_factory(engine)
    for source in SOURCES:
        async with factory() as session:
            checkpoint = await session.scalar(
                select(SourceCheckpoint).where(SourceCheckpoint.source == source)
            )
            latest = await session.scalar(
                select(SourceRun)
                .where(
                    SourceRun.source == source,
                )
                .order_by(SourceRun.started_at.desc())
                .limit(1)
            )
        if latest and latest.status == "failed" and latest.started_at > now - timedelta(minutes=15):
            continue
        start = (
            checkpoint.covered_until.astimezone(SEOUL) if checkpoint else target - timedelta(days=1)
        )
        if target - start > timedelta(days=29):
            outcomes.append(
                CollectionOutcome("", source, "failed", error_code="archive_backfill_required")
            )
            continue
        while start < target:
            end = min(start + timedelta(days=1), target)
            outcome = await collect(engine, settings, CollectionRequest(source, start, end))
            outcomes.append(outcome)
            if outcome.status != "success":
                break
            start = end
        if start < target:
            continue
        outcomes.extend(
            await recheck_windows(
                engine,
                settings,
                CollectionRequest(source, target - timedelta(days=1), target),
            )
        )
    return tuple(outcomes)


async def scheduler(engine: AsyncEngine, settings: Settings) -> None:
    """Run as a separate process; restart recovers from committed checkpoints."""
    while True:
        _ = await run_due(engine, settings, datetime.now(UTC))
        await anyio.sleep(60)
