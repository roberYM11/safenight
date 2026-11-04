"""Deterministic wire tests for request-triggered MOIS facility discovery."""

import json
from collections.abc import Awaitable, Callable
from typing import Final

import anyio
import httpx2
import pytest

from safenight_backend import facility_lookup
from safenight_backend.camera_contracts import SearchArea

pytestmark = pytest.mark.anyio
AREA: Final = SearchArea(lat=37.57, lon=126.9, radius_m=1000)
KEY: Final = "fixture-private-key"


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


def wire(
    monkeypatch: pytest.MonkeyPatch,
    handler: Callable[[httpx2.Request], httpx2.Response | Awaitable[httpx2.Response]],
) -> None:
    monkeypatch.setattr(
        facility_lookup,
        "create_client",
        lambda: httpx2.AsyncClient(transport=httpx2.MockTransport(handler)),
    )


def page_body(page: int, total: int, latitude: str | None = "37.57") -> bytes:
    start = (page - 1) * 100
    rows = [
        {
            "OPN_ATMY_GRP_CD": "fixture-authority",
            "MNG_NO": str(index),
            "WGS84_LAT": latitude,
            "WGS84_LOT": "126.9" if latitude is not None else None,
            "CAM_CNTOM": "1",
            "DAT_CRTR_YMD": "2026-11-01",
            "DAT_UPDT_PNT": "2026-11-01 10:00:00",
        }
        for index in range(start, min(start + 100, total))
    ]
    return json.dumps(
        {
            "response": {
                "header": {"resultCode": "0"},
                "body": {
                    "pageNo": page,
                    "numOfRows": 100,
                    "totalCount": total,
                    "items": {"item": rows},
                },
            }
        }
    ).encode()


async def test_two_pages_use_all_spatial_conditions(monkeypatch: pytest.MonkeyPatch) -> None:
    # Given: 101 facilities spanning two bounded pages.
    requests: list[httpx2.Request] = []

    def respond(request: httpx2.Request) -> httpx2.Response:
        requests.append(request)
        return httpx2.Response(200, content=page_body(int(request.url.params["pageNo"]), 101))

    wire(monkeypatch, respond)
    # When: an explicit map request performs discovery.
    result = await facility_lookup.fetch_facilities(AREA, KEY)
    # Then: each page sends the same four coordinate conditions and no update checkpoint.
    assert result.complete
    assert result.error_code is None
    assert len(result.cameras) == 101
    assert result.cameras[-1].camera_id == "fixture-authority:100"
    assert len(requests) == 2
    for request in requests:
        params = request.url.params
        assert params["serviceKey"] == KEY
        assert float(params["cond[WGS84_LAT::GTE]"]) < AREA.lat
        assert float(params["cond[WGS84_LAT::LTE]"]) > AREA.lat
        assert float(params["cond[WGS84_LOT::GTE]"]) < AREA.lon
        assert float(params["cond[WGS84_LOT::LTE]"]) > AREA.lon
        assert not any("DAT_UPDT" in name for name in params)


async def test_missing_key_never_calls_provider(monkeypatch: pytest.MonkeyPatch) -> None:
    def unexpected(request: httpx2.Request) -> httpx2.Response:
        pytest.fail("Provider must not run without a key")

    wire(monkeypatch, unexpected)
    result = await facility_lookup.fetch_facilities(AREA, " ")
    assert result == facility_lookup.FacilityResult(
        (), complete=False, error_code="facility_key_missing"
    )


@pytest.mark.parametrize("total", [0, 1])
async def test_empty_or_missing_coordinates(monkeypatch: pytest.MonkeyPatch, total: int) -> None:
    wire(monkeypatch, lambda request: httpx2.Response(200, content=page_body(1, total, None)))
    result = await facility_lookup.fetch_facilities(AREA, KEY)
    assert result == facility_lookup.FacilityResult((), complete=True, error_code=None)


@pytest.mark.parametrize(
    ("body", "code"),
    [
        (b'{"response":{"header":{"resultCode":"30"}}}', "cctv_provider_rejected"),
        (b"not-json", "cctv_invalid_payload"),
        (page_body(1, 1, "38.0"), "facility_spatial_filter_ignored"),
        (page_body(2, 101), "cctv_invalid_pagination"),
        (
            page_body(1, 1).replace(b'"totalCount": 1', b'"totalCount": 2'),
            "facility_invalid_page_length",
        ),
    ],
)
async def test_provider_failure_never_claims_complete(
    monkeypatch: pytest.MonkeyPatch, body: bytes, code: str
) -> None:
    wire(monkeypatch, lambda request: httpx2.Response(200, content=body))
    result = await facility_lookup.fetch_facilities(AREA, KEY)
    assert result == facility_lookup.FacilityResult((), complete=False, error_code=code)
    assert KEY not in repr(result)


