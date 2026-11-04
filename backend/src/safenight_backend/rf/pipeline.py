"""Train only from sealed cloud features and externally supplied, versioned labels."""

import hashlib
from collections.abc import Callable
from math import floor
from pathlib import Path
from typing import Final, Literal

import numpy as np
from pydantic import Field

from safenight_backend.rf.contracts import ArtifactError, Boundary, ModelMetadata, TrainingRow
from safenight_backend.rf.dataset import TrainingDataset
from safenight_backend.rf.training import export_forest, forest, train_bundle

MIN_SPLIT_ROWS: Final = 2
type SplitKind = Literal["sensor", "time", "region"]
type Split = tuple[tuple[FrozenRow, ...], tuple[FrozenRow, ...]]


class FrozenFeature(Boundary):
    """Exact exported environment input and identity."""

    sensor_id: str
    observed_at: str
    lat: float | None
    lon: float | None
    lux: float | None
    noise_db: float | None
    feature_version: Literal["environment-v1"]
    feature_revision: str


class FrozenRow(Boundary):
    """One frozen feature, target and their actual system availability times."""

    feature_snapshot_id: str
    data_release_id: str
    feature: FrozenFeature
    feature_available_at: str
    target_id: str
    target_value: float = Field(ge=0, le=100)
    target_time: str
    target_available_at: str
    target_object_key: str
    target_sha256: str


class FrozenDataset(Boundary):
    """Content-hashed cloud export; no mutable DB query is executed during fitting."""

    format: Literal["safenight-training-v1"]
    feature_version: Literal["environment-v1"]
    target_version: str
    training_cutoff: str
    split_policy: Literal["sensor-time-region-v1"]
    rows: tuple[FrozenRow, ...] = Field(min_length=1, max_length=10000)


class EvaluationExport(Boundary):
    """Holdout forest and exact train/test membership, verified again by the server."""

    kind: Literal["sensor", "time", "region"]
    train_ids: tuple[str, ...]
    test_ids: tuple[str, ...]
    model_text: str
    manifest_text: str


class CandidateExport(Boundary):
    """Data-only artifacts; server recomputes performance instead of trusting client metrics."""

    model_text: str
    manifest_text: str
    evaluations: tuple[EvaluationExport, ...]


def normalized(row: FrozenRow) -> TrainingRow:
    """Fail closed when an exported row cannot be used by the current two-input model."""
    value = row.feature
    if value.lat is None or value.lon is None or value.lux is None or value.noise_db is None:
        msg = "training_input_missing"
        raise ArtifactError(msg)
    return TrainingRow(
        sensor_id=value.sensor_id,
        time=value.observed_at,
        lat=value.lat,
        lon=value.lon,
        lux=value.lux,
        noise_db=value.noise_db,
        safety_index=row.target_value,
    )


def dataset_for(rows: tuple[FrozenRow, ...]) -> TrainingDataset:
    """Retain the exact feature and label identities as provenance digests."""
    features = "\n".join(row.feature_snapshot_id for row in rows).encode()
    targets = "\n".join(row.target_id for row in rows).encode()
    return TrainingDataset(
        tuple(normalized(row) for row in rows),
        hashlib.sha256(features).hexdigest(),
        hashlib.sha256(targets).hexdigest(),
    )


