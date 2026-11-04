"""Atomic source commits with immutable revisions and explicit precedence."""

import hashlib
import json
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import StrEnum
from typing import Final
from uuid import uuid4

from pydantic import JsonValue, TypeAdapter
from sqlalchemy import text
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from safenight_backend.models import (
    CurrentObservation,
    ObservationRevision,
    RawObject,
    SourceCheckpoint,
    SourceRun,
)

PAYLOAD: Final = TypeAdapter(dict[str, JsonValue])


class StorageErrorCode(StrEnum):
    """Machine-readable storage invariant violations."""

    TIMEZONE_REQUIRED = "timezone_required"
    INVALID_WINDOW = "invalid_window"
    AMBIGUOUS_REVISION = "ambiguous_revision"
    RUN_NOT_RUNNING = "run_not_running"
    RUN_WINDOW_MISMATCH = "run_window_mismatch"
    COVERAGE_GAP = "coverage_gap"
    RECORD_OUTSIDE_SOURCE_WINDOW = "record_outside_source_window"
    CURRENT_REVISION_MISSING = "current_revision_missing"


class StorageContractError(ValueError):
    """A batch violates a source identity, chronology or revision invariant."""

    def __init__(self, code: StorageErrorCode) -> None:
        """Expose a stable code without including provider data or credentials."""
        self.code: StorageErrorCode = code
        super().__init__(code.value)


@dataclass(frozen=True, slots=True)
class SourceWindow:
    """One query interval; the adapter has verified its complete page set."""

    source: str
    window_start: datetime
    window_end: datetime
    full_snapshot: bool = False


@dataclass(frozen=True, slots=True)
class Record:
    """Parsed observation revision; absent coordinates remain unknown."""

    source: str
    entity_id: str
    observed_at: datetime
    published_at: datetime
    revision_rank: int
    source_updated_at: datetime | None
    payload_json: str
    raw_sha: str
    lat: float | None = None
    lon: float | None = None


@dataclass(frozen=True, slots=True)
class BatchCommit:
    """All validated pages of a run committed with its source checkpoint."""

    run_id: str
    records: tuple[Record, ...]
    covered_from: datetime
    covered_until: datetime


@dataclass(frozen=True, slots=True)
class CommitResult:
    """New revision count is separate from downloaded row volume."""

    inserted: int
    total: int


async def create_run(session: AsyncSession, window: SourceWindow) -> SourceRun:
    """Persist a new attempt without owning or committing the caller's transaction."""
    if window.window_start.tzinfo is None or window.window_end.tzinfo is None:
        raise StorageContractError(StorageErrorCode.TIMEZONE_REQUIRED)
    if window.window_start >= window.window_end:
        raise StorageContractError(StorageErrorCode.INVALID_WINDOW)
    run = SourceRun(
        id=str(uuid4()),
        source=window.source,
        window_start=window.window_start,
        window_end=window.window_end,
        full_snapshot=window.full_snapshot,
        status="running",
        started_at=datetime.now(UTC),
        finished_at=None,
        fetched_rows=0,
        inserted_rows=0,
        error_code=None,
    )
    session.add(run)
    await session.flush()
    return run


async def archive_page(session: AsyncSession, source: str, body: bytes) -> str:
    """Archive provider bytes; caller commits this before normalization begins."""
    digest = hashlib.sha256(body).hexdigest()
    _ = await session.execute(
        insert(RawObject)
        .values(sha256=digest, source=source, body=body, created_at=datetime.now(UTC))
        .on_conflict_do_nothing(index_elements=[RawObject.sha256]),
    )
    return digest


def prefer_revision(candidate: ObservationRevision, current: ObservationRevision) -> bool:
    """Use provider precedence; ambiguous same-rank changes require investigation."""
    if candidate.revision_rank != current.revision_rank:
        return candidate.revision_rank > current.revision_rank
    newer, older = candidate.source_updated_at, current.source_updated_at
    if newer is not None and older is not None and newer != older:
        return newer > older
    if (candidate.payload, candidate.lat, candidate.lon) != (
        current.payload,
        current.lat,
        current.lon,
    ):
        raise StorageContractError(StorageErrorCode.AMBIGUOUS_REVISION)
    return False


async def select_current(session: AsyncSession, candidate: ObservationRevision) -> None:
    """Move one current pointer using the source lock held by the batch caller."""
    key = (candidate.source, candidate.entity_id, candidate.observed_at)
    pointer = await session.get(CurrentObservation, key)
    if pointer is None:
        session.add(
            CurrentObservation(
                source=candidate.source,
                entity_id=candidate.entity_id,
                observed_at=candidate.observed_at,
                revision_id=candidate.id,
            )
        )
        return
    current = await session.get(ObservationRevision, pointer.revision_id)
    if current is None:
        raise StorageContractError(StorageErrorCode.CURRENT_REVISION_MISSING)
    if prefer_revision(candidate, current):
        pointer.revision_id = candidate.id


