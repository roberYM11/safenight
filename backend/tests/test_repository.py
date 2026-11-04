"""Integration tests require real PostgreSQL; no SQLite substitute is used."""

import os
from collections.abc import AsyncIterator
from dataclasses import replace
from datetime import UTC, datetime, timedelta, timezone
from uuid import uuid4

import anyio
import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker
from sqlalchemy.schema import CreateSchema, DropSchema

from safenight_backend.db import make_engine, session_factory
from safenight_backend.migrations import initialize
from safenight_backend.models import (
    CurrentObservation,
    ObservationRevision,
    RawObject,
    SourceCheckpoint,
)
from safenight_backend.repository import (
    BatchCommit,
    Record,
    SourceWindow,
    StorageContractError,
    archive_page,
    commit_records,
    create_run,
)

NOW = datetime(2026, 11, 3, tzinfo=UTC)
WINDOW = SourceWindow("fixture", NOW - timedelta(days=1), NOW)
pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.fixture
async def engine() -> AsyncIterator[AsyncEngine]:
    url = os.environ.get("SAFENIGHT_TEST_DATABASE_URL")
    if not url:
        pytest.skip("Set SAFENIGHT_TEST_DATABASE_URL to run real PostgreSQL integration tests")
    original = make_engine(url)
    schema = "fixture_" + uuid4().hex
    async with original.begin() as connection:
        await connection.execute(CreateSchema(schema))
    scoped = original.execution_options(schema_translate_map={None: schema})
    try:
        await initialize(scoped)
        yield scoped
    finally:
        async with original.begin() as connection:
            await connection.execute(DropSchema(schema, cascade=True))
        await original.dispose()


def record(raw_sha: str) -> Record:
    return Record(
        source="fixture",
        entity_id="sensor-A",
        observed_at=NOW - timedelta(hours=1),
        published_at=NOW,
        revision_rank=1,
        source_updated_at=None,
        payload_json='{"noise_db":48}',
        raw_sha=raw_sha,
    )


async def prepare(factory: async_sessionmaker[AsyncSession]) -> tuple[str, str]:
    async with factory.begin() as session:
        run = await create_run(session, WINDOW)
        sha = await archive_page(session, WINDOW.source, b'{"provider":"fixture"}')
    return run.id, sha


async def test_replaying_batch_keeps_one_revision_and_one_raw_object(engine: AsyncEngine) -> None:
    # Given: one successful provider response already committed.
    factory = session_factory(engine)
    run_id, sha = await prepare(factory)
    async with factory.begin() as session:
        await commit_records(session, BatchCommit(run_id, (record(sha),), WINDOW.window_start, NOW))
    other_run, _ = await prepare(factory)
    # When: a later run delivers identical normalized content.
    async with factory.begin() as session:
        result = await commit_records(
            session,
            BatchCommit(other_run, (record(sha),), WINDOW.window_start, NOW),
        )
    # Then: revisions and immutable raw objects are not duplicated.
    async with factory() as session:
        assert result.inserted == 0
        assert await session.scalar(select(func.count()).select_from(ObservationRevision)) == 1
        assert await session.scalar(select(func.count()).select_from(RawObject)) == 1


async def test_late_provisional_cannot_replace_corrected_measurement(engine: AsyncEngine) -> None:
    # Given: corrected provider data arrives first.
    factory = session_factory(engine)
    run_id, sha = await prepare(factory)
    correction = replace(record(sha), revision_rank=2, payload_json='{"noise_db":57}')
    async with factory.begin() as session:
        await commit_records(session, BatchCommit(run_id, (correction,), WINDOW.window_start, NOW))
    other_run, _ = await prepare(factory)
    # When: a late provisional measurement is replayed.
    async with factory.begin() as session:
        await commit_records(
            session, BatchCommit(other_run, (record(sha),), WINDOW.window_start, NOW)
        )
    # Then: both revisions are retained while current points to corrected content.
    async with factory() as session:
        current = await session.scalar(
            select(ObservationRevision).join(
                CurrentObservation,
                CurrentObservation.revision_id == ObservationRevision.id,
            )
        )
        assert current is not None
        assert current.payload == {"noise_db": 57}
        assert await session.scalar(select(func.count()).select_from(ObservationRevision)) == 2


async def test_conflict_rolls_back_new_rows_and_checkpoint(engine: AsyncEngine) -> None:
    # Given: one committed value and a new batch containing a valid row then conflicting content.
    factory = session_factory(engine)
    run_id, sha = await prepare(factory)
    async with factory.begin() as session:
        await commit_records(session, BatchCommit(run_id, (record(sha),), WINDOW.window_start, NOW))
    window = SourceWindow("fixture", NOW, NOW + timedelta(days=1))
    async with factory.begin() as session:
        run = await create_run(session, window)
    rows = (
        replace(record(sha), entity_id="new-sensor"),
        replace(record(sha), payload_json='{"noise_db":99}'),
    )
    # When: same provider precedence conflicts inside the atomic transaction.
    with pytest.raises(StorageContractError, match="ambiguous_revision"):
        async with factory.begin() as session:
            await commit_records(
                session, BatchCommit(run.id, rows, window.window_start, window.window_end)
            )
    # Then: neither the new row nor the later cursor is published.
    async with factory() as session:
        checkpoint = await session.get(SourceCheckpoint, WINDOW.source)
        assert checkpoint is not None
        assert checkpoint.covered_until == NOW
        assert await session.scalar(select(func.count()).select_from(ObservationRevision)) == 1


