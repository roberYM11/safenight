"""Versioned feature snapshots; unknown facility coverage never becomes zero."""

import hashlib
from collections.abc import Sequence
from datetime import UTC, datetime

from pydantic import JsonValue, TypeAdapter
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from safenight_backend.models import CurrentObservation, FeatureSnapshot, ObservationRevision
from safenight_backend.serving import FeatureVector


async def build_features(session: AsyncSession, row: ObservationRevision) -> FeatureVector:
    """Create traceable environmental features without guessing missing camera support."""
    location = await session.scalar(
        select(ObservationRevision)
        .join(
            CurrentObservation,
            CurrentObservation.revision_id == ObservationRevision.id,
        )
        .where(
            ObservationRevision.source == "sensor_locations",
            ObservationRevision.entity_id == row.entity_id,
            ObservationRevision.observed_at <= row.observed_at,
        )
        .order_by(ObservationRevision.observed_at.desc())
        .limit(1)
    )
    vector = feature_vector(row, location)
    await store_features(session, ((row, vector),))
    return vector


def feature_vector(row: ObservationRevision, location: ObservationRevision | None) -> FeatureVector:
    """Tie the observation and effective location revision to one feature identity."""
    identifier = hashlib.sha256(
        f"{row.id}:{location.id if location else 'unknown'}:environment-v1".encode(),
    ).hexdigest()
    return FeatureVector(
        sensor_id=row.entity_id,
        observed_at=row.observed_at,
        lat=location.lat if location else row.lat,
        lon=location.lon if location else row.lon,
        lux=TypeAdapter(float | None).validate_python(row.payload.get("lux")),
        noise_db=TypeAdapter(float | None).validate_python(row.payload.get("noise_db")),
        cctv_count=None,
        feature_version="environment-v1",
        revision=identifier,
    )


async def store_features(
    session: AsyncSession, items: Sequence[tuple[ObservationRevision, FeatureVector]]
) -> None:
    """Persist a map batch with one insert rather than one round trip per sensor."""
    if not items:
        return
    _ = await session.execute(
        insert(FeatureSnapshot)
        .values(
            [
                {
                    "id": vector.revision,
                    "source_revision_id": row.id,
                    "feature_version": vector.feature_version,
                    "payload": TypeAdapter(dict[str, JsonValue]).validate_json(
                        vector.model_dump_json()
                    ),
                    "created_at": datetime.now(UTC),
                }
                for row, vector in items
            ]
        )
        .on_conflict_do_nothing(index_elements=[FeatureSnapshot.id])
    )


async def build_feature_batch(
    session: AsyncSession, rows: Sequence[ObservationRevision]
) -> tuple[FeatureVector, ...]:
    """Resolve effective locations in bulk using the same feature contract as point queries."""
    if not rows:
        return ()
    locations = await session.scalars(
        select(ObservationRevision)
        .join(CurrentObservation, CurrentObservation.revision_id == ObservationRevision.id)
        .where(
            ObservationRevision.source == "sensor_locations",
            ObservationRevision.entity_id.in_([row.entity_id for row in rows]),
        )
        .order_by(ObservationRevision.observed_at.desc())
    )
    by_sensor: dict[str, list[ObservationRevision]] = {}
    for location in locations:
        by_sensor.setdefault(location.entity_id, []).append(location)
    vectors = tuple(
        feature_vector(
            row,
            next(
                (
                    location
                    for location in by_sensor.get(row.entity_id, ())
                    if location.observed_at <= row.observed_at
                ),
                None,
            ),
        )
        for row in rows
    )
    await store_features(session, tuple(zip(rows, vectors, strict=True)))
    return vectors
