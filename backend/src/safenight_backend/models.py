"""Version-one persistence schema; ORM mutation exists only inside transactions."""

from datetime import datetime

from pydantic import JsonValue
from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Integer, LargeBinary, String
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    """Shared metadata for explicit schema migrations."""


class SchemaVersion(Base):
    """Track applied schema versions, mutated only by initialization."""

    __tablename__: str = "schema_versions"
    version: Mapped[int] = mapped_column(primary_key=True)
    applied_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class SourceRun(Base):
    """One source-window attempt; lifecycle and counts are transactionally updated."""

    __tablename__: str = "source_runs"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    source: Mapped[str] = mapped_column(String(80), index=True)
    window_start: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    window_end: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    full_snapshot: Mapped[bool] = mapped_column(Boolean, default=False)
    status: Mapped[str] = mapped_column(String(20))
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    fetched_rows: Mapped[int] = mapped_column(Integer)
    inserted_rows: Mapped[int] = mapped_column(Integer)
    error_code: Mapped[str | None] = mapped_column(String(80))


class RawObject(Base):
    """An immutable raw provider response; repeated bytes share one object."""

    __tablename__: str = "raw_objects"
    sha256: Mapped[str] = mapped_column(String(64), primary_key=True)
    source: Mapped[str] = mapped_column(String(80))
    body: Mapped[bytes] = mapped_column(LargeBinary)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class ObservationRevision(Base):
    """Immutable normalized revision, including its original response reference."""

    __tablename__: str = "observation_revisions"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    source: Mapped[str] = mapped_column(String(80), index=True)
    entity_id: Mapped[str] = mapped_column(String(240), index=True)
    observed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    published_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    revision_rank: Mapped[int] = mapped_column(Integer)
    source_updated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    payload: Mapped[dict[str, JsonValue]] = mapped_column(JSONB)
    raw_sha: Mapped[str] = mapped_column(ForeignKey("raw_objects.sha256"))
    ingested_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    lat: Mapped[float | None] = mapped_column(Float)
    lon: Mapped[float | None] = mapped_column(Float)


class CurrentObservation(Base):
    """Current selection pointer, updated only under a source transaction lock."""

    __tablename__: str = "current_observations"
    source: Mapped[str] = mapped_column(String(80), primary_key=True)
    entity_id: Mapped[str] = mapped_column(String(240), primary_key=True)
    observed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), primary_key=True)
    revision_id: Mapped[str] = mapped_column(ForeignKey("observation_revisions.id"))


class SourceCheckpoint(Base):
    """Largest contiguous successfully committed source query boundary."""

    __tablename__: str = "source_checkpoints"
    source: Mapped[str] = mapped_column(String(80), primary_key=True)
    covered_until: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class FeatureSnapshot(Base):
    """Immutable versioned feature payload tied to its source observation revision."""

    __tablename__: str = "feature_snapshots"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    source_revision_id: Mapped[str] = mapped_column(
        ForeignKey("observation_revisions.id"), index=True
    )
    feature_version: Mapped[str] = mapped_column(String(120))
    payload: Mapped[dict[str, JsonValue]] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class ModelArtifact(Base):
    """Immutable model identity and approved metadata, not uploaded executable code."""

    __tablename__: str = "model_artifacts"
    version: Mapped[str] = mapped_column(String(120), primary_key=True)
    digest: Mapped[str] = mapped_column(String(64))
    feature_version: Mapped[str] = mapped_column(String(120))
    approved: Mapped[bool] = mapped_column(Boolean)
    manifest: Mapped[dict[str, JsonValue]] = mapped_column(JSONB)


class ActiveModel(Base):
    """Transactional active model pointer; artifacts themselves stay immutable."""

    __tablename__: str = "active_models"
    name: Mapped[str] = mapped_column(String(80), primary_key=True)
    model_version: Mapped[str] = mapped_column(ForeignKey("model_artifacts.version"))
