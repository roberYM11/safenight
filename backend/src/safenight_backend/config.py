"""Secrets remain in the local server environment, never in API responses."""

from pathlib import Path
from typing import ClassVar

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Explicit server and collection configuration."""

    model_config: ClassVar[SettingsConfigDict] = SettingsConfigDict(
        env_prefix="SAFENIGHT_",
        env_file=".env",
        extra="ignore",
    )
    database_url: SecretStr = SecretStr("")
    sdot_api_key: SecretStr = SecretStr("")
    cctv_api_key: SecretStr = SecretStr("")
    collection_hour: int = Field(default=3, ge=0, le=23)
    collection_minute: int = Field(default=0, ge=0, le=59)
    correction_days: int = Field(default=7, ge=1, le=29)
    max_pages: int = Field(default=10000, ge=1, le=10000)
    sensor_locations_file: Path = Path("var/sensor_locations.xlsx")
    model_bundle_dir: Path | None = None
    web_dist: Path | None = None
