"""Explicit offline fitting; importing or serving the API never triggers training."""

import hashlib
from pathlib import Path
from typing import Final

import numpy as np

from safenight_backend.rf.artifact import ModelBundle, load_bundle, validate_payload
from safenight_backend.rf.contracts import (
    FeatureBounds,
    ForestPayload,
    Location,
    ModelMetadata,
    TreeNode,
)
from safenight_backend.rf.dataset import TrainingDataset
from safenight_backend.rf.sklearn_api import (
    GroupShuffleSplit,
    RandomForestRegressor,
)

TARGET_SOURCE: Final = (
    "Corrected SafeNight predictions.csv rule_index joined one-to-one on sensor_id,time; "
    "engineered full-input safety_index, reduced to lux/noise inputs for this experiment. "
    "Not observed crime, accident, or perceived-safety labels."
)


def forest() -> RandomForestRegressor:
    """Use one fixed configuration for holdout evaluation and final fitting."""
    return RandomForestRegressor(
        n_estimators=114,
        max_depth=18,
        min_samples_leaf=3,
        random_state=42,
        n_jobs=1,
    )


def export_forest(model: RandomForestRegressor, dataset: TrainingDataset) -> ForestPayload:
    """Export only numerical nodes, never executable estimator objects."""
    trees: list[tuple[TreeNode, ...]] = []
    for estimator in model.estimators_:
        tree = estimator.tree_
        trees.append(
            tuple(
                TreeNode(
                    feature=int(tree.feature.item(index)),
                    threshold=float(tree.threshold.item(index)),
                    left=int(tree.children_left.item(index)),
                    right=int(tree.children_right.item(index)),
                    value=float(tree.value.item((index, 0, 0))),
                )
                for index in range(tree.node_count)
            ),
        )
    locations = {
        row.sensor_id: Location(sensor_id=row.sensor_id, lat=row.lat, lon=row.lon)
        for row in dataset.rows
    }
    payload = ForestPayload(
        bounds=FeatureBounds(
            lux_min=min(row.lux for row in dataset.rows),
            lux_max=max(row.lux for row in dataset.rows),
            noise_min=min(row.noise_db for row in dataset.rows),
            noise_max=max(row.noise_db for row in dataset.rows),
        ),
        trees=tuple(trees),
        locations=tuple(locations[key] for key in sorted(locations)),
    )
    validate_payload(payload)
    return payload


def train_bundle(dataset: TrainingDataset, snapshot: Path, output: Path) -> ModelBundle:
    """Evaluate unseen sensor sites once, refit all rows, and publish a digest-checked bundle."""
    x = np.array([(row.lux, row.noise_db) for row in dataset.rows], dtype=np.float64)
    y = np.array([row.safety_index for row in dataset.rows], dtype=np.float64)
    groups = np.array([row.sensor_id for row in dataset.rows], dtype=np.str_)
    train, test = next(
        GroupShuffleSplit(n_splits=1, test_size=0.2, random_state=42).split(x, y, groups)
    )
    evaluation = forest()
    _ = evaluation.fit(x[train], y[train])
    prediction = evaluation.predict(x[test])
    residual = float(np.sum((y[test] - prediction) ** 2))
    variance = float(np.sum((y[test] - np.mean(y[test])) ** 2))
    final = forest()
    _ = final.fit(x, y)
    payload = export_forest(final, dataset)
    body = payload.model_dump_json().encode()
    digest = hashlib.sha256(body).hexdigest()
    metadata = ModelMetadata(
        version=f"rf-environment-v1-{digest[:12]}",
        target_source=TARGET_SOURCE,
        training_rows=len(dataset.rows),
        training_sensors=len(payload.locations),
        training_sha256=hashlib.sha256(snapshot.read_bytes()).hexdigest(),
        artifact_sha256=digest,
        validation_mae=float(np.mean(np.abs(y[test] - prediction))),
        validation_r2=1 - residual / variance if variance > 0 else float(residual == 0),
        validation_note=(
            "20% sensor-group holdout, seed42, no sensor overlap. Metrics measure reproduction "
            "of the engineered target, not real-world safety. Full fit follows evaluation."
        ),
        train_groups=tuple(
            sorted({dataset.rows[int(train.item(index))].sensor_id for index in range(len(train))})
        ),
        test_groups=tuple(
            sorted({dataset.rows[int(test.item(index))].sensor_id for index in range(len(test))})
        ),
        evaluation_train_rows=len(train),
        evaluation_test_rows=len(test),
        bounds=payload.bounds,
        training_locations=payload.locations,
        source_observations_sha256=dataset.observations_sha256,
        source_predictions_sha256=dataset.predictions_sha256,
    )
    output.mkdir(parents=True, exist_ok=True)
    _ = (output / "model.json").write_bytes(body)
    _ = (output / "manifest.json").write_text(metadata.model_dump_json(indent=2) + "\n")
    return load_bundle(output)
