import io
import json
from dataclasses import replace
from datetime import UTC, datetime

import pytest
from openpyxl import Workbook
from pydantic import JsonValue

from safenight_backend.ingestion import cctv, sdot
from safenight_backend.ingestion.contracts import SafeProviderError, SourceQuery, provider_time
from safenight_backend.ingestion.locations import parse_locations

QUERY = SourceQuery(
    "fixture-not-secret",
    datetime(2026, 11, 2, 15, tzinfo=UTC),
    datetime(2026, 11, 3, 15, tzinfo=UTC),
)


def test_provider_explicit_timezone_is_preserved() -> None:
    # Given: an explicit UTC timestamp instead of a timezone-free Seoul clock.
    value = "2026-11-03T13:07:00Z"
    # When: normalizing the provider timestamp.
    normalized = provider_time(value)
    # Then: the instant remains unchanged rather than shifting nine hours.
    assert normalized == datetime(2026, 11, 3, 13, 7, tzinfo=UTC)


def sdot_body(**changes: JsonValue) -> bytes:
    row: dict[str, JsonValue] = {
        "SERIAL": "sensor-fixture-A",
        "SENSING_TIME": "2026-11-03_22:07:00",
        "DATE": "2026-11-03 22:07:49.0",
        "DATA_NO": "2",
        "AVG_INTE_ILLU": "69",
        "AVG_NOISE": "50",
        "AUTONOMOUS_DISTRICT": "Yongsan-gu",
    }
    row.update(changes)
    return json.dumps(
        {"sDoTEnv": {"list_total_count": 1, "RESULT": {"CODE": "INFO-000"}, "row": [row]}}
    ).encode()


def cctv_body(**changes: JsonValue) -> bytes:
    row: dict[str, JsonValue] = {
        "OPN_ATMY_GRP_CD": "fixture-111",
        "MNG_NO": "fixture-123",
        "CAM_CNTOM": "4",
        "WGS84_LAT": "37.5",
        "WGS84_LOT": "127.0",
        "DAT_CRTR_YMD": "2026-09-30",
        "DAT_UPDT_PNT": "2026-11-03 22:00:00",
        "DAT_UPDT_SE": "I",
        "KPNG_DAY_CNT": None,
    }
    row.update(changes)
    return json.dumps(
        {
            "response": {
                "header": {"resultCode": "0"},
                "body": {
                    "items": {"item": [row]},
                    "totalCount": 1,
                    "pageNo": 1,
                    "numOfRows": 100,
                },
            }
        }
    ).encode()


def test_sdot_units_time_and_full_payload_are_preserved() -> None:
    # Given: the provider's exact string-valued source fields.
    body = sdot_body()
    # When: normalizing a corrected observation.
    record = sdot.parse_page(body, QUERY).records[0]
    # Then: physical units survive and no coordinates are invented.
    assert record.observed_at == datetime(2026, 11, 3, 13, 7, tzinfo=UTC)
    assert record.revision_rank == 2
    assert record.lat is None
    payload = json.loads(record.payload_json)
    assert payload["noise_db"] == 50
    assert payload["lux"] == 69
    assert payload["AUTONOMOUS_DISTRICT"] == "Yongsan-gu"


def test_real_sdot_hyphen_clock_and_small_provider_skew_are_preserved() -> None:
    # Given: a timestamp spelling and clock skew observed in the real 2026-11-03 response.
    body = sdot_body(SENSING_TIME="2026-11-03_23-08-19", DATE="2026-11-03 23:08:03.0")
    # When: parsing without changing either source timestamp.
    record = sdot.parse_page(body, QUERY).records[0]
    # Then: the actual event time and explicit quality signal survive.
    assert record.observed_at == datetime(2026, 11, 3, 14, 8, 19, tzinfo=UTC)
    assert json.loads(record.payload_json)["source_clock_skew_seconds"] == 16


def test_large_provider_clock_skew_is_rejected() -> None:
    # Given: a publication clock more than five minutes behind the claimed event time.
    body = sdot_body(SENSING_TIME="2026-11-03_23-08-19", DATE="2026-11-03 23:00:00")
    # When: normalizing this inconsistent observation.
    with pytest.raises(SafeProviderError, match="sdot_excessive_clock_skew"):
        sdot.parse_page(body, QUERY)
    # Then: it cannot silently become a publishable measurement.


def test_sdot_missing_measurement_remains_null() -> None:
    # Given: blank/null measurements rather than observed zero.
    body = sdot_body(AVG_INTE_ILLU="", AVG_NOISE=None)
    # When: parsing the source response.
    record = sdot.parse_page(body, QUERY).records[0]
    # Then: missing information cannot be mistaken for dark/quiet observations.
    assert json.loads(record.payload_json)["lux"] is None
    assert json.loads(record.payload_json)["noise_db"] is None


