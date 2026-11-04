"""Request-scoped remote facility lookup and approved video configuration."""

import json
from pathlib import Path

import httpx
import pytest
from pydantic import ValidationError
from test_pipeline_api import Environment

from safenight_backend import camera_discovery
from safenight_backend.camera_contracts import ApprovedVideo, SearchArea
from safenight_backend.facility_lookup import FacilityCandidate, FacilityResult
from safenight_backend.main import create_app

pytestmark = pytest.mark.anyio
pytest_plugins = ("test_pipeline_api",)


async def test_explicit_lookup_uses_provider_without_requiring_a_stored_baseline(
    environment: Environment, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Given: an empty DB, enabled provider and a validated provider transport boundary.
    calls: list[SearchArea] = []

    async def provider(area: SearchArea, key: str) -> FacilityResult:
        calls.append(area)
        return FacilityResult(
            cameras=(FacilityCandidate("fixture-camera", area.lat, area.lon, "공공 CCTV"),),
            complete=True,
            error_code=None,
        )

    monkeypatch.setattr(camera_discovery, "fetch_facilities", provider)
    settings = environment.settings.model_copy(update={"nearby_provider_enabled": True})
    app = create_app(settings)
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://fixture") as client,
    ):
        await client.get("/api/health/ready")
        assert calls == []
        # When: the user explicitly searches this location.
        response = await client.get("/api/cctv/nearby?lat=37.5&lon=127&radius_m=1000")
    # Then: fresh candidates are returned even though the DB has no CCTV baseline.
    assert len(calls) == 1
    data = response.json()
    assert data["status"] == "FOUND"
    assert data["lookup_scope"] == "provider"
    assert data["lookup_complete"] is True
    assert data["cameras"][0]["distance_m"] == 0
    assert data["cameras"][0]["video_available"] is False


async def test_configured_video_is_discovered_without_loading_a_stream(
    environment: Environment, tmp_path: Path
) -> None:
    # Given: an operator-approved fixture URL, not a production nearby-video claim.
    catalog = tmp_path / "videos.json"
    catalog.write_text(
        json.dumps(
            [
                {
                    "camera_id": "fixture-video",
                    "name": "영상 fixture",
                    "lat": 37.5,
                    "lon": 127,
                    "playback_url": "https://video.example.org/fixture.mp4",
                    "playback_type": "mp4",
                    "source_url": "https://video.example.org/about",
                }
            ]
        )
    )
    settings = environment.settings.model_copy(update={"video_catalog_file": catalog})
    app = create_app(settings)
    # When: discovering candidates, without any media request or background worker.
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://fixture") as client,
    ):
        response = await client.get("/api/cctv/nearby?lat=37.5&lon=127")
    # Then: only the nearby approved candidate is available for explicit playback.
    data = response.json()
    assert data["video_status"] == "AVAILABLE"
    assert data["cameras"][0]["playback_type"] == "mp4"
    assert data["current_people"] is None


@pytest.mark.parametrize(
    "url",
    [
        "http://video.example.org/a",
        "https://127.0.0.1/a",
        "https://camera.local/a",
        "https://user:secret@video.example.org/a",
    ],
)
async def test_catalog_rejects_private_or_credential_bearing_playback(url: str) -> None:
    # Given: an operator file containing an unsafe playback location.
    # When: parsing that URL at the configuration boundary.
    with pytest.raises(ValidationError):
        ApprovedVideo(
            camera_id="fixture",
            name="fixture",
            lat=37.5,
            lon=127,
            playback_url=url,
            playback_type="mp4",
            source_url="https://video.example.org/about",
        )
    # Then: the location cannot reach the public browser response.
