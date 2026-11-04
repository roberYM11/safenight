import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { Miniflare } from 'miniflare';
import { CloudStore, CloudStoreError } from '../app/server/cloud/store.ts';
import { cloudRecord } from '../app/server/cloud/contracts.ts';
import { finalizeJob } from '../app/server/cloud/finalize.ts';

const now=new Date('2026-11-04T06:00:00.000Z');
const migrations=await Promise.all((await readdir(new URL('../drizzle/',import.meta.url))).filter(name=>name.endsWith('.sql')).sort().map(name=>readFile(new URL(`../drizzle/${name}`,import.meta.url),'utf8')));
async function usingStore(run) {
  const mf=new Miniflare({modules:true,script:'export default { fetch() { return new Response("test"); } }',compatibilityDate:'2026-05-15',d1Databases:['DB'],r2Buckets:['BUCKET']});
  try {
    const db=await mf.getD1Database('DB');
    const bucket=await mf.getR2Bucket('BUCKET');
    await db.batch(migrations.flatMap(migration=>migration.split('--> statement-breakpoint')).map(sql=>sql.trim()).filter(Boolean).map(sql=>db.prepare(sql)));
    await run(new CloudStore(db,bucket),db,bucket);
  } finally { await mf.dispose(); }
}
function observation(overrides={}) {
  return {entity_id:'sensor-a',observed_at:'2026-11-03T14:00:00.000Z',published_at:'2026-11-03T14:00:00.000Z',revision_rank:1,source_updated_at:'2026-11-03T14:00:00.000Z',payload_json:JSON.stringify({lux:12,noise_db:50}),lat:null,lon:null,...overrides};
}
async function record(store,source,overrides={}) {
  const raw=await store.archive(source,new TextEncoder().encode('real raw test response'),now);
  return cloudRecord(source,observation(overrides),raw,now,'legacy-id');
}
async function complete(store,source,day,records) {
  const job=await store.start({source,day,kind:'import',expected_count:records.length},now);
  assert.equal(await store.claim(job.id,'worker',now),true);
  await store.stage(job.id,'worker',{records,total_count:records.length,page_no:1,page_size:200},now);
  return store.publish(job.id,'worker',now);
}
const code=expected=>error=>error instanceof CloudStoreError && error.code===expected;

test('archives exact bytes in actual R2 and deduplicates repeated content',()=>usingStore(async(store,db,bucket)=>{
  // Given / When
  const bytes=new Uint8Array([0,1,255,42]);
  const one=await store.archive('sdot',bytes,now);
  const two=await store.archive('sdot',bytes,new Date(now.getTime()+1));
  // Then
  assert.equal(one,two);
  assert.deepEqual(new Uint8Array(await (await bucket.get(`raw/${one}`)).arrayBuffer()),bytes);
  assert.equal((await store.overview()).counts.raw_objects,1);
}));

test('keeps staged observations private until the final atomic publish',()=>usingStore(async(store)=>{
  const row=await record(store,'sdot');
  const job=await store.start({source:'sdot',day:'2026-11-03',kind:'import',expected_count:1},now);
  await store.claim(job.id,'worker',now);
  await store.stage(job.id,'worker',{records:[row],total_count:1,page_no:1,page_size:200},now);
  assert.equal((await store.overview()).counts.current_observations,0);
  assert.equal((await store.sensors()).total_sensors,0);
  const result=await store.publish(job.id,'worker',now);
  assert.equal(result.status,'succeeded');
  assert.equal((await store.overview()).counts.current_observations,1);
}));