def advance_checkpoint(
    session: AsyncSession,
    run: SourceRun,
    checkpoint: SourceCheckpoint | None,
    until: datetime,
) -> None:
    """Only complete incremental queries can advance contiguous delta coverage."""
    if run.full_snapshot:
        return
    if checkpoint is None:
        session.add(SourceCheckpoint(source=run.source, covered_until=until))
    else:
        checkpoint.covered_until = max(checkpoint.covered_until, until)


async def commit_records(session: AsyncSession, batch: BatchCommit) -> CommitResult:
    """Merge revisions and finish a run atomically inside the caller's transaction."""
    run = await session.get(SourceRun, batch.run_id, with_for_update=True)
    if run is None or run.status != "running":
        raise StorageContractError(StorageErrorCode.RUN_NOT_RUNNING)
    lock_key = int.from_bytes(hashlib.sha256(run.source.encode()).digest()[:8], signed=True)
    _ = await session.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": lock_key})
    if batch.covered_from.tzinfo is None or batch.covered_until.tzinfo is None:
        raise StorageContractError(StorageErrorCode.TIMEZONE_REQUIRED)
    if batch.covered_from != run.window_start or batch.covered_until != run.window_end:
        raise StorageContractError(StorageErrorCode.RUN_WINDOW_MISMATCH)
    checkpoint = await session.get(SourceCheckpoint, run.source)
    if (
        checkpoint is not None
        and batch.covered_from > checkpoint.covered_until
        and not run.full_snapshot
    ):
        raise StorageContractError(StorageErrorCode.COVERAGE_GAP)
    inserted = 0
    for record in batch.records:
        times = (record.observed_at, record.published_at)
        if any(value.tzinfo is None for value in times):
            raise StorageContractError(StorageErrorCode.TIMEZONE_REQUIRED)
        if record.source_updated_at is not None and record.source_updated_at.tzinfo is None:
            raise StorageContractError(StorageErrorCode.TIMEZONE_REQUIRED)
        if record.source != run.source or record.observed_at >= batch.covered_until:
            raise StorageContractError(StorageErrorCode.RECORD_OUTSIDE_SOURCE_WINDOW)
        payload = PAYLOAD.validate_json(record.payload_json)
        canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        updated = record.source_updated_at.astimezone(UTC) if record.source_updated_at else None
        identity = json.dumps(
            (
                record.source,
                record.entity_id,
                record.observed_at.astimezone(UTC).isoformat(),
                record.revision_rank,
                updated.isoformat() if updated else None,
                canonical,
                record.lat,
                record.lon,
            )
        )
        revision_id = hashlib.sha256(identity.encode()).hexdigest()
        candidate = ObservationRevision(
            id=revision_id,
            source=record.source,
            entity_id=record.entity_id,
            observed_at=record.observed_at,
            published_at=record.published_at,
            revision_rank=record.revision_rank,
            source_updated_at=updated,
            payload=payload,
            raw_sha=record.raw_sha,
            ingested_at=datetime.now(UTC),
            lat=record.lat,
            lon=record.lon,
        )
        result = await session.execute(
            insert(ObservationRevision)
            .values(
                id=candidate.id,
                source=candidate.source,
                entity_id=candidate.entity_id,
                observed_at=candidate.observed_at,
                published_at=candidate.published_at,
                revision_rank=candidate.revision_rank,
                source_updated_at=candidate.source_updated_at,
                payload=candidate.payload,
                raw_sha=candidate.raw_sha,
                ingested_at=candidate.ingested_at,
                lat=candidate.lat,
                lon=candidate.lon,
            )
            .on_conflict_do_nothing(index_elements=[ObservationRevision.id])
            .returning(ObservationRevision.id)
        )
        inserted += int(result.scalar_one_or_none() is not None)
        await select_current(session, candidate)
        await session.flush()
    advance_checkpoint(session, run, checkpoint, batch.covered_until)
    run.status = "success"
    run.finished_at = datetime.now(UTC)
    run.fetched_rows, run.inserted_rows, run.error_code = len(batch.records), inserted, None
    await session.flush()
    return CommitResult(inserted, len(batch.records))


async def mark_failed(session: AsyncSession, run_id: str, error_code: str) -> None:
    """Mark a rolled-back attempt failed in a separate transaction."""
    run = await session.get(SourceRun, run_id, with_for_update=True)
    if run is None or run.status != "running":
        raise StorageContractError(StorageErrorCode.RUN_NOT_RUNNING)
    run.status, run.finished_at, run.error_code = "failed", datetime.now(UTC), error_code[:80]
    await session.flush()
