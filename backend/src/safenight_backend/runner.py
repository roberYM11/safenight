"""Source-wide exclusion, raw-first collection, complete-page commit and failure recording."""

import hashlib
from dataclasses import dataclass, replace
from datetime import datetime
from math import ceil
from typing import Final, Literal, Protocol

import httpx2
from pydantic import ValidationError
from sqlalchemy import Boolean, func, select, text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from safenight_backend.config import Settings
from safenight_backend.db import session_factory
from safenight_backend.http_client import create_client
from safenight_backend.ingestion import cctv, sdot
from safenight_backend.ingestion.contracts import ParsedPage, SafeProviderError, SourceQuery
from safenight_backend.models import SourceRun
from safenight_backend.repository import (
    BatchCommit,
    Record,
    SourceWindow,
    StorageContractError,
    archive_page,
    commit_records,
    create_run,
    mark_failed,
)

type SourceName = Literal["sdot", "cctv"]
MAX_RECORDS: Final = 500000


class ProviderAdapter(Protocol):
    """Interchangeable provider module with the same raw-first contract."""

    async def request_page(self, client: httpx2.AsyncClient, query: SourceQuery) -> bytes:
        """Return bytes without parsing or exposing a credential in diagnostics."""
        ...

    def parse_page(self, body: bytes, query: SourceQuery) -> ParsedPage:
        """Normalize an already archived provider page."""
        ...


ADAPTERS: Final[dict[SourceName, ProviderAdapter]] = {"sdot": sdot, "cctv": cctv}
PAGE_SIZES: Final[dict[SourceName, int]] = {"sdot": 1000, "cctv": 100}


def require(condition: bool, code: str) -> None:
    """Raise an operational contract violation without including provider URLs."""
    if not condition:
        raise SafeProviderError(code)


@dataclass(frozen=True, slots=True)
class CollectionRequest:
    """One day/window; page limits cannot convert partial data into a successful run."""

    source: SourceName
    start: datetime
    end: datetime
    full_snapshot: bool = False


@dataclass(frozen=True, slots=True)
class CollectionOutcome:
    """Safe operational receipt without URLs or keys."""

    run_id: str
    source: str
    status: str
    fetched: int = 0
    inserted: int = 0
    error_code: str | None = None


async def prepare_run(factory: async_sessionmaker[AsyncSession], request: CollectionRequest) -> str:
    """Recover interrupted attempts after acquiring the source lease."""
    async with factory.begin() as session:
        abandoned = await session.scalars(
            select(SourceRun).where(
                SourceRun.source == request.source,
                SourceRun.status == "running",
            )
        )
        for prior in abandoned:
            await mark_failed(session, prior.id, "worker_interrupted")
        run = await create_run(
            session,
            SourceWindow(
                request.source,
                request.start,
                request.end,
                request.full_snapshot,
            ),
        )
        return run.id


async def collect(
    engine: AsyncEngine, settings: Settings, request: CollectionRequest
) -> CollectionOutcome:
    """Exclude concurrent downloads, preserve each raw page and publish complete batches."""
    lock_key = int.from_bytes(
        hashlib.sha256(f"collect:{request.source}".encode()).digest()[:8], signed=True
    )
    factory = session_factory(engine)
    async with engine.connect() as lock_connection:
        locked = await lock_connection.scalar(
            select(
                func.pg_try_advisory_lock(lock_key, type_=Boolean()),
            )
        )
        if not locked:
            return CollectionOutcome("", request.source, "busy")
        try:
            run_id = await prepare_run(factory, request)
            try:
                keys = {"sdot": settings.sdot_api_key, "cctv": settings.cctv_api_key}
                query = SourceQuery(
                    key=keys[request.source].get_secret_value(),
                    window_start=request.start,
                    window_end=request.end,
                    page_size=PAGE_SIZES[request.source],
                    full_snapshot=request.full_snapshot,
                )
                require(bool(query.key), "api_key_missing")
                records: list[Record] = []
                seen_pages: set[str] = set()
                total = 0
                async with create_client() as client:
                    for number in range(1, settings.max_pages + 1):
                        page_query = replace(query, page_no=number)
                        adapter = ADAPTERS[request.source]
                        body = await adapter.request_page(client, page_query)
                        async with factory.begin() as session:
                            raw_sha = await archive_page(session, request.source, body)
                        require(raw_sha not in seen_pages, "repeated_provider_page")
                        seen_pages.add(raw_sha)
                        page = adapter.parse_page(body, page_query)
                        if number == 1:
                            total = page.total_count
                        require(total == page.total_count, "page_total_changed")
                        require(
                            len(records) + len(page.records) <= MAX_RECORDS,
                            "record_budget_exceeded",
                        )
                        records.extend(
                            Record(
                                source=request.source,
                                entity_id=row.entity_id,
                                observed_at=row.observed_at,
                                published_at=row.published_at,
                                revision_rank=row.revision_rank,
                                source_updated_at=row.source_updated_at,
                                payload_json=row.payload_json,
                                raw_sha=raw_sha,
                                lat=row.lat,
                                lon=row.lon,
                            )
                            for row in page.records
                        )
                        if number >= max(1, ceil(total / query.page_size)):
                            break
                    else:
                        require(condition=False, code="page_budget_exceeded")
                require(total == len(records), "page_count_mismatch")
                async with factory.begin() as session:
                    result = await commit_records(
                        session,
                        BatchCommit(
                            run_id,
                            tuple(records),
                            request.start,
                            request.end,
                        ),
                    )
                return CollectionOutcome(
                    run_id, request.source, "success", result.total, result.inserted
                )
            except (SafeProviderError, StorageContractError) as error:
                code = error.code
            except httpx2.HTTPError:
                code = "provider_transport_error"
            except ValidationError:
                code = "provider_schema_error"
            except SQLAlchemyError:
                code = "database_error"
            async with factory.begin() as session:
                await mark_failed(session, run_id, code)
            return CollectionOutcome(run_id, request.source, "failed", error_code=code)
        finally:
            _ = await lock_connection.execute(
                text("SELECT pg_advisory_unlock(:key)"), {"key": lock_key}
            )
