"""Safe forest persistence and serving constraints use actual fitted sklearn trees."""

from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

import numpy as np
import pytest
from pydantic import ValidationError

from safenight_backend.rf import ArtifactError, ModelBundle, load_bundle
from safenight_backend.rf.contracts import TrainingRow
from safenight_backend.rf.dataset import TrainingDataset
from safenight_backend.rf.runtime import ForestRuntime
from safenight_backend.rf.training import forest, train_bundle
from safenight_backend.serving import AssessmentStatus, FeatureVector, PredictionError


@dataclass(frozen=True, slots=True)
class FittedFixture:
    bundle: ModelBundle
    dataset: TrainingDataset
    directory: Path


@pytest.fixture(scope="module")
def fitted(tmp_path_factory: pytest.TempPathFactory) -> FittedFixture:
    rows = tuple(
        TrainingRow(
            sensor_id=f"sensor-{site}",
            time=f"2025-10-12T00:0{index}:00",
            lat=37.5 + site / 1000,
            lon=127,
            lux=index * 20 + site,
            noise_db=40 + index,
            safety_index=60 + index * 4 + site,
        )
        for site in range(8)
        for index in range(5)
    )
    dataset = TrainingDataset(rows, "0" * 64, "1" * 64)
    directory = tmp_path_factory.mktemp("forest")
    snapshot = directory / "training.csv"
    snapshot.write_text("fixture training snapshot\n")
    bundle = train_bundle(dataset, snapshot, directory)
    return FittedFixture(bundle, dataset, directory)


def vector(row: TrainingRow) -> FeatureVector:
    return FeatureVector(
        sensor_id=row.sensor_id,
        observed_at=datetime(2026, 11, 4, tzinfo=UTC),
        lat=row.lat,
        lon=row.lon,
        lux=row.lux,
        noise_db=row.noise_db,
        revision="fixture",
    )


def test_json_loaded_forest_matches_actual_sklearn_predictions(fitted: FittedFixture) -> None:
    # Given: the same fixed-configuration sklearn model and its saved data-only export.
    rows = fitted.dataset.rows
    x = np.array([(row.lux, row.noise_db) for row in rows], dtype=np.float64)
    y = np.array([row.safety_index for row in rows], dtype=np.float64)
    original = forest()
    _ = original.fit(x, y)
    # When: scoring the same inputs through the persisted predictor.
    expected = original.predict(x)
    actual = np.array([fitted.bundle.predictor.predict(vector(row)) for row in rows])
    # Then: numerical output matches sklearn, not merely another hand-written fixture.
    np.testing.assert_allclose(actual, expected, rtol=0, atol=1e-12)


def test_model_holdout_never_splits_a_sensor_between_train_and_test(fitted: FittedFixture) -> None:
    # Given: repeated observations at each training site.
    metadata = fitted.bundle.metadata
    # When: inspecting the persisted grouped evaluation record.
    overlap = set(metadata.train_groups) & set(metadata.test_groups)
    # Then: there is no site overlap, and all evaluation rows are accounted for.
    assert not overlap
    assert metadata.evaluation_train_rows + metadata.evaluation_test_rows == len(
        fitted.dataset.rows
    )
    assert metadata.training_sensors == 8


def test_model_artifact_tampering_fails_before_inference(
    fitted: FittedFixture, tmp_path: Path
) -> None:
    # Given: a copied manifest and modified model bytes.
    (tmp_path / "manifest.json").write_bytes((fitted.directory / "manifest.json").read_bytes())
    (tmp_path / "model.json").write_bytes((fitted.directory / "model.json").read_bytes() + b" ")
    # When: loading the unapproved modified artifact.
    with pytest.raises(ArtifactError, match="artifact_digest_mismatch"):
        load_bundle(tmp_path)
    # Then: the checksum violation prevents a usable predictor.


@pytest.mark.parametrize(
    "change",
    [
        {"lux": None},
        {"noise_db": None},
        {"lux": 1000},
        {"noise_db": 90},
        {"sensor_id": "unknown"},
        {"lat": 37.6},
        {"lon": None},
    ],
)
def test_model_abstains_outside_observed_input_and_location_support(
    fitted: FittedFixture, change: dict[str, str | float | None]
) -> None:
    # Given: an otherwise supported sensor with one missing or unsupported field.
    features = vector(fitted.dataset.rows[0]).model_copy(update=change)
    # When: the predictor is directly asked to score the unsupported input.
    with pytest.raises(PredictionError, match="outside_training_support"):
        fitted.bundle.predictor.predict(features)
    # Then: no fabricated facility value or extrapolated score is returned.


@pytest.mark.parametrize("value", [float("nan"), float("inf")])
def test_nonfinite_features_cannot_cross_serving_boundary(value: float) -> None:
    # Given: a nonfinite sensor measurement.
    # When: parsing the inference input.
    with pytest.raises(ValidationError):
        FeatureVector(
            sensor_id="sensor-0",
            observed_at=datetime(2026, 11, 4, tzinfo=UTC),
            lux=value,
            revision="fixture",
        )
    # Then: invalid floating-point values never reach the forest.


def test_default_forest_runtime_retains_artifact_prediction_and_missing_data_behavior(
    fitted: FittedFixture,
) -> None:
    # Given: a verified RF bundle loaded through the new algorithm-specific adapter.
    runtime = ForestRuntime(fitted.bundle)
    features = vector(fitted.dataset.rows[0])
    # When: the runtime assesses current supported input and absent measurements.
    scored = runtime.assess(features, features.observed_at)
    missing = runtime.assess(features.model_copy(update={"lux": None}), features.observed_at)
    # Then: predictions match the artifact and missing input still abstains.
    assert scored.score == fitted.bundle.predictor.predict(features)
    assert (scored.status, missing.status, missing.score) == (
        AssessmentStatus.SCORED,
        AssessmentStatus.DATA_UNAVAILABLE,
        None,
    )
    assert runtime.info.version == scored.model_version == fitted.bundle.metadata.version