def grouped_split(
    rows: tuple[FrozenRow, ...],
    group: Callable[[FrozenRow], str],
) -> tuple[tuple[FrozenRow, ...], tuple[FrozenRow, ...]]:
    """Stable seed-42 group holdout shared with the serving-side evidence validator."""
    groups = sorted(
        {group(row) for row in rows},
        key=lambda value: hashlib.sha256(f"42:{value}".encode()).hexdigest(),
    )
    if len(groups) < MIN_SPLIT_ROWS:
        return (), ()
    held_out = set(groups[: max(1, (len(groups) + 4) // 5)])
    return (
        tuple(row for row in rows if group(row) not in held_out),
        tuple(row for row in rows if group(row) in held_out),
    )


def region(row: FrozenRow) -> str:
    """Approximately two-kilometer latitude/longitude tiles; not administrative regions."""
    return f"{floor((row.feature.lat or 0) * 50)}:{floor((row.feature.lon or 0) * 50)}"


def time_split(
    rows: tuple[FrozenRow, ...],
) -> tuple[tuple[FrozenRow, ...], tuple[FrozenRow, ...]]:
    """Use the last UTC observation day; training labels/inputs must already be available."""
    days = sorted({row.feature.observed_at[:10] for row in rows})
    if len(days) < MIN_SPLIT_ROWS:
        return (), ()
    testing = tuple(row for row in rows if row.feature.observed_at[:10] == days[-1])
    first_test = min(row.feature.observed_at for row in testing)
    training = tuple(
        row
        for row in rows
        if row.feature.observed_at < first_test
        and row.feature_available_at <= first_test
        and row.target_available_at <= first_test
    )
    return training, testing


def evaluation_export(
    kind: Literal["sensor", "time", "region"],
    training: tuple[FrozenRow, ...],
    testing: tuple[FrozenRow, ...],
    metadata: ModelMetadata,
) -> EvaluationExport:
    """Fit only training members and export a separate numerical validation forest."""
    dataset = dataset_for(training)
    x = np.array([(row.lux, row.noise_db) for row in dataset.rows], dtype=np.float64)
    y = np.array([row.safety_index for row in dataset.rows], dtype=np.float64)
    estimator = forest()
    _ = estimator.fit(x, y)
    payload = export_forest(estimator, dataset)
    text = payload.model_dump_json()
    digest = hashlib.sha256(text.encode()).hexdigest()
    evidence_metadata = metadata.model_copy(
        update={
            "version": f"rf-environment-v1-{digest[:12]}",
            "artifact_sha256": digest,
            "training_rows": len(training),
            "training_sensors": len(payload.locations),
            "bounds": payload.bounds,
            "training_locations": payload.locations,
            "train_groups": tuple(sorted({row.feature.sensor_id for row in training})),
            "test_groups": tuple(sorted({row.feature.sensor_id for row in testing})),
            "evaluation_train_rows": len(training),
            "evaluation_test_rows": len(testing),
            "validation_note": f"Separate {kind} evaluation forest; metrics recomputed on server.",
        }
    )
    return EvaluationExport(
        kind=kind,
        train_ids=tuple(row.feature_snapshot_id for row in training),
        test_ids=tuple(row.feature_snapshot_id for row in testing),
        model_text=text,
        manifest_text=evidence_metadata.model_dump_json(),
    )


def train_pipeline(snapshot: Path, output: Path) -> CandidateExport:
    """Train the existing algorithm while preserving frozen cloud membership and target meaning."""
    frozen = FrozenDataset.model_validate_json(snapshot.read_bytes())
    if any(
        row.feature_available_at > frozen.training_cutoff
        or row.target_available_at > frozen.training_cutoff
        or row.target_time != row.feature.observed_at
        for row in frozen.rows
    ):
        msg = "dataset_availability_mismatch"
        raise ArtifactError(msg)
    data = dataset_for(frozen.rows)
    bundle = train_bundle(data, snapshot, output)
    metadata = bundle.metadata.model_copy(
        update={
            "target_source": (
                f"Externally supplied rule_index labels, target version {frozen.target_version}; "
                "exact feature/target IDs and availability are in the sealed cloud dataset. "
                "Not observed crime, accident or perceived-safety outcomes."
            ),
        }
    )
    manifest = metadata.model_dump_json()
    _ = (output / "manifest.json").write_text(manifest)
    splits: tuple[tuple[SplitKind, Split], ...] = (
        ("sensor", grouped_split(frozen.rows, lambda row: row.feature.sensor_id)),
        ("time", time_split(frozen.rows)),
        ("region", grouped_split(frozen.rows, region)),
    )
    exports: list[EvaluationExport] = []
    for kind, (training, testing) in splits:
        if len(training) >= MIN_SPLIT_ROWS and len(testing) >= MIN_SPLIT_ROWS:
            exports.append(evaluation_export(kind, training, testing, metadata))
    return CandidateExport(
        model_text=(output / "model.json").read_text(),
        manifest_text=manifest,
        evaluations=tuple(exports),
    )
