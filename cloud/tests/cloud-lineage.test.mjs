import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { Miniflare } from 'miniflare';
import { CloudStore } from '../app/server/cloud/store.ts';
import { cloudRecord } from '../app/server/cloud/contracts.ts';
import { readSensorsAt } from '../app/server/cloud/storage-read.ts';

const now=new Date('2026-11-04T06:00:00.000Z');
const names=(await readdir(new URL('../drizzle/',import.meta.url))).filter(n=>n.endsWith('.sql')).sort();
const migrations=await Promise.all(names.map(n=>readFile(new URL(`../drizzle/${n}`,import.meta.url),'utf8')));
async function migrate(db,sql) {
  await db.batch(sql.split('--> statement-breakpoint').map(s=>s.trim()).filter(Boolean).map(s=>db.prepare(s)));
}
async function usingStore(run,upgrade=false) {
  const mf=new Miniflare({modules:true,script:'export default { fetch() { return new Response("test"); } }',compatibilityDate:'2026-05-15',d1Databases:['DB'],r2Buckets:['BUCKET']});
  try {
    const db=await mf.getD1Database('DB');
    for(const sql of upgrade ? migrations.slice(0,4) : migrations) await migrate(db,sql);
    await run(new CloudStore(db,await mf.getR2Bucket('BUCKET')),db);
  } finally { await mf.dispose(); }
}
async function stage(store,source,at,{rank=1,lux=12,lat=null,lon=null}={}) {
  const raw=await store.archive(source,new TextEncoder().encode(`${source}:${rank}:${lux}:${lat}`),at);
  const row=await cloudRecord(source,{entity_id:'sensor-a',observed_at:'2026-11-03T14:00:00.000Z',published_at:'2026-11-03T14:01:00.000Z',revision_rank:rank,source_updated_at:null,payload_json:JSON.stringify({lux,noise_db:50}),lat,lon},raw,at);
  const job=await store.start({source,day:'2026-11-03',kind:'import',expected_count:1},at);
  await store.claim(job.id,'worker',at);
  await store.stage(job.id,'worker',{records:[row],total_count:1,page_no:1,page_size:200},at);
  return job;
}
async function publish(store,source,at,options) {
  const job=await stage(store,source,at,options);
  await store.publish(job.id,'worker',at);
  return job;
}

test('reconstructs old measurement and position when corrections are published later',()=>usingStore(async(store,db)=>{
  // Given: released inputs followed by a staged correction.
  await publish(store,'sensor_locations',now,{lat:37.57,lon:126.89});
  await publish(store,'sdot',now);
  const later=new Date(now.getTime()+1000);
  const correction=await stage(store,'sdot',later,{rank:2,lux:90});
  assert.equal((await readSensorsAt(db,later)).sensors[0].lux,12);
  await store.publish(correction.id,'worker',later);
  await publish(store,'sensor_locations',later,{rank:2,lat:37.58,lon:126.90});
  // When: reconstructing both visibility cutoffs after the corrections.
  const before=await readSensorsAt(db,now);
  const after=await readSensorsAt(db,later);
  // Then: neither observation nor position corrections leak into old features.
  assert.deepEqual(before.sensors.map(s=>[s.lux,s.lat]),[[12,37.57]]);
  assert.deepEqual(after.sensors.map(s=>[s.lux,s.lat]),[[90,37.58]]);
  assert.notEqual(before.sensors[0].feature_revision,after.sensors[0].feature_revision);
  assert.equal((await readSensorsAt(db,new Date(now.getTime()-1))).total_sensors,0);
}));

test('persists one downstream job when publication is retried',()=>usingStore(async(store,db)=>{
  // Given: staged input without visible history or follow-up work.
  const job=await stage(store,'sdot',now);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM derivation_jobs').first()).n,0);
  // When: publishing then retrying a lost success response.
  await store.publish(job.id,'worker',now);
  await store.publish(job.id,'worker',new Date(now.getTime()+1000));
  // Then: visibility, selection and pending work are one durable unit.
  const rows=(await db.prepare(`SELECT j.status,p.available_at,s.revision_id FROM derivation_jobs j
    JOIN observation_publications p ON p.sequence=j.publication_sequence
    JOIN observation_selections s ON s.publication_sequence=p.sequence`).all()).results;
  assert.equal(rows.length,1);
  assert.equal(rows[0].status,'pending');
  assert.equal(rows[0].available_at,now.toISOString());
}));

