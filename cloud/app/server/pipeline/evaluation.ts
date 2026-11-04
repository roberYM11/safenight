import { z } from 'zod';
import { loadBundle, predict, supports } from '../forest.ts';
import type { Bundle } from '../forest.ts';
import { PipelineError } from './objects.ts';
import { canonicalJson, sha256 } from '../cloud/contracts.ts';
import type { FrozenDataset } from './datasets.ts';

const splitKind = z.enum(['sensor', 'time', 'region']);
const evaluationPolicy = { min_train_rows: 100, min_test_rows: 30, min_train_sensors: 5, min_test_sensors: 2, min_support_rate: 0.95 } as const;
export const candidateSchema = z.object({
  run_id: z.string().min(1), model_text: z.string().max(12 * 1024 * 1024), manifest_text: z.string().max(1024 * 1024),
  evaluations: z.array(z.object({ kind: splitKind, train_ids: z.array(z.string()).min(2).max(10000), test_ids: z.array(z.string()).min(2).max(10000),
    model_text: z.string().max(12 * 1024 * 1024), manifest_text: z.string().max(1024 * 1024) }).strict()).max(3),
}).strict();
export type Candidate = z.infer<typeof candidateSchema>;
const tile = (lat: number | null, lon: number | null) => `${Math.floor((lat ?? 0) * 50)}:${Math.floor((lon ?? 0) * 50)}`;
export async function expectedSplit(dataset: FrozenDataset, kind: z.infer<typeof splitKind>) {
  const rows = dataset.rows;
  switch (kind) {
    case 'sensor': case 'region': {
      const key = (row: FrozenDataset['rows'][number]) => kind === 'sensor' ? row.feature.sensor_id : tile(row.feature.lat, row.feature.lon);
      const groups = await Promise.all([...new Set(rows.map(key))].map(async value => ({ value, digest: await sha256(new TextEncoder().encode(`42:${value}`)) })));
      groups.sort((a, b) => a.digest.localeCompare(b.digest));
      if (groups.length < 2) return { train: [], test: [] };
      const testing = new Set(groups.slice(0, Math.ceil(groups.length / 5)).map(group => group.value));
      return { train: rows.filter(row => !testing.has(key(row))), test: rows.filter(row => testing.has(key(row))) };
    }
    case 'time': {
      const days = [...new Set(rows.map(row => row.feature.observed_at.slice(0, 10)))].sort();
      if (days.length < 2) return { train: [], test: [] };
      const test = rows.filter(row => row.feature.observed_at.slice(0, 10) === days[days.length - 1]);
      const first = test.reduce((time, row) => row.feature.observed_at < time ? row.feature.observed_at : time, '9999');
      return { train: rows.filter(row => row.feature.observed_at < first && row.feature_available_at <= first && row.target_available_at <= first), test };
    }
    default: return unreachable(kind);
  }
}
function metrics(truth: readonly number[], predictions: readonly number[]) {
  const absolute = truth.map((value, i) => Math.abs(value - predictions[i]));
  return { mae: absolute.reduce((a, b) => a + b, 0) / truth.length, rmse: Math.sqrt(absolute.reduce((a, b) => a + b * b, 0) / truth.length) };
}

