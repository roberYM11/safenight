import modelText from './data/model.json?raw';
import manifestText from './data/manifest.json?raw';
import { assess, loadBundle } from './forest';
import type { Bundle } from './forest';
import { cloudStore } from './cloud/bindings';
import { ModelRegistry } from './pipeline/models';
import { cachedAssessments, persistPoint } from './pipeline/predictions';
import { assessLocation } from './location-assessment';
import type { LocationPoint } from './location-assessment';
import { locationContext } from './context-service';

// Compatibility only until the protected bootstrap imports the already deployed bundle.
let bundledPromise: Promise<Bundle> | undefined;
export function getBundle(): Promise<Bundle> { return bundledPromise ??= loadBundle(modelText, manifestText); }

export async function buildMap(now = new Date()) {
  const store = cloudStore();
  const [active, observations, overview] = await Promise.all([new ModelRegistry(store.db, store.bucket).active(), store.sensors(), store.overview()]);
  const bundle = active?.bundle ?? await getBundle();
  const metadata = bundle.metadata;
  const assessments = active ? await cachedAssessments(store.db, observations.sensors, metadata.version, now)
    : observations.sensors.map(sensor => ({ ...assess(bundle, sensor, now), prediction_id: null }));
  const last = overview.jobs.find(job => job.source === 'sdot' && job.kind === 'collect' && job.status === 'succeeded');
  return {
    generated_at: now.toISOString(), captured_at: last?.finished_at ?? null, data_status: 'cloud',
    data_note: last ? '클라우드에서 수집한 관측자료입니다.' : '클라우드 DB로 이전한 관측자료입니다.',
    model: { name: metadata.name, version: metadata.version, experimental: true, target: metadata.target, features: metadata.features, training_rows: metadata.training_rows, validation_mae: metadata.validation_mae, validation_r2: metadata.validation_r2, validation_note: metadata.validation_note, status: 'ready', generation: active?.generation ?? 0 },
    sensors: observations.sensors.map((sensor, index) => ({ ...sensor, score: assessments[index].score, status: assessments[index].status, prediction_id: assessments[index].prediction_id })),
    total_sensors: observations.total_sensors, unlocated_sensors: observations.unlocated_sensors,
  };
}

export async function assessSensor(sensorId: string, now = new Date()) {
  const store = cloudStore();
  const [active, observations] = await Promise.all([new ModelRegistry(store.db, store.bucket).active(), store.sensors(sensorId)]);
  const feature = observations.sensors[0] ?? null;
  const bundle = active?.bundle ?? await getBundle();
  if (!active || !feature) return assess(bundle, feature, now);
  return (await cachedAssessments(store.db, [feature], bundle.metadata.version, now))[0];
}

export async function assessPoint(point: LocationPoint, now = new Date()) {
  const [map, context] = await Promise.all([buildMap(now), locationContext(point, now)]);
  const result = assessLocation(point, map.sensors, now);
  const store = cloudStore();
  const assessmentId = map.model.generation > 0 ? await persistPoint(store.db, store.bucket, result, map.sensors, context.snapshot_id, now) : null;
  return { ...result, assessment_id: assessmentId, score_inputs: ['lux', 'noise_db'], context };
}
