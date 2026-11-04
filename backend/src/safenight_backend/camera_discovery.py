"""On-demand facility lookup with explicitly approved video sources."""

from datetime import UTC, datetime

from pydantic import ValidationError
from sqlalchemy.ext.asyncio import AsyncSession

from safenight_backend.camera_contracts import CameraDiscovery, NearbyCamera, SearchArea
from safenight_backend.config import Settings
from safenight_backend.facility_lookup import fetch_facilities
from safenight_backend.nearby_cctv import discover_cameras
from safenight_backend.rf.artifact import distance_meters
from safenight_backend.video_catalog import nearby_videos


async def discover_nearby(
    session: AsyncSession, area: SearchArea, settings: Settings
) -> CameraDiscovery:
    """Query providers only during this request; never prefetch or start a stream."""
    stored = await discover_cameras(session, area.lat, area.lon, area.radius_m)
    cameras = {row.camera_id: row for row in stored.cameras}
    errors: list[str] = []
    complete = stored.lookup_complete
    provider = settings.nearby_provider_enabled and bool(settings.cctv_api_key.get_secret_value())
    if provider:
        result = await fetch_facilities(area, settings.cctv_api_key.get_secret_value())
        complete = result.complete
        if result.error_code:
            errors.append(result.error_code)
        for row in result.cameras:
            distance = distance_meters(area.lat, area.lon, row.lat, row.lon)
            if distance <= area.radius_m:
                cameras[row.camera_id] = NearbyCamera(
                    camera_id=row.camera_id,
                    name=row.name,
                    lat=row.lat,
                    lon=row.lon,
                    distance_m=round(distance, 1),
                    source_url="https://www.data.go.kr/data/15155042/openapi.do",
                )
    try:
        videos = await nearby_videos(settings.video_catalog_file, area)
    except (OSError, ValidationError):
        errors.append("video_catalog_invalid")
        videos = ()
    cameras.update((row.camera_id, row) for row in videos)
    selected = tuple(
        sorted(cameras.values(), key=lambda row: (not row.video_available, row.distance_m))[:10]
    )
    has_video = any(row.video_available for row in selected)
    message = (
        "승인된 영상이 연결되어 있습니다. 영상을 선택한 뒤 재생할 수 있습니다."
        if has_video
        else "영상은 별도 승인된 소스 연결 후 재생할 수 있습니다."
    )
    if not complete:
        message += " 시설 검색 범위가 완전하지 않을 수 있습니다."
    if errors:
        message += " 일부 제공처를 조회하지 못했습니다."
    return CameraDiscovery(
        searched_at=datetime.now(UTC),
        radius_m=area.radius_m,
        status="FOUND"
        if selected
        else "PROVIDER_ERROR"
        if errors
        else "NO_MATCH"
        if complete
        else stored.status,
        lookup_scope="mixed"
        if provider and stored.cameras
        else "provider"
        if provider
        else "stored_facilities",
        cameras=selected,
        video_status="AVAILABLE" if has_video else "SOURCE_NOT_CONNECTED",
        lookup_complete=complete,
        provider_errors=tuple(errors),
        message=message,
    )
