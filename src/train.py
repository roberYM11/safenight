#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = ["numpy==2.3.5", "scikit-learn==1.9.0", "joblib"]
# ///
# ─── How to run ───
# Install uv: https://docs.astral.sh/uv/getting-started/installation/
# Run from the project root: uv run src/train.py
# ──────────────────
"""Compare models on identical held-out coordinates and export real OOF predictions."""

from __future__ import annotations

import csv
import hashlib
import json
import shutil
from pathlib import Path

import joblib
import numpy as np
import sklearn
from sklearn.dummy import DummyRegressor
from sklearn.ensemble import RandomForestRegressor
from sklearn.linear_model import LinearRegression
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
from sklearn.model_selection import GroupKFold
from sklearn.tree import DecisionTreeRegressor

from scoring import FEATURES, components, safety_index


def forest() -> RandomForestRegressor:
    """Reuse original selected parameters; do not tune on these folds."""
    return RandomForestRegressor(
        n_estimators=114, max_depth=18, min_samples_split=2,
        min_samples_leaf=1, max_features=None, bootstrap=True,
        random_state=42, n_jobs=1,
    )


def main() -> None:
    """Export comparable grouped diagnostics and the bundled website dataset."""
    root = Path(__file__).resolve().parents[1]
    input_file = root / "data/processed/restored_observations.csv"
    with input_file.open(newline="", encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))
    x = np.array([[float(row[key]) for key in FEATURES] for row in rows])
    y = safety_index(x)
    groups = np.array([row["lat"] + "," + row["lon"] for row in rows])
    split = list(GroupKFold(n_splits=5).split(x, y, groups))
    benchmarks = []
    rf_predictions = np.zeros(len(y))
    fold_ids = np.zeros(len(y), dtype=int)
    for name, model in (
        ("Training mean", DummyRegressor(strategy="mean")),
        ("Linear regression", LinearRegression()),
        ("Decision tree", DecisionTreeRegressor(max_depth=18, random_state=42)),
        ("Random forest", forest()),
    ):
        predictions = np.zeros(len(y))
        folds = []
        for fold, (train, test) in enumerate(split):
            assert set(groups[train]).isdisjoint(groups[test])
            model.fit(x[train], y[train])
            predictions[test] = model.predict(x[test])
            folds.append(float(np.sqrt(mean_squared_error(y[test], predictions[test]))))
            if name == "Random forest":
                fold_ids[test] = fold
        benchmarks.append({
            "model": name, "rmse": float(np.sqrt(mean_squared_error(y, predictions))),
            "mae": float(mean_absolute_error(y, predictions)),
            "r2": float(r2_score(y, predictions)), "fold_rmse": folds,
        })
        if name == "Random forest":
            rf_predictions = predictions
    contributions = components(x)
    values = []
    for index, row in enumerate(rows):
        values.append({
            "id": row["sensor_id"], "time": row["time"],
            "lat": float(row["lat"]), "lon": float(row["lon"]),
            "features": [float(value) for value in x[index]],
            "target": round(float(y[index]), 6),
            "prediction": round(float(rf_predictions[index]), 6),
            "fold": int(fold_ids[index]),
            "contributions": [round(float(v), 6) for v in contributions[index]],
        })
    summary = {
        "review_date": "2026-10-31", "observed_date": "2025-10-12",
        "rows": len(rows), "coordinates": len(np.unique(groups)),
        "features": FEATURES, "target": "original rule recomputed on restored inputs",
        "validation": "GroupKFold(5), coordinate groups, no hyperparameter search",
        "sklearn_version": sklearn.__version__, "numpy_version": np.__version__,
        "input_sha256": hashlib.sha256(input_file.read_bytes()).hexdigest(),
        "benchmarks": benchmarks,
        "profile": {
            key: {"min": float(x[:, i].min()), "median": float(np.median(x[:, i])),
                  "max": float(x[:, i].max()), "zeros": int(np.sum(x[:, i] == 0))}
            for i, key in enumerate(FEATURES)
        },
    }
    for directory in ("results", "site/data", "models"):
        (root / directory).mkdir(parents=True, exist_ok=True)
    (root / "results/benchmark.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8",
    )
    (root / "site/data/observations.js").write_text(
        "window.SafeNightData=" + json.dumps({"meta": summary, "observations": values},
                                            ensure_ascii=False, separators=(",", ":")) + ";\n",
        encoding="utf-8",
    )
    with (root / "data/processed/predictions.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["sensor_id", "time", "lat", "lon", "rule_index", "oof_prediction", "fold"])
        writer.writerows((r["id"], r["time"], r["lat"], r["lon"], r["target"],
                         r["prediction"], r["fold"]) for r in values)
    shutil.copyfile(root / "data/processed/predictions.csv", root / "site/data/predictions.csv")
    final_model = forest().fit(x, y)
    joblib.dump(final_model, root / "models/random_forest.joblib", compress=3)
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