@pytest.mark.parametrize("noise", ["50000", "NaN", "Infinity", "-1", "garbage"])
def test_sdot_invalid_measurement_is_rejected(noise: str) -> None:
    # Given: invalid physical values or incorrect source units.
    body = sdot_body(AVG_NOISE=noise)
    # When: the source boundary is parsed.
    with pytest.raises(SafeProviderError):
        sdot.parse_page(body, QUERY)
    # Then: no canonical observation is available to publish.


def test_sdot_application_error_is_not_empty_success() -> None:
    # Given: an HTTP-success authentication error envelope.
    body = b'{"RESULT":{"CODE":"ERROR-301"}}'
    # When: parsing its content.
    with pytest.raises(SafeProviderError, match="sdot_provider_rejected"):
        sdot.parse_page(body, QUERY)
    # Then: callers cannot advance the collection cursor.


def test_sdot_declared_empty_response_is_distinguished_from_error() -> None:
    # Given: the provider's documented no-data result.
    body = b'{"RESULT":{"CODE":"INFO-200"}}'
    # When: parsing the legitimate empty window.
    page = sdot.parse_page(body, QUERY)
    # Then: explicit successful emptiness can be committed by the runner.
    assert page.total_count == 0
    assert page.records == ()


def test_cctv_camera_quantity_and_nullable_fields_are_accepted() -> None:
    # Given: one installation with four cameras and a nullable unrelated field.
    body = cctv_body()
    # When: parsing the MOIS page.
    record = cctv.parse_page(body, QUERY).records[0]
    # Then: quantity and stable identity differ from coordinate row count.
    assert json.loads(record.payload_json)["camera_count"] == 4
    assert record.entity_id == "fixture-111:fixture-123"
    assert record.lat == 37.5
    assert record.lon == 127


def test_cctv_page_mismatch_is_rejected() -> None:
    # Given: page one is returned when page two was requested.
    query = replace(QUERY, page_no=2)
    # When: parsing the response.
    with pytest.raises(SafeProviderError, match="cctv_invalid_pagination"):
        cctv.parse_page(cctv_body(), query)
    # Then: the missing page cannot silently complete the query window.


def test_cctv_unknown_change_code_is_retained_without_inventing_deletion() -> None:
    # Given: an unverified change code.
    body = cctv_body(DAT_UPDT_SE="UNVERIFIED")
    # When: parsing the provider row.
    page = cctv.parse_page(body, QUERY)
    # Then: raw semantics survive for a later explicit interpretation policy.
    assert json.loads(page.records[0].payload_json)["DAT_UPDT_SE"] == "UNVERIFIED"


def test_cctv_outside_update_window_cannot_complete_incremental_collection() -> None:
    # Given: a provider that returned a record outside the requested change interval.
    body = cctv_body(DAT_UPDT_PNT="2026-11-02 22:00:00")
    # When: validating an incremental response.
    with pytest.raises(SafeProviderError, match="cctv_row_outside_update_window"):
        cctv.parse_page(body, QUERY)
    # Then: an ignored provider filter cannot silently advance the checkpoint.


def test_cctv_full_baseline_accepts_older_unchanged_records() -> None:
    # Given: an explicit full snapshot that includes unchanged older installations.
    body = cctv_body(DAT_UPDT_PNT="2026-11-02 22:00:00")
    # When: validating the baseline rather than a daily change query.
    page = cctv.parse_page(body, replace(QUERY, full_snapshot=True))
    # Then: the historical record is retained for baseline construction.
    assert len(page.records) == 1


def test_location_workbook_requires_explicit_coordinate_headers() -> None:
    # Given: a workbook with recognized names and a sensor identifier.
    workbook = Workbook()
    worksheet = workbook.active
    assert worksheet is not None
    worksheet.append(["모델 시리얼(*)", "위도", "경도"])
    worksheet.append(["fixture-A", 37.5, 127.0])
    stream = io.BytesIO()
    workbook.save(stream)
    workbook.close()
    # When: loading sensor coordinates.
    locations = parse_locations(stream.getvalue())
    # Then: explicit coordinates attach to the matching sensor.
    assert [(row.sensor_id, row.lat, row.lon) for row in locations] == [("fixture-A", 37.5, 127)]


def test_location_html_error_is_not_a_workbook() -> None:
    # Given: an upstream error document delivered instead of XLSX.
    body = b"<html>provider error</html>"
    # When: interpreting it at the XLSX boundary.
    with pytest.raises(SafeProviderError, match="locations_invalid_workbook"):
        parse_locations(body)
    # Then: no fabricated sensor positions are returned.
