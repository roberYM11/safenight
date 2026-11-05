#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = ["matplotlib==3.11.2"]
# ///
# ─── How to run ───
# After compare_models.py, run this script with a Python that has Matplotlib.
# Alternatively, use: uv run --script docs/model-analysis/plot_pdp.py

"""Render the two held-out forests' partial dependence from the saved numeric evidence."""

from __future__ import annotations

import csv
import json
from pathlib import Path

from matplotlib.backends.backend_agg import FigureCanvasAgg
from matplotlib.figure import Figure


def main() -> None:
    """Plot on common vertical axes and show training density with decile ticks."""
    directory = Path(__file__).resolve().parent
    metadata = json.loads((directory / "metrics.json").read_text(encoding="utf-8"))
    with (directory / "partial_dependence.csv").open(
        newline="", encoding="utf-8"
    ) as stream:
        rows = list(csv.DictReader(stream))
    figure = Figure(figsize=(10.8, 5.2), layout="constrained", facecolor="white")
    FigureCanvasAgg(figure)
    figure.suptitle(
        "Partial dependence of the environment score",
        fontsize=17,
        x=0.03,
        ha="left",
    )
    axes = figure.subplots(1, 2, sharey=True)
    axes[0].set_ylabel("Mean predicted score (points out of 100)")
    styles = (
        ("current_leaf3", "Current RF · leaf minimum 3", "#007067", "solid"),
        ("variant_leaf1", "Variant RF · leaf minimum 1", "#9e471b", "dashed"),
    )
    for ax, (feature, label) in zip(
        axes,
        (("lux", "Illuminance (lx)"), ("noise_db", "Noise level (dB)")),
        strict=True,
    ):
        panel = [row for row in rows if row["feature"] == feature]
        grid = [float(row["value"]) for row in panel]
        for model, name, color, style in styles:
            ax.plot(
                grid,
                [float(row[model]) for row in panel],
                label=name,
                color=color,
                linestyle=style,
                linewidth=2.1,
            )
        ax.set_xlabel(label)
        ax.spines[["top", "right"]].set_visible(False)
        ax.grid(axis="y", color="#e3e6e5")
        ax.set_axisbelow(True)
        deciles = sorted(set(metadata["partial_dependence"]["train_deciles"][feature]))
        ax.plot(
            deciles,
            [0] * len(deciles),
            "|",
            ms=10,
            color="#515d5c",
            transform=ax.get_xaxis_transform(),
        )
    figure.legend(
        *axes[0].get_legend_handles_labels(),
        loc="outside upper right",
        ncols=2,
        frameon=False,
        fontsize=9,
    )
    n_test = metadata["split"]["test_rows"]
    figure.supxlabel(
        f"Brute partial dependence over {n_test:,} held-out sensor readings. "
        "Grid spans training percentiles 5 to 95.\n"
        "Short marks show training deciles (coincident marks overlap).",
        fontsize=9,
        color="#414d4c",
        x=0.035,
        ha="left",
    )
    figure.savefig(directory / "partial_dependence.png", dpi=160)


if __name__ == "__main__":
    main()