/** Recompute metrics from frozen labels and numerical evaluation forests; don't trust reported scores. */
export async function evaluateCandidate(candidate: Candidate, dataset: FrozenDataset, incumbent: Bundle, final: Bundle) {
  const reasons: string[] = [];
  const evidence = [];
  const lookup = new Map(dataset.rows.map(row => [row.feature_snapshot_id, row]));
  if (new Set(candidate.evaluations.map(e => e.kind)).size !== candidate.evaluations.length) throw new PipelineError('duplicate_evaluation_kind');
  for (const kind of ['sensor', 'time', 'region']) if (!candidate.evaluations.some(e => e.kind === kind)) reasons.push(`missing_${kind}_evaluation`);
  for (const evaluation of candidate.evaluations) {
    const expected = await expectedSplit(dataset, evaluation.kind);
    const sameIds = (ids: readonly string[], rows: typeof expected.train) => JSON.stringify([...ids].sort()) === JSON.stringify(rows.map(row => row.feature_snapshot_id).sort());
    if (!sameIds(evaluation.train_ids, expected.train) || !sameIds(evaluation.test_ids, expected.test)) throw new PipelineError('evaluation_membership_mismatch');
    const train = evaluation.train_ids.map(id => lookup.get(id));
    const test = evaluation.test_ids.map(id => lookup.get(id));
    if (train.some(row => row === undefined) || test.some(row => row === undefined)) throw new PipelineError('evaluation_unknown_feature');
    const training = train.filter(row => row !== undefined), testing = test.filter(row => row !== undefined);
    if (training.length < evaluationPolicy.min_train_rows || testing.length < evaluationPolicy.min_test_rows
      || new Set(training.map(row => row.feature.sensor_id)).size < evaluationPolicy.min_train_sensors
      || new Set(testing.map(row => row.feature.sensor_id)).size < evaluationPolicy.min_test_sensors) reasons.push(`${evaluation.kind}_insufficient_samples`);
    if (new Set([...evaluation.train_ids, ...evaluation.test_ids]).size !== train.length + test.length) throw new PipelineError('evaluation_overlap');
    if (training.some(row => row.feature.lux === null || row.feature.noise_db === null) || testing.some(row => row.feature.lux === null || row.feature.noise_db === null)) throw new PipelineError('evaluation_missing_input');
    switch (evaluation.kind) {
      case 'sensor': {
        const groups = new Set(training.map(row => row.feature.sensor_id));
        if (testing.some(row => groups.has(row.feature.sensor_id))) throw new PipelineError('sensor_evaluation_leakage');
        break;
      }
      case 'region': {
        const groups = new Set(training.map(row => tile(row.feature.lat, row.feature.lon)));
        if (testing.some(row => groups.has(tile(row.feature.lat, row.feature.lon)))) throw new PipelineError('region_evaluation_leakage');
        break;
      }
      case 'time': {
        const firstTest = testing.reduce((time, row) => row.feature.observed_at < time ? row.feature.observed_at : time, '9999');
        if (training.some(row => row.feature.observed_at >= firstTest || row.target_available_at > firstTest || row.feature_available_at > firstTest)) throw new PipelineError('time_evaluation_leakage');
        break;
      }
      default: return unreachable(evaluation.kind);
    }
    const model = await loadBundle(evaluation.model_text, evaluation.manifest_text, { allowGroupOverlap: evaluation.kind === 'time' });
    const trainGroups = [...new Set(training.map(row => row.feature.sensor_id))].sort();
    const testGroups = [...new Set(testing.map(row => row.feature.sensor_id))].sort();
    const locations = [...new Map(training.map(row => [row.feature.sensor_id, { sensor_id: row.feature.sensor_id, lat: row.feature.lat, lon: row.feature.lon }])).values()].sort((a, b) => a.sensor_id < b.sensor_id ? -1 : a.sensor_id > b.sensor_id ? 1 : 0);
    if (canonicalJson(model.payload.locations) !== canonicalJson(locations) || model.metadata.training_rows !== training.length
      || canonicalJson(model.metadata.train_groups) !== canonicalJson(trainGroups) || canonicalJson(model.metadata.test_groups) !== canonicalJson(testGroups)) throw new PipelineError('evaluation_artifact_membership_mismatch');
    const truth = testing.map(row => row.target_value);
    const labels = training.map(row => row.target_value).sort((a, b) => a - b);
    const mean = labels.reduce((a, b) => a + b, 0) / labels.length;
    const middle = Math.floor(labels.length / 2);
    const median = labels.length % 2 ? labels[middle] : (labels[middle - 1] + labels[middle]) / 2;
    const predictions = testing.map(row => predict(model, row.feature.lux ?? 0, row.feature.noise_db ?? 0));
    const candidateMetrics = metrics(truth, predictions);
    const meanMetrics = metrics(truth, truth.map(() => mean)), medianMetrics = metrics(truth, truth.map(() => median));
    const supported = testing.filter(row => supports(final, row.feature)).length / testing.length;
    const common = testing.filter(row => supports(incumbent, row.feature));
    const incumbentMetrics = common.length ? metrics(common.map(row => row.target_value), common.map(row => predict(incumbent, row.feature.lux ?? 0, row.feature.noise_db ?? 0))) : null;
    const commonMetrics = common.length ? metrics(common.map(row => row.target_value), common.map(row => predict(model, row.feature.lux ?? 0, row.feature.noise_db ?? 0))) : null;
    if (candidateMetrics.mae >= Math.min(meanMetrics.mae, medianMetrics.mae) || candidateMetrics.rmse >= Math.min(meanMetrics.rmse, medianMetrics.rmse)) reasons.push(`${evaluation.kind}_baseline_not_beaten`);
    if (supported < evaluationPolicy.min_support_rate) reasons.push(`${evaluation.kind}_support_below_threshold`);
    if (commonMetrics && incumbentMetrics && (commonMetrics.mae > incumbentMetrics.mae || commonMetrics.rmse > incumbentMetrics.rmse)) reasons.push(`${evaluation.kind}_incumbent_regression`);
    evidence.push({ kind: evaluation.kind, train_rows: training.length, test_rows: testing.length, candidate: candidateMetrics, mean: meanMetrics, median: medianMetrics, support_rate: supported, incumbent: incumbentMetrics, common_candidate: commonMetrics, incumbent_comparison_rows: common.length });
  }
  return { passed: reasons.length === 0, reasons, evaluations: evidence, incumbent_version: incumbent.metadata.version, policy_version: 'sensor-time-region-v1', thresholds: evaluationPolicy };
}
function unreachable(value: never): never { throw new PipelineError(`unknown_evaluation_${String(value)}`); }
