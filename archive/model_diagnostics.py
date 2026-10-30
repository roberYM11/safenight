#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = ["numpy", "scikit-learn==1.9.0"]
# ///
# ─── How to run ───
# Install uv: https://docs.astral.sh/uv/getting-started/installation/
# Run from the workspace: uv run work/model_diagnostics.py
# Or: chmod +x work/model_diagnostics.py && ./work/model_diagnostics.py
# ──────────────────
"""Compare fixed-model rule reproduction under row and location splits."""

from __future__ import annotations

import csv
import json
from collections import Counter
from pathlib import Path

import numpy as np
import sklearn
from sklearn.ensemble import RandomForestRegressor
from sklearn.metrics import mean_squared_error, r2_score
from sklearn.model_selection import GroupShuffleSplit, train_test_split


def main() -> None:
    """Write measured diagnostics; neither target is an observed safety outcome."""
    root = Path(__file__).resolve().parent
    with (root / "sources/test_SDOT_ALL.csv").open(newline="") as handle:
        old = list(csv.DictReader(handle))
    with (root / "deep-audit/corrected_inputs.csv").open(newline="") as handle:
        fixed = list(csv.DictReader(handle))
    old_columns = ["조도 최대(lux)", "조도 평균(lux)", "조도 최소(lux)", "소음 최대(dB)",
                   "소음 평균(dB)", "소음 최소(dB)", "소음_Std", "CCTV_개수_25m", "가로등_개수_25m", "보안등_개수_25m"]
    fixed_columns = ["lux_max", "lux_avg", "lux_min", "noise_max", "noise_avg", "noise_min",
                     "noise_range_proxy", "cctv", "light", "security"]
    original_x = np.array([[float(r[c]) for c in old_columns] for r in old])
    original_y = np.array([float(r["safety_index"]) for r in old])
    original_groups = np.array([r["위도"] + "," + r["경도"] for r in old])
    fixed_x = np.array([[float(r[c]) for c in fixed_columns] for r in fixed])
    groups = np.array([r["lat"] + "," + r["lon"] for r in fixed])
    lux = fixed_x[:, 1]
    noise = fixed_x[:, 4]
    illum_risk = np.clip(100 - lux / 3, 0, 100)
    noise_risk = np.where(noise < 40, np.clip(100 - noise / 40 * 100, 0, 100),
                          np.where(noise <= 70, np.minimum(20, (noise - 40) / 30 * 20),
                                   np.minimum(100, 20 + (noise - 70) / 40 * 80)))
    traffic_risk = np.where(noise == 0, 50, np.clip(50 - 100 * fixed_x[:, 6] / (noise + 1e-5), 0, 100))
    components = np.column_stack([-0.30 * illum_risk, -0.15 * noise_risk, -0.10 * traffic_risk,
                                  0.25 * np.minimum(100, fixed_x[:, 7] * 25),
                                  0.15 * np.minimum(100, fixed_x[:, 8] * 20),
                                  0.05 * np.minimum(100, fixed_x[:, 9] * 30)])
    fixed_y = np.clip(100 + components.sum(axis=1), 0, 100)
    old_matched_y = np.array([float(r["old_target"]) for r in fixed])
    sensor_times = np.array([r["sensor_id"] + "|" + r["time"] for r in fixed])
    _, first_rows = np.unique(sensor_times, return_index=True)
    unique_rows = np.sort(first_rows)
    reports = []
    for name, x, y, loc in [("original", original_x, original_y, original_groups),
                            ("corrected", fixed_x, fixed_y, groups),
                            ("corrected_deduplicated", fixed_x[unique_rows], fixed_y[unique_rows], groups[unique_rows])]:
        random_train, random_test = train_test_split(np.arange(len(y)), random_state=42, test_size=0.2)
        location_train, location_test = next(GroupShuffleSplit(n_splits=1, test_size=0.2, random_state=42).split(x, y, loc))
        for split, train, test in [("random_rows", random_train, random_test),
                                    ("heldout_locations", location_train, location_test)]:
            model = RandomForestRegressor(n_estimators=114, max_depth=18, min_samples_split=2,
                                          min_samples_leaf=1, max_features=None, bootstrap=True,
                                          random_state=42, n_jobs=1)
            model.fit(x[train], y[train])
            pred = model.predict(x[test])
            seen = set(loc[train])
            vectors = {tuple(row) for row in x[train]}
            reports.append({"data": name, "split": split, "train_rows": len(train), "test_rows": len(test),
                            "seen_location_test_rows": sum(str(v) in seen for v in loc[test]),
                            "seen_feature_vector_test_rows": sum(tuple(v) in vectors for v in x[test]),
                            "rmse": float(np.sqrt(mean_squared_error(y[test], pred))),
                            "r2": float(r2_score(y[test], pred)),
                            "training_mean_rmse": float(np.sqrt(mean_squared_error(y[test], np.full(len(test), y[train].mean()))))})
    summary = {"sklearn_version": sklearn.__version__, "numpy_version": np.__version__, "experiments": reports,
               "corrected_score": {"rows": len(fixed), "min": float(fixed_y.min()), "max": float(fixed_y.max()),
                                   "mean": float(fixed_y.mean()), "median": float(np.median(fixed_y)),
                                   "mean_absolute_change_from_old": float(np.mean(np.abs(fixed_y - old_matched_y))),
                                   "pearson_correlation": float(np.corrcoef(fixed_y, old_matched_y)[0, 1]),
                                   "zero_lux_rows": int(np.sum(lux == 0)),
                                   "unique_locations": len(np.unique(groups)),
                                   "unique_sensor_time": len({(r["sensor_id"], r["time"]) for r in fixed})},
               "component_variances_corrected": dict(zip(["illum", "noise", "traffic", "cctv", "light", "security"],
                                                         [float(v) for v in components.var(axis=0)], strict=True)),
               "sensor_time_repeats": dict(Counter(Counter((r["sensor_id"], r["time"]) for r in fixed).values()))}
    (root / "deep-audit/model-diagnostics.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2))
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