async def test_page_cap_preserves_partial_candidates(monkeypatch: pytest.MonkeyPatch) -> None:
    pages: list[int] = []

    def respond(request: httpx2.Request) -> httpx2.Response:
        page = int(request.url.params["pageNo"])
        pages.append(page)
        return httpx2.Response(200, content=page_body(page, 601))

    wire(monkeypatch, respond)
    result = await facility_lookup.fetch_facilities(AREA, KEY)
    assert pages == [1, 2, 3, 4, 5]
    assert len(result.cameras) == 500
    assert not result.complete
    assert result.error_code == "facility_page_limit"


@pytest.mark.parametrize("duplicate", [False, True])
async def test_inconsistent_pages_rejected(
    monkeypatch: pytest.MonkeyPatch, duplicate: bool
) -> None:
    def respond(request: httpx2.Request) -> httpx2.Response:
        page = int(request.url.params["pageNo"])
        total = 101 if page == 1 or duplicate else 102
        body = page_body(page, total)
        if duplicate and page == 2:
            body = body.replace(b'"MNG_NO": "100"', b'"MNG_NO": "0"')
        return httpx2.Response(200, content=body)

    wire(monkeypatch, respond)
    result = await facility_lookup.fetch_facilities(AREA, KEY)
    code = "facility_duplicate_record" if duplicate else "facility_total_changed"
    assert result == facility_lookup.FacilityResult((), complete=False, error_code=code)


async def test_transport_error_does_not_leak_key(monkeypatch: pytest.MonkeyPatch) -> None:
    def respond(request: httpx2.Request) -> httpx2.Response:
        raise httpx2.ConnectError(str(request.url), request=request)

    wire(monkeypatch, respond)
    result = await facility_lookup.fetch_facilities(AREA, KEY)
    assert result == facility_lookup.FacilityResult(
        (), complete=False, error_code="facility_transport_error"
    )
    assert KEY not in repr(result)


@pytest.mark.parametrize("status", [302, 403, 503])
async def test_http_failures_and_redirects_are_rejected(
    monkeypatch: pytest.MonkeyPatch, status: int
) -> None:
    wire(monkeypatch, lambda request: httpx2.Response(status, content=page_body(1, 0)))
    result = await facility_lookup.fetch_facilities(AREA, KEY)
    assert result == facility_lookup.FacilityResult(
        (), complete=False, error_code="facility_transport_error"
    )


async def test_whole_lookup_deadline(monkeypatch: pytest.MonkeyPatch) -> None:
    async def respond(request: httpx2.Request) -> httpx2.Response:
        await anyio.sleep(1)
        return httpx2.Response(200, content=page_body(1, 0))

    wire(monkeypatch, respond)
    monkeypatch.setattr(facility_lookup, "LOOKUP_SECONDS", 0.01)
    with anyio.fail_after(0.5):
        result = await facility_lookup.fetch_facilities(AREA, KEY)
    assert result == facility_lookup.FacilityResult(
        (), complete=False, error_code="facility_timeout"
    )


async def test_deadline_is_shared_across_pages(monkeypatch: pytest.MonkeyPatch) -> None:
    pages: list[int] = []

    async def respond(request: httpx2.Request) -> httpx2.Response:
        page = int(request.url.params["pageNo"])
        pages.append(page)
        await anyio.sleep(0.03)
        return httpx2.Response(200, content=page_body(page, 101))

    wire(monkeypatch, respond)
    monkeypatch.setattr(facility_lookup, "LOOKUP_SECONDS", 0.05)
    result = await facility_lookup.fetch_facilities(AREA, KEY)
    assert pages == [1, 2]
    assert result == facility_lookup.FacilityResult(
        (), complete=False, error_code="facility_timeout"
    )


@pytest.mark.parametrize("area", [SearchArea(lat=90, lon=0), SearchArea(lat=0, lon=180)])
async def test_unsupported_wrapping_bounds(area: SearchArea) -> None:
    result = await facility_lookup.fetch_facilities(area, KEY)
    assert result == facility_lookup.FacilityResult(
        (), complete=False, error_code="facility_area_unsupported"
    )
