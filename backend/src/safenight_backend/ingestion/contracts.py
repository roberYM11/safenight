"""Typed provider contracts, excluding credentials from diagnostics."""

import re
from dataclasses import dataclass, field
from datetime import UTC, datetime
from math import isfinite
from typing import Final
from zoneinfo import ZoneInfo

SEOUL: Final = ZoneInfo("Asia/Seoul")
MAX_PAGE_SIZE: Final = 1000


@dataclass(frozen=True, slots=True)
class SafeProviderError(ValueError):
    """A machine-readable provider error containing no URL, key or raw body."""

    code: str


@dataclass(frozen=True, slots=True)
class SourceQuery:
    """One paginated source window; the key is deliberately absent from repr."""

    key: str = field(repr=False)
    window_start: datetime
    window_end: datetime
    page_no: int = 1
    page_size: int = 100
    full_snapshot: bool = False

    def __post_init__(self) -> None:
        """Reject unsafe windows before making a provider request."""
        if self.window_start.tzinfo is None or self.window_end.tzinfo is None:
            msg = "naive_window"
            raise SafeProviderError(msg)
        if self.window_start >= self.window_end:
            msg = "invalid_window"
            raise SafeProviderError(msg)
        if self.page_no < 1 or not 1 <= self.page_size <= MAX_PAGE_SIZE:
            msg = "invalid_pagination"
            raise SafeProviderError(msg)


@dataclass(frozen=True, slots=True)
class ProviderRecord:
    """A normalized record; source identity and raw digest are assigned by the runner."""

    entity_id: str
    observed_at: datetime
    published_at: datetime
    revision_rank: int
    source_updated_at: datetime | None
    payload_json: str
    lat: float | None = None
    lon: float | None = None


@dataclass(frozen=True, slots=True)
class ParsedPage:
    """Validated page metadata used to prove pagination completeness."""

    records: tuple[ProviderRecord, ...]
    total_count: int
    page_no: int
    page_size: int


def provider_time(value: str) -> datetime:
    """Parse verified provider clocks, including SDOT's hyphen-separated time."""
    try:
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}", value):
            return (
                datetime.strptime(value, "%Y-%m-%d_%H-%M-%S").replace(tzinfo=SEOUL).astimezone(UTC)
            )
        parsed = datetime.fromisoformat(value.replace("_", " "))
        return (parsed if parsed.tzinfo else parsed.replace(tzinfo=SEOUL)).astimezone(UTC)
    except ValueError:
        msg = "invalid_provider_time"
        raise SafeProviderError(msg) from None


def optional_number(value: str | None, maximum: float) -> float | None:
    """Keep missing measurement distinct from zero, rejecting nonfinite values."""
    if value is None or not value.strip():
        return None
    try:
        number = float(value)
    except ValueError:
        msg = "invalid_number"
        raise SafeProviderError(msg) from None
    if not isfinite(number) or not 0 <= number <= maximum:
        msg = "invalid_number"
        raise SafeProviderError(msg)
    return number
