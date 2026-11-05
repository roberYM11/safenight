"""Decode the official location workbook using the same boundary as the PostgreSQL importer."""

import json
import sys
from dataclasses import asdict

from safenight_backend.ingestion.locations import parse_locations


def main() -> None:
    """Read one bounded XLSX from stdin and emit only validated locations."""
    points = parse_locations(sys.stdin.buffer.read())
    print(json.dumps([asdict(point) for point in points], separators=(",", ":")))


if __name__ == "__main__":
    main()
