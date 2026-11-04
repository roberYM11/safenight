"""Seoul S-DoT environment API with separately archivable response bytes."""

import json
from datetime import timedelta
from http import HTTPStatus
from typing import ClassVar, Literal

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


class Result(BaseModel):
    """Provider application status is independent of HTTP success."""

    code: str = Field(alias="CODE")


class SdotRow(BaseModel):
    """Required sensor fields, preserving all additional environmental fields."""

    model_config: ClassVar[ConfigDict] = ConfigDict(extra="allow", frozen=True)
    serial: str = Field(alias="SERIAL", min_length=1)
    sensing_time: str = Field(alias="SENSING_TIME")
    date: str = Field(alias="DATE")
    data_no: Literal["1", "2"] = Field(alias="DATA_NO")
    lux: str | None = Field(alias="AVG_INTE_ILLU")
    noise: str | None = Field(alias="AVG_NOISE")


class Data(BaseModel):
    """The source's declared total and current page."""

    total: int = Field(alias="list_total_count", ge=0)
    result: Result = Field(alias="RESULT")
    rows: tuple[SdotRow, ...] = Field(alias="row", default=())


class Envelope(BaseModel):
    """Both the normal and documented no-data/error envelopes."""

    data: Data | None = Field(alias="sDoTEnv", default=None)
    result: Result | None = Field(alias="RESULT", default=None)


async def request_page(client: httpx2.AsyncClient, query: SourceQuery) -> bytes:
    """Fetch one day; callers must archive bytes before parse_page is called."""
    start = (query.page_no - 1) * query.page_size + 1
    end = start + query.page_size - 1
    first_day = query.window_start.astimezone(SEOUL).date()
    if query.window_end.astimezone(SEOUL).date().toordinal() - first_day.toordinal() != 1:
        msg = "sdot_requires_one_day"
        raise SafeProviderError(msg)
    url = f"http://openapi.seoul.go.kr:8088/{query.key}/json/sDoTEnv/{start}/{end}/{first_day}"
    try:
        response = await client.get(url)
    except httpx2.HTTPError:
        msg = "sdot_transport_error"
        raise SafeProviderError(msg) from None
    if response.status_code != HTTPStatus.OK:
        msg = f"sdot_http_{response.status_code}"
        raise SafeProviderError(msg)
    return response.content


def parse_page(body: bytes, query: SourceQuery) -> ParsedPage:
    """Parse values in lux/dB; no sensor coordinates are invented."""
    try:
        envelope = Envelope.model_validate_json(body)
    except ValidationError:
        msg = "sdot_invalid_payload"
        raise SafeProviderError(msg) from None
    data = envelope.data
    if data is None:
        if envelope.result is not None and envelope.result.code == "INFO-200":
            return ParsedPage((), 0, query.page_no, query.page_size)
        msg = "sdot_provider_rejected"
        raise SafeProviderError(msg)
    if data.result.code not in {"INFO-000", "INFO-200"}:
        msg = "sdot_provider_rejected"
        raise SafeProviderError(msg)
    if len(data.rows) > query.page_size or (data.total == 0 and data.rows):
        msg = "sdot_invalid_pagination"
        raise SafeProviderError(msg)
    records: list[ProviderRecord] = []
    adapter = TypeAdapter(dict[str, JsonValue])
    for row in data.rows:
        payload = adapter.validate_json(row.model_dump_json(by_alias=True))
        payload["lux"] = optional_number(row.lux, 200000)
        payload["noise_db"] = optional_number(row.noise, 150)
        observed = provider_time(row.sensing_time)
        published = provider_time(row.date)
        if not query.window_start <= observed < query.window_end:
            msg = "sdot_row_outside_window"
            raise SafeProviderError(msg)
        if observed - published > timedelta(minutes=5):
            msg = "sdot_excessive_clock_skew"
            raise SafeProviderError(msg)
        payload["source_clock_skew_seconds"] = max(0, (observed - published).total_seconds())
        records.append(
            ProviderRecord(
                entity_id=row.serial,
                observed_at=observed,
                published_at=published,
                revision_rank=int(row.data_no),
                source_updated_at=published,
                payload_json=json.dumps(payload, sort_keys=True, ensure_ascii=False),
            )
        )
    return ParsedPage(tuple(records), data.total, query.page_no, query.page_size)
