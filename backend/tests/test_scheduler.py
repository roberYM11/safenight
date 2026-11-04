"""Scheduling decisions use a real database and injected clock/job boundary."""

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy.ext.asyncio import AsyncEngine
from test_pipeline_api import Environment

from safenight_backend import schedule
from safenight_backend.config import Settings
from safenight_backend.db import session_factory
from safenight_backend.repository import (
    BatchCommit,
    SourceWindow,
    commit_records,
    create_run,
    mark_failed,
)
from safenight_backend.runner import CollectionOutcome, CollectionRequest

pytestmark = pytest.mark.anyio
pytest_plugins = ("test_pipeline_api",)


async def test_schedule_runs_at_kst_boundary_and_deduplicates_completed_windows(
    environment: Environment,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Given: an injected clock at 03:00 KST and a real empty-success ingestion boundary.
    calls: list[CollectionRequest] = []

    async def empty_job(
        engine: AsyncEngine, _: Settings, request: CollectionRequest
    ) -> CollectionOutcome:
        calls.append(request)
        async with session_factory(engine).begin() as session:
            run = await create_run(
                session, SourceWindow(request.source, request.start, request.end)
            )
            run.started_at = now
            await commit_records(session, BatchCommit(run.id, (), request.start, request.end))
        return CollectionOutcome(run.id, request.source, "success")

    monkeypatch.setattr(schedule, "collect", empty_job)
    settings = environment.settings.model_copy(update={"correction_days": 2})
    now = datetime(2026, 11, 3, 18, tzinfo=UTC)
    await schedule.run_due(environment.engine, settings, now)
    first = len(calls)
    # When: the daemon checks the same scheduled day a second time.
    await schedule.run_due(environment.engine, settings, now)
    # Then: yesterday plus the older correction window ran once per source, without another fit/run.
    assert first == 2
    assert len(calls) == first
    assert calls[0].start.isoformat() == "2026-11-03T00:00:00+09:00"
    assert calls[0].end.isoformat() == "2026-11-04T00:00:00+09:00"


async def test_recent_failure_defers_source_without_advancing_its_checkpoint(
    environment: Environment,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Given: one source failed moments ago; a scheduler restart must not hammer its provider.
    now = datetime(2026, 11, 3, 18, tzinfo=UTC)
    async with session_factory(environment.engine).begin() as session:
        run = await create_run(session, SourceWindow("sdot", now - timedelta(days=1), now))
        run.started_at = now
        await mark_failed(session, run.id, "fixture_provider_failure")
    calls: list[str] = []

    async def paused_job(
        _: AsyncEngine, __: Settings, request: CollectionRequest
    ) -> CollectionOutcome:
        calls.append(request.source)
        return CollectionOutcome("", request.source, "busy")

    monkeypatch.setattr(schedule, "collect", paused_job)
    # When: the scheduler evaluates due sources.
    await schedule.run_due(environment.engine, environment.settings, now)
    # Then: the only active source observes its retry pause; retired sources never run.
    assert calls == []