test('finalizes a fully staged import after its interrupted worker lease expires',()=>usingStore(async(store,db,bucket)=>{
  // Given: the import bytes and final page are durable, but publication never ran.
  const row=await record(store,'sdot');
  const job=await store.start({source:'sdot',day:'2026-11-03',kind:'import',expected_count:1},now);
  await store.claim(job.id,'interrupted-importer',now);
  await store.stage(job.id,'interrupted-importer',{records:[row],total_count:1,page_no:1,page_size:200},now);
  assert.equal((await store.overview()).counts.current_observations,0);
  class FinalizeOnlyStore extends CloudStore {
    async archive() {throw new RangeError('finalization must reuse existing archived bytes');}
  }
  // When: a fresh server worker finalizes the import after the prior lease expires.
  const result=await finalizeJob(new FinalizeOnlyStore(db,bucket),job.id,new Date(now.getTime()+31_000));
  // Then: the existing revision, checkpoint and successful job become visible together.
  assert.equal(result.status,'succeeded');assert.equal(result.fetched_rows,1);
  const state=await store.overview();
  assert.equal(state.counts.raw_objects,1);assert.equal(state.counts.observation_revisions,1);assert.equal(state.counts.current_observations,1);
  assert.deepEqual(state.checkpoints,[{source:'sdot',covered_until:'2026-11-03T15:00:00.000Z'}]);
  assert.equal((await db.prepare('SELECT revision_id FROM current_observations').first()).revision_id,row.id);
}));

test('returns the completed import unchanged when finalization is retried',()=>usingStore(async(store)=>{
  // Given: a previously published import and its committed checkpoint.
  const row=await record(store,'sdot');
  const completed=await complete(store,'sdot','2026-11-03',[row]);
  const before=await store.overview();
  // When: the client retries finalization after losing its original success response.
  const result=await finalizeJob(store,completed.id,new Date(now.getTime()+60_000));
  // Then: no new archive, revision, cursor or checkpoint is created.
  assert.deepEqual(result,completed);assert.deepEqual(await store.overview(),before);
}));

test('resolves the latest sensor measurement with the location effective at that time',()=>usingStore(async(store)=>{
  const old=await record(store,'sensor_locations',{observed_at:'2026-03-09T15:00:00.000Z',payload_json:JSON.stringify({district:'마포구',neighborhood:'성산동'}),lat:37.57,lon:126.89});
  await complete(store,'sensor_locations','2026-03-10',[old]);
  const future=await record(store,'sensor_locations',{observed_at:'2026-11-03T15:00:00.000Z',lat:38,lon:127});
  await complete(store,'sensor_locations','2026-11-04',[future]);
  const first=await record(store,'sdot',{observed_at:'2026-11-03T01:00:00.000Z'});
  const last=await record(store,'sdot',{payload_json:JSON.stringify({lux:79,noise_db:53})});
  await complete(store,'sdot','2026-11-03',[first,last]);
  const result=await store.sensors();
  assert.equal(result.total_sensors,1);
  assert.equal(result.unlocated_sensors,0);
  assert.deepEqual(result.sensors.map(s=>({lat:s.lat,lon:s.lon,lux:s.lux,noise:s.noise_db,district:s.district})),[{lat:37.57,lon:126.89,lux:79,noise:53,district:'마포구'}]);
}));

test('deduplicates an imported record and its later recollection without losing legacy lineage',()=>usingStore(async(store,db)=>{
  const one=await record(store,'sdot');
  await complete(store,'sdot','2026-11-03',[one]);
  const two=await cloudRecord('sdot',observation(),one.raw_sha,new Date(now.getTime()+1000));
  const result=await complete(store,'sdot','2026-11-03',[two]);
  assert.equal(result.inserted_rows,0);
  assert.equal((await store.overview()).counts.observation_revisions,1);
  assert.equal((await db.prepare('SELECT legacy_id FROM observation_revisions').first()).legacy_id,'legacy-id');
}));

test('keeps searchable district names from actual S-DoT fields when location payloads only contain coordinates',()=>usingStore(async(store)=>{
  // Given: native location exports contain coordinates, while names belong to the observation.
  const point=await record(store,'sensor_locations',{observed_at:'2026-03-09T15:00:00.000Z',payload_json:JSON.stringify({sensor_id:'sensor-a',lat:37.57,lon:126.89}),lat:37.57,lon:126.89});
  await complete(store,'sensor_locations','2026-03-10',[point]);
  const row=await record(store,'sdot',{payload_json:JSON.stringify({lux:79,noise_db:53,AUTONOMOUS_DISTRICT:'Mapo-gu',ADMINISTRATIVE_DISTRICT:'Seongsan2(i)-dong'})});
  await complete(store,'sdot','2026-11-03',[row]);
  // When / Then: the map exposes those names instead of losing region search after migration.
  const result=await store.sensors();
  assert.deepEqual(result.sensors.map(sensor=>[sensor.district,sensor.neighborhood]),[['Mapo-gu','Seongsan2(i)-dong']]);
}));

