"""Approved video configuration, loaded only when the user requests nearby cameras."""

from pathlib import Path
from typing import Final

import anyio
from pydantic import TypeAdapter

from safenight_backend.camera_contracts import ApprovedVideo, NearbyCamera, SearchArea
from safenight_backend.rf.artifact import distance_meters

VIDEOS: Final = TypeAdapter(tuple[ApprovedVideo, ...])


def load_catalog(path: Path, area: SearchArea) -> tuple[NearbyCamera, ...]:
    """Validate a trusted operator file without fetching, proxying or storing any video."""
    rows = VIDEOS.validate_json(path.read_bytes())
    result: list[NearbyCamera] = []
    for row in rows:
        distance = distance_meters(area.lat, area.lon, row.lat, row.lon)
        if distance <= area.radius_m:
            result.append(
                NearbyCamera(
                    camera_id=f"video:{row.camera_id}",
                    name=row.name,
                    lat=row.lat,
                    lon=row.lon,
                    distance_m=round(distance, 1),
                    video_available=True,
                    playback_url=row.playback_url,
                    playback_type=row.playback_type,
                    source_url=row.source_url,
                )
            )
    return tuple(result)


async def nearby_videos(path: Path | None, area: SearchArea) -> tuple[NearbyCamera, ...]:
    """Keep operator file I/O outside the request event loop."""
    return await anyio.to_thread.run_sync(load_catalog, path, area) if path else ()
