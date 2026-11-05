#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = ["safenight-backend"]
# [tool.uv.sources]
# safenight-backend = { path = ".." }
# ///
# ─── How to run ───
# From backend/, using the project lockfile:
# uv run --locked python scripts/compare_models.py --output ../docs/model-analysis

"""Evaluate fixed model settings on the sensor holdout used for the service model."""

from __future__ import annotations

import csv
import hashlib
import json
import platform
from pathlib import Path
from typing import TYPE_CHECKING, Final

import numpy as np
import sklearn
import typer
from sklearn.metrics import mean_absolute_error, r2_score, root_mean_squared_error

from safenight_backend.rf.dataset import load_dataset
from safenight_backend.rf.sklearn_api import GroupShuffleSplit
from safenight_backend.rf.training import forest

if TYPE_CHECKING:
    from numpy.typing import NDArray

    from safenight_backend.rf.sklearn_api import RandomForestRegressor

SNAPSHOT: Final = Path(__file__).resolve().parents[1] / "data/training/environment_proxy.csv"
FEATURES: Final = ("lux", "noise_db")


def write_dependence(
    output: Path,
    models: tuple[RandomForestRegressor, RandomForestRegressor],
    train_x: NDArray[np.float64],
    test_x: NDArray[np.float64],
) -> None:
    """Replace one input for every holdout row, retaining the observed other input."""
    with output.open("w", newline="", encoding="utf-8") as stream:
        writer = csv.writer(stream)
        writer.writerow(("feature", "value", "current_leaf3", "variant_leaf1"))
        for col, feature in enumerate(FEATURES):
            low, high = np.percentile(train_x[:, col], [5, 95])
            background = test_x.copy()
            for value in np.linspace(low, high, 51):
                background[:, col] = value
                writer.writerow(
                    (feature, value, *(np.mean(model.predict(background)) for model in models)),
                )


def main(output: Path = Path("../docs/model-analysis")) -> None:
    """Write holdout metrics and partial dependence data without exporting trained models."""
    rows = load_dataset(SNAPSHOT).rows
    x = np.array([(row.lux, row.noise_db) for row in rows], dtype=np.float64)
    y = np.array([row.safety_index for row in rows], dtype=np.float64)
    groups = np.array([row.sensor_id for row in rows])
    split = GroupShuffleSplit(n_splits=1, test_size=0.2, random_state=42)
    train, test = next(split.split(x, y, groups))
    current = forest()
    variant = forest().set_params(min_samples_leaf=1)
    models = (current, variant)
    for model in models:
        model.fit(x[train], y[train])
    median = float(np.median(y[train]))
    predictions = {
        "train_median": np.full(len(test), median),
        "current_leaf3": current.predict(x[test]),
        "variant_leaf1": variant.predict(x[test]),
    }
    metrics = {
        name: {
            "mae": float(mean_absolute_error(y[test], prediction)),
            "rmse": float(root_mean_squared_error(y[test], prediction)),
            "r2": float(r2_score(y[test], prediction)),
        }
        for name, prediction in predictions.items()
    }
    scores = [
        {
            "model": name,
            **values,
            **{f"delta_{k}": v - metrics["current_leaf3"][k] for k, v in values.items()},
        }
        for name, values in metrics.items()
    ]
    manifest = {
        "target": "safety_index (engineered rule_index, 0-100 points)",
        "features": FEATURES,
        "snapshot": "backend/data/training/environment_proxy.csv",
        "snapshot_sha256": hashlib.sha256(SNAPSHOT.read_bytes()).hexdigest(),
        "script_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "versions": {
            "python": platform.python_version(),
            "sklearn": sklearn.__version__,
            "numpy": np.__version__,
        },
        "split": {
            "method": "GroupShuffleSplit",
            "group": "sensor_id",
            "seed": 42,
            "test_size": 0.2,
            "rows": len(rows),
            "sensors": len(set(groups)),
            "train_rows": len(train),
            "test_rows": len(test),
            "train_sensors": len(set(groups[train])),
            "test_sensors": len(set(groups[test])),
            "overlapping_sensors": len(set(groups[train]) & set(groups[test])),
        },
        "train_target_median": median,
        "current_parameters": current.get_params(),
        "variant_override": {"min_samples_leaf": 1},
        "delta_definition": "model minus current_leaf3",
        "partial_dependence": {
            "method": "brute",
            "grid": "51 evenly spaced values between train p05 and p95",
            "background": "all test rows, equally weighted",
            "train_deciles": {
                feature: np.percentile(x[train, col], np.arange(10, 100, 10)).tolist()
                for col, feature in enumerate(FEATURES)
            },
        },
        "metrics": scores,
    }
    output.mkdir(exist_ok=True, parents=True)
    (output / "metrics.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    with (output / "metrics.csv").open("w", newline="", encoding="utf-8") as stream:
        writer = csv.DictWriter(stream, fieldnames=scores[0])
        writer.writeheader()
        writer.writerows(scores)
    write_dependence(output / "partial_dependence.csv", models, x[train], x[test])
    typer.echo(json.dumps({"split": manifest["split"], "metrics": scores}, indent=2))


if __name__ == "__main__":
    typer.run(main)