test('rolls back pointers and history when downstream enqueue fails',()=>usingStore(async(store,db)=>{
  // Given: a key conflict late in the publication batch.
  const job=await stage(store,'sdot',now);
  await db.prepare("INSERT INTO derivation_jobs(id,kind,input_version,created_at,updated_at) VALUES(?,'features',?,?,?)")
    .bind(`derive:${job.id}`,`publication:${job.id}`,now.toISOString(),now.toISOString()).run();
  // When: publication encounters that conflict.
  await assert.rejects(()=>store.publish(job.id,'worker',now),/UNIQUE/);
  // Then: all public state rolls back and the staged job remains resumable.
  assert.equal((await store.get(job.id)).status,'running');
  for(const table of ['current_observations','latest_observations','observation_publications','observation_selections','source_checkpoints']) {
    assert.equal((await db.prepare(`SELECT COUNT(*) n FROM ${table}`).first()).n,0);
  }
}));

test('preserves populated old tables on upgrade without inventing publication times',()=>usingStore(async(store,db)=>{
  // Given: the existing four-migration database with a selected revision.
  const job=await stage(store,'sensor_locations',now,{lat:37.57,lon:126.89});
  await db.prepare('INSERT INTO current_observations SELECT source,entity_id,observed_at,id FROM observation_revisions').run();
  await db.prepare("UPDATE collection_jobs SET status='succeeded',lease_token=NULL,lease_until=NULL WHERE id=?").bind(job.id).run();
  const measurement=await stage(store,'sdot',now);
  await db.prepare("INSERT INTO current_observations SELECT source,entity_id,observed_at,id FROM observation_revisions WHERE source='sdot'").run();
  await db.prepare("UPDATE collection_jobs SET status='succeeded',lease_token=NULL,lease_until=NULL WHERE id=?").bind(measurement.id).run();
  await db.prepare('INSERT INTO latest_observations SELECT * FROM current_observations').run();
  const servingBefore=await store.sensors();
  const before=(await db.prepare('SELECT * FROM current_observations').all()).results;
  // When: applying the additive migration.
  for(const sql of migrations.slice(4)) await migrate(db,sql);
  // Then: the old pointer survives without fabricated historical timestamps.
  assert.deepEqual((await db.prepare('SELECT * FROM current_observations').all()).results,before);
  assert.deepEqual(await store.sensors(),servingBefore);
  assert.equal(servingBefore.sensors.length,1);
  assert.equal((await readSensorsAt(db,now)).total_sensors,0);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM observation_publications').first()).n,0);
  assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results,[]);
},true));

async function seedLineage(store,db) {
  await publish(store,'sensor_locations',now,{lat:37.57,lon:126.89});
  await publish(store,'sdot',now);
  const observation=await db.prepare("SELECT revision_id FROM current_observations WHERE source='sdot'").first();
  const location=await db.prepare("SELECT revision_id FROM current_observations WHERE source='sensor_locations'").first();
  const stamp=now.toISOString();
  await db.prepare('INSERT INTO data_releases VALUES(?,?,?,?,?)').bind('release','releases/hash.json','a'.repeat(64),stamp,stamp).run();
  await db.prepare('INSERT INTO feature_snapshots VALUES(?,?,?,?,?,?,?,?,?,?)')
    .bind('feature','sensor-a','2026-11-03T14:00:00.000Z',stamp,'environment-v1','release',observation.revision_id,location.revision_id,'{"lux":12,"noise_db":50}',stamp).run();
  await db.prepare('INSERT INTO target_definitions VALUES(?,?,?,?,?,?,?)')
    .bind('rule-v1','rule_index','Experimental index','targets/rule.json','b'.repeat(64),null,stamp).run();
  await db.prepare('INSERT INTO dataset_snapshots VALUES(?,?,?,?,?,?,?,?,?)')
    .bind('dataset','release','datasets/hash.json','c'.repeat(64),'environment-v1','rule-v1','{"kind":"sensor_holdout"}',10,stamp).run();
  await db.prepare(`INSERT INTO training_runs(id,dataset_id,feature_version,target_version,code_sha,seed,status,parameters_json,metrics_json,baseline_metrics_json,evaluation_policy_version,started_at,finished_at)
    VALUES('train','dataset','environment-v1','rule-v1','commit',42,'succeeded','{}','{"mae":8.28}','{"median_mae":7.95}','eval-v1',?,?)`).bind(stamp,stamp).run();
  await db.prepare(`INSERT INTO model_artifacts(version,training_run_id,feature_version,target_version,object_key,digest,manifest_json,created_at)
    VALUES('model','train','environment-v1','rule-v1','models/hash.json',?,'{}',?)`).bind('d'.repeat(64),stamp).run();
}

