"""Camera discovery contracts; facility coverage and video availability are separate."""

from datetime import datetime
from ipaddress import ip_address
from typing import ClassVar, Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, field_validator
from pydantic_core import PydanticCustomError


class CameraBoundary(BaseModel):
    """Frozen, finite values parsed at the API and operator configuration boundaries."""

    model_config: ClassVar[ConfigDict] = ConfigDict(
        frozen=True, extra="forbid", allow_inf_nan=False
    )


class SearchArea(CameraBoundary):
    """Meter-based search area for an explicit user request."""

    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    radius_m: int = Field(default=1000, ge=50, le=5000)


class ApprovedVideo(CameraBoundary):
    """Operator-supplied, permitted public playback URLs, never arbitrary request URLs."""

    camera_id: str = Field(min_length=1)
    name: str = Field(min_length=1)
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    playback_url: str
    playback_type: Literal["hls", "mp4", "external"]
    source_url: str

    @field_validator("playback_url", "source_url")
    @classmethod
    def public_https(cls, value: str) -> str:
        """Keep private network URLs and embedded credentials out of browser playback."""
        parsed = urlsplit(value)
        host = parsed.hostname or ""
        if (
            parsed.scheme != "https"
            or parsed.username
            or parsed.password
            or "." not in host
            or host.endswith((".localhost", ".local", ".internal"))
        ):
            code = "public_https_required"
            raise PydanticCustomError(code, "Public HTTPS hostname required")
        try:
            _ = ip_address(host)
        except ValueError:
            return value
        code = "literal_ip_not_allowed"
        raise PydanticCustomError(code, "Literal IP addresses are not allowed")


class NearbyCamera(CameraBoundary):
    """A facility position alone does not imply accessible live footage."""

    camera_id: str
    name: str = "공공 CCTV"
    lat: float
    lon: float
    distance_m: float
    video_available: bool = False
    playback_url: str | None = None
    playback_type: Literal["hls", "mp4", "external"] | None = None
    source_url: str | None = None


class CameraDiscovery(CameraBoundary):
    """Explicit source scope with nullable pedestrian measurements."""

    searched_at: datetime
    radius_m: int
    status: Literal["FOUND", "NO_MATCH", "COVERAGE_UNKNOWN", "PROVIDER_ERROR"]
    lookup_scope: Literal["stored_facilities", "provider", "mixed"]
    cameras: tuple[NearbyCamera, ...]
    video_status: Literal[
        "AVAILABLE", "SOURCE_NOT_CONNECTED", "NO_PLAYABLE_VIDEO", "PROVIDER_ERROR"
    ]
    lookup_complete: bool
    provider_errors: tuple[str, ...] = ()
    current_people: int | None = None
    passages_last_minute: int | None = None
    message: str
