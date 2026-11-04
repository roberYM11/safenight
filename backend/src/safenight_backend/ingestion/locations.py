"""Read explicit sensor coordinates from bounded, entity-free XLSX XML parts."""

import io
import posixpath
import re
import unicodedata
import xml.etree.ElementTree as ET
import zipfile
from dataclasses import dataclass
from typing import Final, Literal, assert_never

from pydantic import BaseModel, Field

from safenight_backend.ingestion.contracts import SafeProviderError, optional_number

NAMESPACE: Final = {"x": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
RELATIONSHIP: Final = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"
MAX_UNCOMPRESSED_BYTES: Final = 20000000


@dataclass(frozen=True, slots=True)
class SensorLocation:
    """WGS84 coordinates bound to a provider sensor identifier."""

    sensor_id: str
    lat: float
    lon: float


@dataclass(frozen=True, slots=True)
class Columns:
    """Explicit workbook references, preserving sparse Excel column positions."""

    serial: str
    lat: str
    lon: str


class Coordinates(BaseModel):
    """The known Korean geographic envelope, never automatic coordinate swapping."""

    lat: float = Field(ge=33, le=39)
    lon: float = Field(ge=124, le=132)


def _xml(archive: zipfile.ZipFile, path: str) -> ET.Element:
    data = archive.read(path)
    if b"<!DOCTYPE" in data.upper() or b"<!ENTITY" in data.upper():
        msg = "locations_xml_entities_forbidden"
        raise SafeProviderError(msg)
    # ZIP expansion is bounded and DTD/entity declarations have been rejected above.
    return ET.fromstring(data)  # noqa: S314


def _header(value: str) -> str:
    return re.sub(r"[\s_*()]", "", unicodedata.normalize("NFKC", value)).casefold()


def _cell_text(cell: ET.Element, shared: tuple[str, ...]) -> str:
    value = cell.find("x:v", NAMESPACE)
    text = value.text if value is not None else ""
    kind: Literal["shared", "inline", "value"] = (
        "shared" if cell.get("t") == "s" else "inline" if cell.get("t") == "inlineStr" else "value"
    )
    match kind:
        case "shared":
            try:
                return shared[int(text or "")]
            except (ValueError, IndexError):
                msg = "locations_invalid_shared_string"
                raise SafeProviderError(msg) from None
        case "inline":
            return "".join(node.text or "" for node in cell.findall(".//x:t", NAMESPACE))
        case "value":
            return text or ""
        case _:
            assert_never(kind)


def _workbook(body: bytes) -> tuple[list[ET.Element], tuple[str, ...]]:
    with zipfile.ZipFile(io.BytesIO(body)) as archive:
        if sum(item.file_size for item in archive.infolist()) > MAX_UNCOMPRESSED_BYTES:
            msg = "locations_workbook_too_large"
            raise SafeProviderError(msg)
        shared = (
            tuple("".join(node.itertext()) for node in _xml(archive, "xl/sharedStrings.xml"))
            if "xl/sharedStrings.xml" in archive.namelist()
            else ()
        )
        first_sheet = _xml(archive, "xl/workbook.xml").find("x:sheets/x:sheet", NAMESPACE)
        if first_sheet is None:
            msg = "locations_missing_sheet"
            raise SafeProviderError(msg)
        relation_id = first_sheet.get(RELATIONSHIP)
        relations = _xml(archive, "xl/_rels/workbook.xml.rels")
        target = next((r.get("Target", "") for r in relations if r.get("Id") == relation_id), "")
        path = posixpath.normpath("xl/" + target) if not target.startswith("/") else target[1:]
        if not path.startswith("xl/"):
            msg = "locations_invalid_sheet_path"
            raise SafeProviderError(msg)
        sheet = _xml(archive, path)
    return sheet.findall("x:sheetData/x:row", NAMESPACE), shared


def _columns(row: ET.Element, shared: tuple[str, ...]) -> Columns:
    columns = {
        _header(_cell_text(c, shared)): re.sub(r"[0-9]", "", c.get("r", ""))
        for c in row.findall("x:c", NAMESPACE)
    }
    serial = next((columns[h] for h in ("serial", "sensorid", "모델시리얼") if h in columns), None)
    lat = next((columns[h] for h in ("위도", "latitude", "lat", "la") if h in columns), None)
    lon = next(
        (columns[h] for h in ("경도", "longitude", "lon", "lng", "lo") if h in columns), None
    )
    if serial is None or lat is None or lon is None:
        msg = "locations_missing_required_columns"
        raise SafeProviderError(msg)
    return Columns(serial, lat, lon)


def parse_locations(body: bytes) -> tuple[SensorLocation, ...]:
    """Require named ID/latitude/longitude columns; incomplete rows remain unavailable."""
    try:
        rows, shared = _workbook(body)
    except (zipfile.BadZipFile, KeyError, ET.ParseError):
        msg = "locations_invalid_workbook"
        raise SafeProviderError(msg) from None
    if not rows:
        msg = "locations_missing_header"
        raise SafeProviderError(msg)
    columns = _columns(rows[0], shared)
    locations: dict[str, SensorLocation] = {}
    for row in rows[1:]:
        values = {
            re.sub(r"[0-9]", "", c.get("r", "")): _cell_text(c, shared)
            for c in row.findall("x:c", NAMESPACE)
        }
        serial = values.get(columns.serial, "").strip()
        lat = optional_number(values.get(columns.lat), 90)
        lon = optional_number(values.get(columns.lon), 180)
        if not serial or lat is None or lon is None:
            continue
        point = Coordinates(lat=lat, lon=lon)
        location = SensorLocation(serial, point.lat, point.lon)
        previous = locations.get(serial)
        if previous is not None and previous != location:
            msg = "locations_conflicting_identity"
            raise SafeProviderError(msg)
        locations[serial] = location
    if not locations:
        msg = "locations_empty"
        raise SafeProviderError(msg)
    return tuple(locations.values())