test('selects a higher-rank correction while retaining the original revision',()=>usingStore(async(store,db)=>{
  const one=await record(store,'sdot');
  await complete(store,'sdot','2026-11-03',[one]);
  const two=await record(store,'sdot',{revision_rank:2,payload_json:JSON.stringify({lux:20,noise_db:50})});
  await complete(store,'sdot','2026-11-03',[two]);
  assert.equal((await db.prepare('SELECT revision_id FROM current_observations').first()).revision_id,two.id);
  assert.equal((await store.overview()).counts.observation_revisions,2);
}));

test('refuses an ambiguous same-priority value without publishing partial changes',()=>usingStore(async(store,db)=>{
  const one=await record(store,'sdot');
  await complete(store,'sdot','2026-11-03',[one]);
  const conflicting=await record(store,'sdot',{payload_json:JSON.stringify({lux:99,noise_db:50})});
  await assert.rejects(()=>complete(store,'sdot','2026-11-03',[conflicting]),code('revision_conflict'));
  assert.equal((await db.prepare('SELECT revision_id FROM current_observations').first()).revision_id,one.id);
  assert.equal((await store.overview()).counts.current_observations,1);
}));

test('uses a newer source update timestamp at the same rank',()=>usingStore(async(store,db)=>{
  const one=await record(store,'sdot');
  await complete(store,'sdot','2026-11-03',[one]);
  const two=await record(store,'sdot',{source_updated_at:'2026-11-03T14:05:00.000Z',payload_json:JSON.stringify({lux:99,noise_db:50})});
  await complete(store,'sdot','2026-11-03',[two]);
  assert.equal((await db.prepare('SELECT revision_id FROM current_observations').first()).revision_id,two.id);
}));

test('blocks a competing source job and allows lease takeover only after expiry',()=>usingStore(async(store)=>{
  const row=await record(store,'sdot');
  const job=await store.start({source:'sdot',day:'2026-11-03',kind:'import',expected_count:1},now);
  assert.equal((await store.start({source:'sdot',day:'2026-11-03',kind:'import',expected_count:1},now)).id,job.id);
  await assert.rejects(()=>store.start({source:'sdot',day:'2026-11-04',kind:'collect'},now),code('source_busy'));
  assert.equal(await store.claim(job.id,'first',now),true);
  assert.equal(await store.claim(job.id,'other',now),false);
  const later=new Date(now.getTime()+31000);
  assert.equal(await store.claim(job.id,'other',later),true);
  await assert.rejects(()=>store.stage(job.id,'first',{records:[row],total_count:1,page_no:1,page_size:200},later),code('lease_lost'));
}));

test('rolls back the entire D1 batch when ownership changes immediately before stage commit',()=>usingStore(async(store,db,bucket)=>{
  const row=await record(store,'sdot');
  const job=await store.start({source:'sdot',day:'2026-11-03',kind:'import',expected_count:1},now);
  await store.claim(job.id,'first',now);
  const racing=new CloudStore({prepare:db.prepare.bind(db),batch:async statements=>{
    await db.prepare('UPDATE collection_jobs SET lease_token=? WHERE id=?').bind('other',job.id).run();
    return db.batch(statements);
  }},bucket);
  await assert.rejects(()=>racing.stage(job.id,'first',{records:[row],total_count:1,page_no:1,page_size:200},now),code('lease_lost'));
  assert.equal((await store.get(job.id)).page_no,1);
  assert.equal((await store.overview()).counts.observation_revisions,0);
  assert.equal((await store.overview()).counts.current_observations,0);
}));