test('rejects incompatible model lineage through composite version foreign keys',()=>usingStore(async(store,db)=>{
  // Given: a sealed environment-v1 dataset and training run.
  await seedLineage(store,db);
  // When: registering a model with a different input version.
  const insert=db.prepare(`INSERT INTO model_artifacts(version,training_run_id,feature_version,target_version,object_key,digest,manifest_json,created_at)
    VALUES('wrong','train','environment-v2','rule-v1','models/wrong.json',?,'{}',?)`).bind('e'.repeat(64),now.toISOString());
  // Then: the incompatible lineage is refused.
  await assert.rejects(()=>insert.run(),/FOREIGN KEY/);
}));

test('rejects duplicate predictions and incompatible feature versions',()=>usingStore(async(store,db)=>{
  // Given: one result for a valid model and feature pair.
  await seedLineage(store,db);
  await db.prepare("INSERT INTO prediction_results VALUES('prediction','feature','environment-v1','model','policy-v1',50,'scored',NULL,?)").bind(now.toISOString()).run();
  // When / Then: a duplicate or incompatible input cannot create another result.
  await assert.rejects(()=>db.prepare("INSERT INTO prediction_results VALUES('duplicate','feature','environment-v1','model','policy-v1',50,'scored',NULL,?)").bind(now.toISOString()).run(),/UNIQUE/);
  await assert.rejects(()=>db.prepare("INSERT INTO prediction_results VALUES('bad','feature','environment-v2','model','policy-v2',50,'scored',NULL,?)").bind(now.toISOString()).run(),/FOREIGN KEY/);
}));

test('rejects unsupported scores and running work without a lease',()=>usingStore(async(store,db)=>{
  // Given: valid input lineage.
  await seedLineage(store,db);
  // When / Then: ambiguous score semantics and unowned running work are refused.
  await assert.rejects(()=>db.prepare("INSERT INTO prediction_results VALUES('bad','feature','environment-v1','model','policy-v1',50,'unsupported','stale',?)").bind(now.toISOString()).run(),/CHECK/);
  await assert.rejects(()=>db.prepare("INSERT INTO derivation_jobs(id,kind,input_version,status,created_at,updated_at) VALUES('bad','features','bad','running',?,?)").bind(now.toISOString(),now.toISOString()).run(),/CHECK/);
}));

test('records the selected winner rather than a lower-priority staged revision',()=>usingStore(async(store,db)=>{
  // Given: a higher-rank observation already selected for service.
  await publish(store,'sensor_locations',now,{lat:37.57,lon:126.89});
  await publish(store,'sdot',now,{rank:2,lux:90});
  const later=new Date(now.getTime()+1000);
  // When: a later collection contains an older, lower-rank value.
  await publish(store,'sdot',later,{rank:1,lux:12});
  // Then: history records the actual winner, preserving publication semantics.
  assert.equal((await readSensorsAt(db,later)).sensors[0].lux,90);
  const values=(await db.prepare(`SELECT r.payload_json FROM observation_selections s
    JOIN observation_revisions r ON r.id=s.revision_id WHERE s.source='sdot'`).all()).results;
  assert.equal(values.length,2);
  assert.ok(values.every(row=>JSON.parse(row.payload_json).lux===90));
}));
