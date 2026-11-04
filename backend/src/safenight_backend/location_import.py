"""Versioned official sensor-location snapshots without another API key."""

import json
from datetime import UTC, datetime, timedelta

from sqlalchemy.ext.asyncio import AsyncEngine

from safenight_backend.db import session_factory
from safenight_backend.ingestion.locations import parse_locations
from safenight_backend.repository import (
    BatchCommit,
    Record,
    SourceWindow,
    archive_page,
    commit_records,
    create_run,
)


async def import_locations(engine: AsyncEngine, body: bytes, effective: datetime) -> int:
    """Keep original XLSX bytes and the explicit provider snapshot date in PostgreSQL."""
    locations = parse_locations(body)
    factory = session_factory(engine)
    source = "sensor_locations"
    end = effective + timedelta(days=1)
    async with factory.begin() as session:
        digest = await archive_page(session, source, body)
        run = await create_run(session, SourceWindow(source, effective, end, full_snapshot=True))
        run_id = run.id
    received = datetime.now(UTC)
    records = tuple(
        Record(
            source=source,
            entity_id=point.sensor_id,
            observed_at=effective,
            published_at=received,
            revision_rank=1,
            source_updated_at=None,
            payload_json=json.dumps(
                {"sensor_id": point.sensor_id, "lat": point.lat, "lon": point.lon}
            ),
            raw_sha=digest,
            lat=point.lat,
            lon=point.lon,
        )
        for point in locations
    )
    async with factory.begin() as session:
        result = await commit_records(session, BatchCommit(run_id, records, effective, end))
    return result.inserted
