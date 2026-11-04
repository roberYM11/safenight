import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { ArtifactError, assess, distanceMeters, featureSchema, loadBundle, predict } from "../app/server/forest.ts";

const modelText = await readFile(new URL("../app/server/data/model.json", import.meta.url), "utf8");
const manifestText = await readFile(new URL("../app/server/data/manifest.json", import.meta.url), "utf8");
const parity = JSON.parse(await readFile(new URL("./serving-parity.json", import.meta.url), "utf8"));
const bundle = await loadBundle(modelText, manifestText);
const now = new Date(parity.assessed_at);
const scored = parity.cases.find(row => row.expected_status === "SCORED");
assert.ok(scored);
const feature = featureSchema.parse(scored.feature);

for (const kind of ["actual", "threshold-adjacent"]) {
  test(`matches Python scores and abstention for ${kind} inputs`, () => {
    // Given: independently generated Python results and the same verified artifact.
    const cases = parity.cases.filter(row => row.kind === kind);
    // When: apply the hosted inference boundary to each original feature vector.
    const results = cases.map(row => assess(bundle, featureSchema.parse(row.feature), now));
    // Then: preserve statuses and unrounded numerical predictions.
    for (const [index, result] of results.entries()) {
      const expected = cases[index];
      assert.equal(result.status, expected.expected_status, `${kind} ${index}`);
      if (expected.expected_score === null) assert.equal(result.score, null);
      else {
        assert.equal(typeof result.score, "number");
        assert.ok(Math.abs(result.score - expected.expected_score) < 1e-12, `${kind} ${index}`);
      }
    }
  });
}

test("expires a previously scored observation after thirty hours", () => {
  // Given: a supported observation and the first millisecond beyond its lifetime.
  const later = new Date(Date.parse(feature.observed_at) + 30 * 3600000 + 1);
  // When: assess the unchanged observation at that time.
  const result = assess(bundle, feature, later);
  // Then: no old numeric score remains available.
  assert.equal(result.status, "STALE");
  assert.equal(result.score, null);
});

test("retains a score at the inclusive thirty-hour boundary", () => {
  // Given: a supported observation exactly at its maximum age.
  const boundary = new Date(Date.parse(feature.observed_at) + 30 * 3600000);
  // When: assess at the inclusive boundary.
  const result = assess(bundle, feature, boundary);
  // Then: the original score is still available.
  assert.equal(result.status, "SCORED");
  assert.ok(Math.abs(result.score - scored.expected_score) < 1e-12);
});

test("rejects a changed artifact byte before inference", async () => {
  // Given: the original manifest paired with altered model bytes.
  const changed = `${modelText} `;
  // When / Then: loading fails with the integrity error.
  await assert.rejects(loadBundle(changed, manifestText), error => error instanceof ArtifactError && error.code === "artifact_digest_mismatch");
});

test("rejects a digest-valid cyclic tree", async () => {
  // Given: a malformed self-reference and a matching digest.
  const malformed = JSON.parse(modelText);
  malformed.trees[0][0].left = 0;
  const body = JSON.stringify(malformed);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)));
  const digest = Array.from(hash, value => value.toString(16).padStart(2, "0")).join("");
  const metadata = { ...JSON.parse(manifestText), artifact_sha256: digest, version: `rf-environment-v1-${digest.slice(0, 12)}` };
  // When / Then: structural validation still refuses the model.
  await assert.rejects(loadBundle(body, JSON.stringify(metadata)), error => error instanceof ArtifactError && error.code === "invalid_tree_reference");
});

for (const [name, changes, expected] of [
  ["missing measurement", { lux: null }, "DATA_UNAVAILABLE"],
  ["out-of-domain measurement", { lux: 468 }, "UNSUPPORTED"],
  ["unknown sensor", { sensor_id: "not-trained" }, "UNSUPPORTED"],
  ["moved sensor", { lat: feature.lat + 0.01 }, "UNSUPPORTED"],
  ["future observation", { observed_at: new Date(now.getTime() + 1000).toISOString() }, "UNSUPPORTED"],
  ["changed feature contract", { feature_version: "environment-v2" }, "SCHEMA_MISMATCH"],
]) {
  test(`abstains for ${name}`, () => {
    // Given: one changed input on an otherwise valid feature vector.
    const changed = featureSchema.parse({ ...feature, ...changes });
    // When: apply the normal serving policy.
    const result = assess(bundle, changed, now);
    // Then: emit the declared state without a number.
    assert.equal(result.status, expected);
    assert.equal(result.score, null);
  });
}

test("preserves stale precedence over missing measurements", () => {
  // Given: a stale observation with a missing measurement.
  const changed = featureSchema.parse({ ...feature, lux: null });
  const later = new Date(Date.parse(feature.observed_at) + 31 * 3600000);
  // When: assess it.
  const result = assess(bundle, changed, later);
  // Then: source age remains the first applicable reason.
  assert.equal(result.status, "STALE");
});

test("abstains when no model is loaded", () => {
  // Given: no loaded model.
  // When: assess a valid input.
  const result = assess(null, feature, now);
  // Then: no numeric estimate is manufactured.
  assert.equal(result.status, "MODEL_UNAVAILABLE");
  assert.equal(result.score, null);
});

test("abstains when no observation exists", () => {
  // Given: a verified model but no observation.
  // When: assess the absent observation.
  const result = assess(bundle, null, now);
  // Then: the missing-data state is explicit.
  assert.equal(result.status, "DATA_UNAVAILABLE");
  assert.equal(result.score, null);
});

test("threshold fixtures exercise float32 rounding rather than only rounded scores", () => {
  // Given: Python threshold-adjacent reference vectors.
  const cases = parity.cases.filter(row => row.kind === "threshold-adjacent" && row.expected_status === "SCORED");
  // When: compare the correct inference with an intentionally float64-only traversal.
  const mismatches = cases.filter(row => {
    const values = [row.feature.lux, row.feature.noise_db];
    const naive = bundle.payload.trees.reduce((sum, tree) => {
      let node = tree[0];
      while (node.left !== -1) node = tree[values[node.feature] <= node.threshold ? node.left : node.right];
      return sum + node.value;
    }, 0) / bundle.payload.trees.length;
    return Math.abs(naive - predict(bundle, ...values)) > 1e-12;
  });
  // Then: removing float32 conversion would break this fixture corpus.
  assert.ok(mismatches.length > 0);
});
