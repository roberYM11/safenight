"""Request-scoped CCTV discovery; never opens or polls a video stream in the background."""

from datetime import UTC, datetime

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from safenight_backend.camera_contracts import CameraDiscovery, NearbyCamera
from safenight_backend.models import CurrentObservation, ObservationRevision, SourceRun
from safenight_backend.rf.artifact import distance_meters


async def discover_cameras(
    session: AsyncSession, lat: float, lon: float, radius_m: int
) -> CameraDiscovery:
    """Look up nearest stored facilities only when explicitly requested by the user."""
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
        .where(CurrentObservation.source == "cctv")
        .subquery()
    )
    rows = await session.scalars(
        select(ObservationRevision).where(
            ObservationRevision.id.in_(select(ranked.c.revision_id).where(ranked.c.position == 1)),
            ObservationRevision.lat.is_not(None),
            ObservationRevision.lon.is_not(None),
            ObservationRevision.lat.between(lat - radius_m / 110000, lat + radius_m / 110000),
        )
    )
    matches: list[NearbyCamera] = []
    for row in rows:
        if row.lat is None or row.lon is None:
            continue
        distance = distance_meters(lat, lon, row.lat, row.lon)
        if distance <= radius_m:
            matches.append(
                NearbyCamera(
                    camera_id=row.entity_id,
                    lat=row.lat,
                    lon=row.lon,
                    distance_m=round(distance, 1),
                )
            )
    baseline = await session.scalar(
        select(SourceRun.id)
        .where(
            SourceRun.source == "cctv",
            SourceRun.status == "success",
            SourceRun.full_snapshot.is_(True),
        )
        .limit(1)
    )
    return CameraDiscovery(
        searched_at=datetime.now(UTC),
        radius_m=radius_m,
        status="FOUND" if matches else "NO_MATCH" if baseline else "COVERAGE_UNKNOWN",
        cameras=tuple(sorted(matches, key=lambda camera: camera.distance_m)[:10]),
        lookup_scope="stored_facilities",
        video_status="SOURCE_NOT_CONNECTED",
        lookup_complete=baseline is not None,
        message="저장된 CCTV 설치정보입니다.",
    )
