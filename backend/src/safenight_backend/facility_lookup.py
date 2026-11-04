"""Bounded, read-only MOIS facility discovery for an explicit map request."""

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from math import cos, radians
from typing import Final

import anyio
import httpx2

from safenight_backend.camera_contracts import SearchArea
from safenight_backend.http_client import create_client
from safenight_backend.ingestion.cctv import MAX_PAGE_SIZE, parse_page
from safenight_backend.ingestion.contracts import ParsedPage, SafeProviderError, SourceQuery

MAX_PAGES: Final = 5
LOOKUP_SECONDS: Final = 8.0
METERS_PER_DEGREE: Final = 110000
MAX_LATITUDE: Final = 90
MAX_LONGITUDE: Final = 180


@dataclass(frozen=True, slots=True)
class FacilityCandidate:
    """A provider facility position; no video access is implied."""

    camera_id: str
    lat: float
    lon: float
    name: str


@dataclass(frozen=True, slots=True)
class FacilityResult:
    """Verified candidates and explicit pagination or provider limitations."""

    cameras: tuple[FacilityCandidate, ...]
    complete: bool
    error_code: str | None


@dataclass(frozen=True, slots=True)
class Bounds:
    """Conservative non-wrapping latitude and longitude rectangle."""

    south: float
    north: float
    west: float
    east: float


def search_bounds(area: SearchArea) -> Bounds:
    """Cover the radius; reject polar or wrapping areas unsupported by this query."""
    latitude_delta = area.radius_m / METERS_PER_DEGREE
    outer_latitude = abs(area.lat) + latitude_delta
    if outer_latitude >= MAX_LATITUDE:
        msg = "facility_area_unsupported"
        raise SafeProviderError(msg)
    longitude_delta = latitude_delta / cos(radians(outer_latitude))
    if abs(area.lon) + longitude_delta >= MAX_LONGITUDE:
        msg = "facility_area_unsupported"
        raise SafeProviderError(msg)
    return Bounds(
        area.lat - latitude_delta,
        area.lat + latitude_delta,
        area.lon - longitude_delta,
        area.lon + longitude_delta,
    )


async def request_page(
    client: httpx2.AsyncClient, query: SourceQuery, bounds: Bounds
) -> ParsedPage:
    """Request all four coordinate conditions without using ingestion checkpoints."""
    response = await client.get(
        "https://apis.data.go.kr/1741000/cctv_info/info",
        params={
            "serviceKey": query.key,
            "pageNo": str(query.page_no),
            "numOfRows": str(query.page_size),
            "returnType": "JSON",
            "cond[WGS84_LAT::GTE]": str(bounds.south),
            "cond[WGS84_LAT::LTE]": str(bounds.north),
            "cond[WGS84_LOT::GTE]": str(bounds.west),
            "cond[WGS84_LOT::LTE]": str(bounds.east),
        },
    )
    _ = response.raise_for_status()
    page = parse_page(response.content, query)
    expected_rows = min(
        query.page_size, max(0, page.total_count - (query.page_no - 1) * query.page_size)
    )
    if len(page.records) != expected_rows:
        msg = "facility_invalid_page_length"
        raise SafeProviderError(msg)
    return page


def candidates(page: ParsedPage, bounds: Bounds) -> tuple[FacilityCandidate, ...]:
    """Reject ignored spatial filters; omit records without usable coordinates."""
    result: list[FacilityCandidate] = []
    for row in page.records:
        if row.lat is None or row.lon is None:
            continue
        if not bounds.south <= row.lat <= bounds.north or not bounds.west <= row.lon <= bounds.east:
            msg = "facility_spatial_filter_ignored"
            raise SafeProviderError(msg)
        result.append(FacilityCandidate(row.entity_id, row.lat, row.lon, "공공 CCTV"))
    return tuple(result)


async def collect_pages(area: SearchArea, key: str) -> FacilityResult:
    """Read at most five consistent pages; preserve partial coverage at the row cap."""
    bounds = search_bounds(area)
    now = datetime.now(UTC)
    total: int | None = None
    seen: set[str] = set()
    result: list[FacilityCandidate] = []
    async with create_client() as client:
        for page_no in range(1, MAX_PAGES + 1):
            query = SourceQuery(
                key, now, now + timedelta(seconds=1), page_no, MAX_PAGE_SIZE, full_snapshot=True
            )
            page = await request_page(client, query, bounds)
            if total is not None and page.total_count != total:
                msg = "facility_total_changed"
                raise SafeProviderError(msg)
            total = page.total_count
            for row in page.records:
                if row.entity_id in seen:
                    msg = "facility_duplicate_record"
                    raise SafeProviderError(msg)
                seen.add(row.entity_id)
            result.extend(candidates(page, bounds))
            if page_no * MAX_PAGE_SIZE >= total:
                return FacilityResult(tuple(result), complete=True, error_code=None)
    return FacilityResult(tuple(result), complete=False, error_code="facility_page_limit")


async def fetch_facilities(area: SearchArea, key: str) -> FacilityResult:
    """Limit the whole lookup to eight seconds and return credential-safe errors."""
    if not key.strip():
        return FacilityResult((), complete=False, error_code="facility_key_missing")
    try:
        with anyio.fail_after(LOOKUP_SECONDS):
            try:
                return await collect_pages(area, key)
            except SafeProviderError as error:
                return FacilityResult((), complete=False, error_code=error.code)
    except (TimeoutError, httpx2.TimeoutException):
        return FacilityResult((), complete=False, error_code="facility_timeout")
    except httpx2.HTTPError:
        return FacilityResult((), complete=False, error_code="facility_transport_error")
