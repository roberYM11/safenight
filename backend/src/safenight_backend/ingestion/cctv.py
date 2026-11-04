"""MOIS CCTV current/update API, preserving unrecognized change codes."""

import json
from http import HTTPStatus
from typing import ClassVar, Final

import httpx2
from pydantic import BaseModel, ConfigDict, Field, JsonValue, TypeAdapter, ValidationError

from safenight_backend.ingestion.contracts import (
    SEOUL,
    ParsedPage,
    ProviderRecord,
    SafeProviderError,
    SourceQuery,
    optional_number,
    provider_time,
)

MAX_PAGE_SIZE: Final = 100


class Header(BaseModel):
    """Application-level success code returned inside a successful HTTP response."""

    result_code: str = Field(alias="resultCode")


class CctvRow(BaseModel):
    """Stable source identity and fields needed for spatial camera quantity."""

    model_config: ClassVar[ConfigDict] = ConfigDict(extra="allow", frozen=True)
    authority: str = Field(alias="OPN_ATMY_GRP_CD", min_length=1)
    management_no: str = Field(alias="MNG_NO", min_length=1)
    latitude: str | None = Field(alias="WGS84_LAT")
    longitude: str | None = Field(alias="WGS84_LOT")
    camera_count: str | None = Field(alias="CAM_CNTOM")
    reference_day: str = Field(alias="DAT_CRTR_YMD")
    updated_at: str = Field(alias="DAT_UPDT_PNT")


class Items(BaseModel):
    """A nullable items container is accepted only for declared total zero."""

    rows: tuple[CctvRow, ...] = Field(alias="item", default=())


class Body(BaseModel):
    """Pagination metadata is checked against the actual requested page."""

    items: Items | None = None
    total_count: int = Field(alias="totalCount", ge=0)
    page_no: int = Field(alias="pageNo", ge=1)
    page_size: int = Field(alias="numOfRows", ge=1, le=100)


class Response(BaseModel):
    """Provider header plus optional body when authentication failed."""

    header: Header
    body: Body | None = None


class Envelope(BaseModel):
    """Outer MOIS response envelope."""

    response: Response


async def request_page(client: httpx2.AsyncClient, query: SourceQuery) -> bytes:
    """Fetch one current or incremental page without logging secret query parameters."""
    if query.page_size > MAX_PAGE_SIZE:
        msg = "cctv_page_size_exceeded"
        raise SafeProviderError(msg)
    params = {
        "serviceKey": query.key,
        "pageNo": str(query.page_no),
        "numOfRows": str(query.page_size),
        "returnType": "JSON",
    }
    if not query.full_snapshot:
        params["cond[DAT_UPDT_PNT::GTE]"] = query.window_start.astimezone(SEOUL).strftime(
            "%Y%m%d%H%M%S"
        )
        params["cond[DAT_UPDT_PNT::LT]"] = query.window_end.astimezone(SEOUL).strftime(
            "%Y%m%d%H%M%S"
        )
    try:
        response = await client.get("https://apis.data.go.kr/1741000/cctv_info/info", params=params)
    except httpx2.HTTPError:
        msg = "cctv_transport_error"
        raise SafeProviderError(msg) from None
    if response.status_code != HTTPStatus.OK:
        msg = f"cctv_http_{response.status_code}"
        raise SafeProviderError(msg)
    return response.content


def parse_page(body: bytes, query: SourceQuery) -> ParsedPage:
    """Normalize camera quantity and WGS84 coordinates; do not guess deletion codes."""
    try:
        envelope = Envelope.model_validate_json(body)
    except ValidationError:
        msg = "cctv_invalid_payload"
        raise SafeProviderError(msg) from None
    response = envelope.response
    if response.header.result_code != "0" or response.body is None:
        msg = "cctv_provider_rejected"
        raise SafeProviderError(msg)
    page = response.body
    if page.page_no != query.page_no or page.page_size != query.page_size:
        msg = "cctv_invalid_pagination"
        raise SafeProviderError(msg)
    rows = page.items.rows if page.items is not None else ()
    if len(rows) > query.page_size or (page.total_count == 0 and rows):
        msg = "cctv_invalid_pagination"
        raise SafeProviderError(msg)
    if page.total_count > 0 and page.items is None:
        msg = "cctv_invalid_pagination"
        raise SafeProviderError(msg)
    records: list[ProviderRecord] = []
    adapter = TypeAdapter(dict[str, JsonValue])
    for row in rows:
        count = optional_number(row.camera_count, 100000)
        if count is not None and not count.is_integer():
            msg = "cctv_invalid_camera_count"
            raise SafeProviderError(msg)
        lat = optional_number(row.latitude, 90)
        lon = optional_number(row.longitude, 180)
        if (lat is None) != (lon is None):
            msg = "cctv_incomplete_coordinates"
            raise SafeProviderError(msg)
        payload = adapter.validate_json(row.model_dump_json(by_alias=True))
        payload["camera_count"] = int(count) if count is not None else None
        updated = provider_time(row.updated_at)
        if not query.full_snapshot and not query.window_start <= updated < query.window_end:
            msg = "cctv_row_outside_update_window"
            raise SafeProviderError(msg)
        records.append(
            ProviderRecord(
                entity_id=f"{row.authority}:{row.management_no}",
                observed_at=provider_time(row.reference_day),
                published_at=updated,
                revision_rank=1,
                source_updated_at=updated,
                payload_json=json.dumps(payload, sort_keys=True, ensure_ascii=False),
                lat=lat,
                lon=lon,
            )
        )
    return ParsedPage(tuple(records), page.total_count, query.page_no, query.page_size)
