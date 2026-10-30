#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = ["numpy", "scikit-learn==1.9.0"]
# ///
# ─── How to run ───
# Install uv: https://docs.astral.sh/uv/getting-started/installation/
# Run from the workspace: uv run work/facility_audit.py
# Or: chmod +x work/facility_audit.py && ./work/facility_audit.py
# ──────────────────
"""Check facility coordinate multiplicity and saved neighbor counts."""

from __future__ import annotations

import csv
import json
from collections import Counter
from pathlib import Path

import numpy as np
from sklearn.neighbors import BallTree


def main() -> None:
    """Compare raw coordinate rows with distinct coordinates, without assuming device IDs."""
    root = Path(__file__).resolve().parent
    source = root / "sources"
    with (source / "test_SDOT_ALL.csv").open(newline="") as handle:
        saved = list(csv.DictReader(handle))
    points = np.array([[float(r["위도"]), float(r["경도"])] for r in saved])
    reports = []
    for name, lat, lon, target in [("securitylights.csv", "LA", "LO", "보안등_개수_25m"),
                                   ("streetlights.csv", "위도", "경도", "가로등_개수_25m")]:
        with (source / name).open(encoding="utf-8-sig", newline="") as handle:
            rows = list(csv.DictReader(handle))
        coords = np.array([[float(r[lat]), float(r[lon])] for r in rows])
        valid = (abs(coords[:, 0]) <= 90) & (abs(coords[:, 1]) <= 180)
        good = coords[valid]
        unique = np.unique(good, axis=0)
        all_counts = BallTree(np.radians(good), metric="haversine").query_radius(
            np.radians(points), r=25 / 6371000, count_only=True)
        unique_counts = BallTree(np.radians(unique), metric="haversine").query_radius(
            np.radians(points), r=25 / 6371000, count_only=True)
        original = np.array([float(r[target]) for r in saved])
        worst = int(np.argmax(original))
        multiplicity = Counter(map(tuple, good))
        reports.append({"file": name, "rows": len(rows), "valid_wgs84_rows": len(good),
                        "invalid_wgs84_rows": int(np.sum(~valid)), "unique_valid_coordinates": len(unique),
                        "maximum_coordinate_multiplicity": max(multiplicity.values()),
                        "saved_count_mismatch_rows": int(np.sum(all_counts != original)),
                        "max_saved_count": int(original.max()), "distinct_coordinate_count_at_saved_max": int(unique_counts[worst]),
                        "max_count_coordinate": points[worst].tolist(),
                        "raw_count_at_saved_max": int(all_counts[worst]),
                        "max_distinct_coordinate_count": int(unique_counts.max())})
    output = {"radius_m": 25, "reports": reports, "note": "Distinct coordinates are not verified unique physical devices."}
    (root / "deep-audit/facility-audit.json").write_text(json.dumps(output, ensure_ascii=False, indent=2))
    print(json.dumps(output, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
