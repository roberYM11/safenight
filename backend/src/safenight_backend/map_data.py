"""Latest-per-sensor map query with batched feature persistence and off-loop inference."""

from datetime import UTC, datetime

import anyio
from pydantic import TypeAdapter
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from safenight_backend.features import build_feature_batch
from safenight_backend.map_schemas import MapResponse, MapSensor
from safenight_backend.models import CurrentObservation, ObservationRevision
from safenight_backend.serving import FeatureVector
from safenight_backend.serving.runtime import RuntimeAdapter


def assess_map(
    runtime: RuntimeAdapter,
    rows: tuple[ObservationRevision, ...],
    vectors: tuple[FeatureVector, ...],
    now: datetime,
) -> tuple[MapSensor, ...]:
    """Run the complete inference batch in one worker thread."""
    result: list[MapSensor] = []
    for row, vector in zip(rows, vectors, strict=True):
        if vector.lat is None or vector.lon is None:
            continue
        assessment = runtime.assess(vector, now)
        result.append(
            MapSensor(
                sensor_id=vector.sensor_id,
                lat=vector.lat,
                lon=vector.lon,
                district=TypeAdapter(str).validate_python(
                    row.payload.get("AUTONOMOUS_DISTRICT", "")
                ),
                neighborhood=TypeAdapter(str).validate_python(
                    row.payload.get("ADMINISTRATIVE_DISTRICT", "")
                ),
                observed_at=vector.observed_at,
                lux=vector.lux,
                noise_db=vector.noise_db,
                score=assessment.score,
                status=assessment.status,
                feature_revision=vector.revision,
            )
        )
    return tuple(result)


async def read_map(session: AsyncSession, runtime: RuntimeAdapter) -> MapResponse:
    """Return one latest observation per sensor, retaining unknown scores."""
    ranked = (
        select(
            CurrentObservation.revision_id,
            func.row_number()
            .over(
                partition_by=CurrentObservation.entity_id,
                order_by=CurrentObservation.observed_at.desc(),
            )
            .label("position"),
        )
        .where(CurrentObservation.source == "sdot")
        .subquery()
    )
    rows = tuple(
        await session.scalars(
            select(ObservationRevision)
            .where(
                ObservationRevision.id.in_(
                    select(ranked.c.revision_id).where(ranked.c.position == 1)
                )
            )
            .order_by(ObservationRevision.entity_id)
        )
    )
    vectors = await build_feature_batch(session, rows)
    now = datetime.now(UTC)
    sensors = await anyio.to_thread.run_sync(assess_map, runtime, rows, vectors, now)
    return MapResponse(
        generated_at=now,
        model=runtime.info,
        sensors=sensors,
        total_sensors=len(rows),
        unlocated_sensors=len(rows) - len(sensors),
    )
