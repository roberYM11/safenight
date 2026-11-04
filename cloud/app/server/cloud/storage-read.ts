import { z } from 'zod';
import { sha256, sourceSchema } from './contracts.ts';
import { featureSchema } from '../forest.ts';
import { jobSchema } from './storage-rows.ts';

export type CloudSensor=z.infer<typeof featureSchema> & {readonly district:string;readonly neighborhood:string;readonly lat:number;readonly lon:number};
const selectedSchema=z.object({
  entity_id:z.string(),observed_at:z.string(),revision_id:z.string(),payload_json:z.string(),
  location_id:z.string().nullable(),lat:z.number().nullable(),lon:z.number().nullable(),location_payload:z.string().nullable(),
});
const measured=z.object({lux:z.number().finite().nonnegative().nullable(),noise_db:z.number().finite().min(0).max(200).nullable(),AUTONOMOUS_DISTRICT:z.string().nullish(),ADMINISTRATIVE_DISTRICT:z.string().nullish()});
const located=z.object({district:z.string().nullish(),neighborhood:z.string().nullish()});
const latest=`WITH selected AS (
 SELECT r.* FROM latest_observations c JOIN observation_revisions r ON r.id=c.revision_id WHERE c.source='sdot'
)
 SELECT s.entity_id,s.observed_at,s.id AS revision_id,s.payload_json,p.id AS location_id,p.lat,p.lon,p.payload_json AS location_payload
 FROM selected s LEFT JOIN observation_revisions p ON p.id=(
 SELECT l.revision_id FROM current_observations l WHERE l.source='sensor_locations' AND l.entity_id=s.entity_id AND l.observed_at<=s.observed_at ORDER BY l.observed_at DESC LIMIT 1
 ) ORDER BY s.entity_id`;

/** Resolve only published revisions and the location effective at observation time. */
export async function readSensors(db:D1Database):Promise<{readonly sensors:readonly CloudSensor[];readonly total_sensors:number;readonly unlocated_sensors:number}> {
  const rows=z.array(selectedSchema).parse((await db.prepare(latest).all()).results);
  const output=await Promise.all(rows.map(async row=>{
    if (row.lat===null || row.lon===null || row.location_id===null || row.location_payload===null) return null;
    const data=measured.parse(JSON.parse(row.payload_json));
    const location=located.parse(JSON.parse(row.location_payload));
    const feature_revision=await sha256(new TextEncoder().encode(`${row.revision_id}:${row.location_id}:environment-v1`));
    return {...featureSchema.parse({sensor_id:row.entity_id,observed_at:row.observed_at,lat:row.lat,lon:row.lon,lux:data.lux,noise_db:data.noise_db,feature_version:'environment-v1',feature_revision}),lat:row.lat,lon:row.lon,district:data.AUTONOMOUS_DISTRICT??location.district??'',neighborhood:data.ADMINISTRATIVE_DISTRICT??location.neighborhood??''};
  }));
  const sensors=output.filter(row=>row!==null);
  return {sensors,total_sensors:rows.length,unlocated_sensors:rows.length-sensors.length};
}

/** Bounded operational readback; excludes raw payloads and lease tokens. */
export async function readOverview(db:D1Database) {
  const counts=await db.prepare(`SELECT (SELECT COUNT(*) FROM raw_objects) raw_objects,(SELECT COUNT(*) FROM observation_revisions) observation_revisions,(SELECT COUNT(*) FROM current_observations) current_observations,(SELECT COUNT(*) FROM collection_jobs) jobs`).first();
  const countSchema=z.object({raw_objects:z.number(),observation_revisions:z.number(),current_observations:z.number(),jobs:z.number()});
  const checkpoints=z.array(z.object({source:sourceSchema,covered_until:z.string()})).parse((await db.prepare('SELECT * FROM source_checkpoints ORDER BY source').all()).results);
  const jobs=z.array(jobSchema).parse((await db.prepare('SELECT * FROM collection_jobs ORDER BY created_at DESC,id DESC LIMIT 30').all()).results);
  return {counts:countSchema.parse(counts),checkpoints,jobs};
}