async def test_missing_interval_blocks_checkpoint(engine: AsyncEngine) -> None:
    # Given: a committed window followed by a skipped day.
    factory = session_factory(engine)
    run_id, sha = await prepare(factory)
    async with factory.begin() as session:
        await commit_records(session, BatchCommit(run_id, (record(sha),), WINDOW.window_start, NOW))
    window = SourceWindow("fixture", NOW + timedelta(days=1), NOW + timedelta(days=2))
    async with factory.begin() as session:
        run = await create_run(session, window)
    # When: attempting to jump across the uncovered interval.
    with pytest.raises(StorageContractError, match="coverage_gap"):
        async with factory.begin() as session:
            await commit_records(
                session, BatchCommit(run.id, (), window.window_start, window.window_end)
            )
    # Then: the successful checkpoint remains at the contiguous boundary.
    async with factory() as session:
        checkpoint = await session.get(SourceCheckpoint, WINDOW.source)
        assert checkpoint is not None
        assert checkpoint.covered_until == NOW


@pytest.mark.parametrize("existing_checkpoint", [False, True])
async def test_full_snapshot_never_claims_incremental_window_completion(
    engine: AsyncEngine, existing_checkpoint: bool
) -> None:
    # Given: a full baseline from a later day, optionally following an older delta cursor.
    factory = session_factory(engine)
    if existing_checkpoint:
        async with factory.begin() as session:
            session.add(SourceCheckpoint(source=WINDOW.source, covered_until=NOW))
    start = NOW + timedelta(days=5)
    window = SourceWindow(WINDOW.source, start, start + timedelta(days=1), full_snapshot=True)
    async with factory.begin() as session:
        run = await create_run(session, window)
        sha = await archive_page(session, WINDOW.source, b'{"baseline":"fixture"}')
    # When: importing the complete current baseline.
    async with factory.begin() as session:
        result = await commit_records(
            session, BatchCommit(run.id, (record(sha),), window.window_start, window.window_end)
        )
    # Then: baseline rows are stored without skipping or inventing delta coverage.
    assert result.inserted == 1
    async with factory() as session:
        checkpoint = await session.get(SourceCheckpoint, WINDOW.source)
        if existing_checkpoint:
            assert checkpoint is not None
            assert checkpoint.covered_until == NOW
        else:
            assert checkpoint is None


async def test_parallel_replay_uses_source_lock_to_prevent_duplicates(engine: AsyncEngine) -> None:
    # Given: two independent workers and PostgreSQL connections for the same source window.
    factory = session_factory(engine)
    first, sha = await prepare(factory)
    second, _ = await prepare(factory)
    inserted: list[int] = []

    async def deliver(run_id: str) -> None:
        async with factory.begin() as session:
            result = await commit_records(
                session,
                BatchCommit(run_id, (record(sha),), WINDOW.window_start, NOW),
            )
            inserted.append(result.inserted)

    # When: both runs commit concurrently.
    async with anyio.create_task_group() as group:
        group.start_soon(deliver, first)
        group.start_soon(deliver, second)
    # Then: one insertion and one replay are observed, not two insertions.
    assert sorted(inserted) == [0, 1]


async def test_timezone_representation_does_not_create_a_revision(engine: AsyncEngine) -> None:
    # Given: an existing UTC observation and an equivalent KST representation.
    factory = session_factory(engine)
    first, sha = await prepare(factory)
    original = record(sha)
    async with factory.begin() as session:
        await commit_records(session, BatchCommit(first, (original,), WINDOW.window_start, NOW))
    second, _ = await prepare(factory)
    equivalent = replace(
        original, observed_at=original.observed_at.astimezone(timezone(timedelta(hours=9)))
    )
    # When: replaying the same physical observation in another timezone representation.
    async with factory.begin() as session:
        result = await commit_records(
            session, BatchCommit(second, (equivalent,), WINDOW.window_start, NOW)
        )
    # Then: identity normalization prevents a duplicate revision.
    assert result.inserted == 0


async def test_same_rank_provider_update_selects_newer_revision(engine: AsyncEngine) -> None:
    # Given: one provisional provider version with explicit modification metadata.
    factory = session_factory(engine)
    first, sha = await prepare(factory)
    original = replace(record(sha), source_updated_at=NOW - timedelta(minutes=30))
    async with factory.begin() as session:
        await commit_records(session, BatchCommit(first, (original,), WINDOW.window_start, NOW))
    second, _ = await prepare(factory)
    correction = replace(original, source_updated_at=NOW, payload_json='{"noise_db":58}')
    # When: the same provider rank has a provably newer modification timestamp.
    async with factory.begin() as session:
        await commit_records(session, BatchCommit(second, (correction,), WINDOW.window_start, NOW))
    # Then: current moves to the newer explicit provider version.
    async with factory() as session:
        current = await session.scalar(
            select(ObservationRevision).join(
                CurrentObservation,
                CurrentObservation.revision_id == ObservationRevision.id,
            )
        )
        assert current is not None
        assert current.payload == {"noise_db": 58}
