"""Explicit requests discover facilities without claiming live footage or pedestrian counts."""

import httpx
import httpx2
import pytest
from test_pipeline_api import END, START, Environment, cctv_body, install_wire

from safenight_backend.main import create_app
from safenight_backend.runner import CollectionRequest, collect

pytestmark = pytest.mark.anyio
pytest_plugins = ("test_pipeline_api",)


async def test_missing_coverage_is_unknown_and_never_zero_pedestrians(
    environment: Environment,
) -> None:
    # Given: a server with no facility baseline or connected video provider.
    app = create_app(environment.settings)
    # When: the user explicitly requests CCTV discovery for one location.
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://fixture") as client,
    ):
        response = await client.get("/api/cctv/nearby?lat=37.5&lon=127&radius_m=1000")
    # Then: missing coverage and video are explicit, not fabricated empty-person measurements.
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "COVERAGE_UNKNOWN"
    assert data["cameras"] == []
    assert data["video_status"] == "SOURCE_NOT_CONNECTED"
    assert data["current_people"] is None
    assert data["passages_last_minute"] is None


async def test_nearby_facilities_are_distance_sorted_without_claiming_video_access(
    environment: Environment, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Given: a real DB populated through the paginated CCTV fixture adapter.
    install_wire(
        monkeypatch,
        lambda request: httpx2.Response(
            200, content=cctv_body(int(request.url.params.get("pageNo", "1")))
        ),
    )
    await collect(
        environment.engine,
        environment.settings,
        CollectionRequest("cctv", START, END, full_snapshot=True),
    )
    app = create_app(environment.settings)
    # When: requesting the stored facilities near their actual fixture location.
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://fixture") as client,
    ):
        response = await client.get("/api/cctv/nearby?lat=37.5&lon=127&radius_m=1000")
    # Then: at most ten candidates appear with actual distance and no accessible-video claim.
    data = response.json()
    assert data["status"] == "FOUND"
    assert len(data["cameras"]) == 10
    assert all(camera["distance_m"] == 0 for camera in data["cameras"])
    assert all(camera["video_available"] is False for camera in data["cameras"])


async def test_discovery_rejects_unbounded_radius(environment: Environment) -> None:
    # Given: the same read-only API and a request beyond its maximum search radius.
    app = create_app(environment.settings)
    # When: the client attempts an unbounded facility lookup.
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://fixture") as client,
    ):
        response = await client.get("/api/cctv/nearby?lat=37.5&lon=127&radius_m=100000")
    # Then: boundary validation prevents execution of that lookup.
    assert response.status_code == 422
