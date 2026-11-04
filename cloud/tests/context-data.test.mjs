import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseContextDataset, summarizeContext } from "../app/server/context-data.ts";
import { distanceMeters } from "../app/server/forest.ts";

const snapshot = JSON.parse(await readFile(new URL("../app/server/data/context-facilities.json", import.meta.url), "utf8"));

test("Jamsil Station has source-backed lighting and camera quantities with their distinct units", () => {
  const result = summarizeContext({ lat: 37.5133, lon: 127.1001 });
  assert.equal(result.usage, "CONTEXT_ONLY");
  assert.equal(result.score_included, false);
  for (const group of result.groups) {
    assert.equal(group.status, "AVAILABLE");
    assert.ok(group.count > 0);
    assert.equal(group.nearest.length, 3);
    assert.ok(group.nearest.every(row => row.distance_m <= 1000 && row.source_id === (group.kind === "cctv" ? "songpa-cctv" : "songpa-lights")));
  }
  assert.equal(result.sources.find(row => row.id === "songpa-lights").reference_date, "2021-11-22");
  assert.equal(result.sources.find(row => row.id === "seocho-lights").reference_date, "2024-05-13");
  assert.deepEqual(result.groups.map(({ kind, count, record_count, unit }) => ({ kind, count, record_count, unit })), [
    { kind: "streetlight", count: 423, record_count: 423, unit: "개" },
    { kind: "security_light", count: 595, record_count: 595, unit: "개" },
    { kind: "cctv", count: 479, record_count: 184, unit: "대" },
  ]);
  assert.equal(result.sources.find(row => row.id === "songpa-cctv").reference_date, "2026-05-01");
});

test("a location with no source coverage returns unknown counts, never a false zero or score", () => {
  const result = summarizeContext({ lat: 37.57, lon: 126.9768 });
  for (const group of result.groups) {
    assert.equal(group.status, "NO_RECORDS"); assert.equal(group.count, null); assert.deepEqual(group.nearest, []);
  }
  assert.equal("score" in result, false);
});

test("radius filters known source records, includes coincident fixtures, and sorts nearest independently", () => {
  const source = { ...snapshot.sources[0], source_rows: 5, accepted_rows: 5, rejected_rows: 0 };
  const rows = [
    [source.id, "streetlight", "far", "far", 37.501, 127.1, null],
    [source.id, "streetlight", "origin", "origin", 37.5, 127.1, null],
    [source.id, "streetlight", "near", "near", 37.5001, 127.1, null],
    [source.id, "streetlight", "middle", "middle", 37.5002, 127.1, null],
    [source.id, "security_light", "security", "security", 37.5, 127.1, null],
  ];
  const dataset = parseContextDataset({ format: snapshot.format, sources: [source], facilities: rows });
  const small = summarizeContext({ lat: 37.5, lon: 127.1 }, 20, dataset);
  assert.equal(small.groups[0].count, 2);
  assert.deepEqual(small.groups[0].nearest.map(row => row.id), ["origin", "near"]);
  assert.equal(small.groups[0].nearest[0].distance_m, 0);
  const larger = summarizeContext({ lat: 37.5, lon: 127.1 }, 200, dataset);
  assert.equal(larger.groups[0].count, 4);
  assert.deepEqual(larger.groups[0].nearest.map(row => row.id), ["origin", "near", "middle"]);
});

test("snapshot provenance validation rejects untraceable, duplicate, and incorrect records", () => {
  assert.throws(() => parseContextDataset({ ...snapshot, facilities: [["unknown", ...snapshot.facilities[0].slice(1)]] }));
  assert.throws(() => parseContextDataset({ ...snapshot, facilities: [...snapshot.facilities, snapshot.facilities[0]] }));
  assert.throws(() => parseContextDataset({ ...snapshot, facilities: [[...snapshot.facilities[0].slice(0, 4), 0, 0, null]] }));
});

test("invalid requests cannot bypass distance filtering", () => {
  for (const radius of [NaN, Infinity, 0, -1, 5001]) assert.throws(() => summarizeContext({ lat: 37.5, lon: 127.1 }, radius));
  assert.throws(() => summarizeContext({ lat: NaN, lon: 127.1 }));
  assert.throws(() => summarizeContext({ lat: 91, lon: 127.1 }));
});

test("CCTV count sums source camera quantities instead of counting installation records", () => {
  const source = { ...snapshot.sources.find(source => source.id === "songpa-cctv"), source_rows: 3, accepted_rows: 3, rejected_rows: 0 };
  const dataset = parseContextDataset({ format: snapshot.format, sources: [source], facilities: [
    [source.id, "cctv", "one", "one", 37.5, 127.1, null, 1, "2026-05-01"],
    [source.id, "cctv", "four", "four", 37.5001, 127.1, null, 4, "2026-05-01"],
    [source.id, "cctv", "outside", "outside", 37.51, 127.1, null, 9, "2026-05-01"],
  ] });
  const result = summarizeContext({ lat: 37.5, lon: 127.1 }, 200, dataset).groups.find(group => group.kind === "cctv");
  assert.equal(result.count, 5);
  assert.equal(result.record_count, 2);
  assert.equal(result.unit, "대");
  assert.deepEqual(result.nearest.map(row => row.camera_count), [1, 4]);
});

test("CCTV never accepts a missing, fractional, negative, or unobserved camera quantity", () => {
  const source = { ...snapshot.sources.find(source => source.id === "songpa-cctv"), source_rows: 1, accepted_rows: 1, rejected_rows: 0 };
  for (const count of [undefined, 0, -1, 1.5, NaN]) {
    assert.throws(() => parseContextDataset({ format: snapshot.format, sources: [source], facilities: [
      [source.id, "cctv", "bad", "bad", 37.5, 127.1, null, count, "2026-05-01"],
    ] }));
  }
});

test("bounding-box prefilter preserves exact circular facility counts", () => {
  const positions = [{ lat: 37.5133, lon: 127.1001 }, { lat: 37.4837, lon: 127.0324 }, { lat: 37.57, lon: 126.9768 }];
  for (const point of positions) for (const radius of [1, 100, 1000, 5000]) {
    const result = summarizeContext(point, radius);
    const exact = snapshot.facilities.filter(row => distanceMeters(point.lat, point.lon, row[4], row[5]) <= radius);
    for (const group of result.groups) {
      const records = exact.filter(row => row[1] === group.kind);
      assert.equal(group.record_count, records.length || null);
      assert.equal(group.count, records.length ? records.reduce((count, row) => count + (row[1] === "cctv" ? row[7] : 1), 0) : null);
    }
  }
});
