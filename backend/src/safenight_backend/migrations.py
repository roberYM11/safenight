"""Idempotent version-one schema bootstrap, serialized across processes."""

from datetime import UTC, datetime

from sqlalchemy import text
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncEngine

from safenight_backend.models import Base, SchemaVersion


async def initialize(engine: AsyncEngine) -> None:
    """Apply the initial schema under a PostgreSQL transaction advisory lock."""
    async with engine.begin() as connection:
        _ = await connection.execute(text("SELECT pg_advisory_xact_lock(739150330001)"))
        await connection.run_sync(Base.metadata.create_all)
        _ = await connection.execute(
            insert(SchemaVersion)
            .values(version=1, applied_at=datetime.now(UTC))
            .on_conflict_do_nothing(index_elements=[SchemaVersion.version]),
        )