test('counts duplicate source rows but stores only one logical revision and safely replays the page',()=>usingStore(async(store)=>{
  const row=await record(store,'sdot');
  const job=await store.start({source:'sdot',day:'2026-11-03',kind:'import',expected_count:2},now);
  await store.claim(job.id,'worker',now);
  const page={records:[row,row],total_count:2,page_no:1,page_size:200};
  await store.stage(job.id,'worker',page,now);
  const replay=await store.stage(job.id,'worker',page,now);
  assert.equal(replay.fetched_rows,2);
  const result=await store.publish(job.id,'worker',now);
  assert.equal(result.inserted_rows,1);
}));

test('rejects repeated nonempty pages instead of treating them as complete coverage',()=>usingStore(async(store)=>{
  const row=await record(store,'sdot');
  const job=await store.start({source:'sdot',day:'2026-11-03',kind:'import',expected_count:400},now);
  await store.claim(job.id,'worker',now);
  const rows=Array.from({length:200},()=>row);
  await store.stage(job.id,'worker',{records:rows,total_count:400,page_no:1,page_size:200},now);
  await assert.rejects(()=>store.stage(job.id,'worker',{records:rows,total_count:400,page_no:2,page_size:200},now),code('repeated_page'));
  assert.equal((await store.overview()).counts.current_observations,0);
}));

test('does not advance the checkpoint across an uncollected day',()=>usingStore(async(store)=>{
  await complete(store,'sdot','2026-11-03',[]);
  await assert.rejects(()=>complete(store,'sdot','2026-11-05',[]),code('coverage_gap'));
  assert.equal((await store.overview()).checkpoints[0].covered_until,'2026-11-03T15:00:00.000Z');
}));

test('keeps raw bytes and failed history while permitting a new attempt',()=>usingStore(async(store)=>{
  const row=await record(store,'sdot');
  const job=await store.start({source:'sdot',day:'2026-11-03',kind:'import',expected_count:1},now);
  await store.claim(job.id,'worker',now);
  await store.stage(job.id,'worker',{records:[row],total_count:1,page_no:1,page_size:200},now);
  const failed=await store.fail(job.id,'worker','provider_failed',now);
  assert.equal(failed.status,'failed');
  assert.notEqual((await store.start({source:'sdot',day:'2026-11-03',kind:'import',expected_count:1},now)).id,job.id);
  const state=await store.overview();
  assert.equal(state.counts.raw_objects,1);
  assert.equal(state.counts.current_observations,0);
  assert.equal(state.counts.jobs,2);
}));

test('publishes a full day of25000 revisions and keeps latest reads at sensor grain',()=>usingStore(async(store,db)=>{
  // Given: a realistic daily row volume, with twenty observations per sensor.
  const raw=await store.archive('sdot',new TextEncoder().encode('synthetic daily-volume fixture'),now);
  const job=await store.start({source:'sdot',day:'2026-11-03',kind:'import',expected_count:25000},now);
  await store.claim(job.id,'worker',now);
  for (let offset=0;offset<25000;offset+=200) {
    const records=Array.from({length:200},(_,j)=>{
      const i=offset+j;
      return {id:(i+1).toString(16).padStart(64,'0'),source:'sdot',entity_id:`sensor-${i%1250}`,observed_at:new Date(Date.parse('2026-11-02T15:00:00Z')+Math.floor(i/1250)*3600000).toISOString(),published_at:now.toISOString(),revision_rank:1,source_updated_at:now.toISOString(),payload_json:'{"lux":12,"noise_db":50}',lat:null,lon:null,raw_sha:raw,ingested_at:now.toISOString(),legacy_id:null};
    });
    await store.stage(job.id,'worker',{records,total_count:25000,page_no:offset/200+1,page_size:200},now);
  }
  // When: the entire day is published.
  const started=performance.now();
  const result=await store.publish(job.id,'worker',now);
  // Then: history is complete while the serving pointer set stays at sensor grain.
  assert.equal(result.status,'succeeded');
  assert.equal((await store.overview()).counts.current_observations,25000);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM latest_observations').first()).n,1250);
  assert.equal((await store.sensors()).total_sensors,1250);
  console.log(JSON.stringify({fixture:'synthetic-25000-row-day',publish_ms:Math.round(performance.now()-started)}));
}));
