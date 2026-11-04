import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { Miniflare } from 'miniflare';
import { planDue, step } from '../app/server/cloud/jobs.ts';
import { CloudStore } from '../app/server/cloud/store.ts';
import { cloudRecord } from '../app/server/cloud/contracts.ts';
import { requestPage } from '../app/server/cloud/providers.ts';

const now=new Date('2026-11-04T18:00:00.000Z');
const encoder=new TextEncoder();
function makeJob(overrides={}) {return {id:'job-1',source:'sdot',day:'2026-11-03',kind:'collect',status:'pending',page_no:1,page_size:2,total_count:null,fetched_rows:0,inserted_rows:0,error_code:null,created_at:'2026-11-04T10:00:00.000Z',updated_at:'2026-11-04T10:00:00.000Z',finished_at:null,...overrides};}
function bytes(serials,total=serials.length) {return encoder.encode(JSON.stringify({sDoTEnv:{list_total_count:total,RESULT:{CODE:'INFO-000'},row:serials.map(serial=>({SERIAL:serial,SENSING_TIME:'2026-11-03_23-08-19',DATE:'2026-11-03 23:08:20',DATA_NO:'1',AVG_INTE_ILLU:'20',AVG_NOISE:'40'}))}}));}

// A stateful isolated coordinator store; publication is deliberately separate from staging.
class MemoryStore {
  constructor(job=makeJob()) {this.job=job;this.raw=[];this.staged=[];this.published=[];this.claimed=false;this.released=0;}
  async get(id) {return id===this.job.id?this.job:null;}
  async claim() {if(this.claimed)return false;this.claimed=true;return true;}
  async archive(source,body) {this.raw.push(body);return 'a'.repeat(64);}
  async stage(id,token,page) {this.staged.push(...page.records);this.job={...this.job,status:'running',page_no:this.job.page_no+1,total_count:page.total_count,fetched_rows:this.job.fetched_rows+page.records.length};return this.job;}
  async publish() {assert.equal(this.job.fetched_rows,this.job.total_count);this.published=[...this.staged];this.job={...this.job,status:'succeeded',finished_at:now.toISOString()};return this.job;}
  async fail(id,token,errorCode) {this.job={...this.job,status:'failed',error_code:errorCode};return this.job;}
  async release() {this.claimed=false;this.released++;}
}

test('stages one page without exposing partial results',async()=>{
  // Given: a two-page source window and a committed view with no rows.
  const store=new MemoryStore();let calls=0;
  // When: advancing one page only.
  const result=await step(store,'job-1',{sdot:'fixture-key'},now,async()=>{calls++;return {body:bytes(['a','b'],3),content_type:'application/json'};});
  // Then: the durable next cursor moves, but the public view does not.
  assert.equal(calls,1);assert.equal(result.page_no,2);assert.equal(result.status,'running');assert.equal(store.staged.length,2);assert.equal(store.published.length,0);assert.equal(store.released,1);
});

test('resumes from a durable cursor and publishes only the final page',async()=>{
  // Given: one previously staged page in a still-running job.
  const store=new MemoryStore(makeJob({status:'running',page_no:2,total_count:3,fetched_rows:2}));
  store.staged=[{entity_id:'old-a'},{entity_id:'old-b'}];let requestedPage;
  // When: the resumed request receives the final source page.
  const result=await step(store,'job-1',{sdot:'fixture-key'},now,async(query)=>{requestedPage=query.page_no;return {body:bytes(['c'],3),content_type:'application/json'};});
  // Then: only complete data becomes visible.
  assert.equal(requestedPage,2);assert.equal(result.status,'succeeded');assert.equal(store.published.length,3);
});

test('archives a malformed response before recording a failed job',async()=>{
  // Given: the source returned HTTP-success bytes that are not valid JSON.
  const store=new MemoryStore();const body=encoder.encode('{bad');
  // When: the coordinator processes the page.
  const result=await step(store,'job-1',{sdot:'fixture-key'},now,async()=>({body,content_type:'application/json'}));
  // Then: the original bytes survive and no partial data is published.
  assert.deepEqual(store.raw,[body]);assert.equal(result.error_code,'sdot_invalid_payload');assert.equal(store.published.length,0);
});

test('does not request a page while another caller holds its lease',async()=>{
  // Given: an already claimed source job.
  const store=new MemoryStore();store.claimed=true;let calls=0;
  // When: a competing caller tries to advance it.
  const result=await step(store,'job-1',{sdot:'fixture-key'},now,async()=>{calls++;throw new RangeError('must not run');});
  // Then: the request is skipped and the owner is left alone.
  assert.equal(calls,0);assert.equal(result.page_no,1);assert.equal(store.claimed,true);
});

test('reads the current durable cursor after winning a later lease',async()=>{
  // Given: a preceding caller finishes a page immediately before this lease is acquired.
  const store=new MemoryStore();
  store.claim=async()=>{store.claimed=true;store.job={...store.job,page_no:2,total_count:3,fetched_rows:2};return true;};
  let requestedPage;
  // When: this caller continues the same job.
  await step(store,'job-1',{sdot:'fixture-key'},now,async(query)=>{requestedPage=query.page_no;return {body:bytes(['c'],3),content_type:'application/json'};});
  // Then: it does not replay a stale page and falsely fail the job.
  assert.equal(requestedPage,2);
});

test('rejects total-count drift after retaining the raw response',async()=>{
  // Given: a first page established a three-row window.
  const store=new MemoryStore(makeJob({status:'running',page_no:2,total_count:3,fetched_rows:2}));
  // When: the source now reports four rows.
  const result=await step(store,'job-1',{sdot:'fixture-key'},now,async()=>({body:bytes(['c','d'],4),content_type:'application/json'}));
  // Then: the batch fails without publishing a mixed snapshot.
  assert.equal(result.error_code,'total_changed');assert.equal(store.raw.length,1);assert.equal(store.published.length,0);
});

test('rethrows programming failures while releasing the lease',async()=>{
  // Given: an unexpected implementation failure rather than a provider outage.
  const store=new MemoryStore();
  // When/Then: it remains diagnosable and cannot leave an active lease forever.
  await assert.rejects(step(store,'job-1',{sdot:'fixture-key'},now,async()=>{throw new RangeError('fixture programming failure');}),RangeError);
  assert.equal(store.released,1);assert.equal(store.job.status,'pending');
});

test('does not repeat source work for an already successful job',async()=>{
  // Given: a completed immutable source window.
  const store=new MemoryStore(makeJob({status:'succeeded'}));let calls=0;
  // When: a retried HTTP request references that completed job.
  const result=await step(store,'job-1',{sdot:'fixture-key'},now,async()=>{calls++;throw new RangeError('must not run');});
  // Then: it returns the prior outcome without another provider call.
  assert.equal(calls,0);assert.equal(result.status,'succeeded');
});

test('switches the latest eligible Korean day at the configured collection hour',()=>{
  // Given: the minute immediately before the Korean03:00 boundary.
  const input={now:new Date('2026-11-03T17:59:00Z'),covered_until:null,jobs:[]};
  // When: planning at that instant.
  const result=planDue(input);
  // Then: the unfinished scheduling day is not collected early.
  assert.equal(result.days[0],'2026-11-02');assert.equal(result.target_end,'2026-11-02T15:00:00.000Z');
});

test('includes the previous full day at Korean03:00',()=>{
  // Given/When: the exact scheduled boundary.
  const result=planDue({now:new Date('2026-11-03T18:00:00Z'),covered_until:null,jobs:[]});
  // Then: the previous full calendar day is eligible.
  assert.equal(result.days[0],'2026-11-03');
});

test('plans missing checkpoint days in order before correction rechecks',()=>{
  // Given: two complete days have not been published.
  const result=planDue({now:new Date('2026-11-03T18:00:00Z'),covered_until:'2026-11-01T15:00:00.000Z',jobs:[]});
  // When/Then: catchup is contiguous and precedes older rechecks.
  assert.deepEqual(result.days.slice(0,2),['2026-11-02','2026-11-03']);
});

test('does not silently skip a gap beyond the source retention window',()=>{
  // Given: the checkpoint is older than29days.
  const result=planDue({now,covered_until:'2026-09-01T15:00:00.000Z',jobs:[]});
  // When/Then: an archive backfill is requested rather than advancing the checkpoint.
  assert.equal(result.status,'archive_backfill_required');assert.deepEqual(result.days,[]);
});

test('resumes a pending job instead of planning a parallel source window',()=>{
  // Given: an interrupted source page is durable.
  const job=makeJob({status:'running',page_no:12});
  // When: an unattended run starts again.
  const result=planDue({now,covered_until:null,jobs:[job]});
  // Then: it resumes the same job before creating another one.
  assert.deepEqual(result.pending_job_ids,['job-1']);assert.deepEqual(result.days,[]);
});

test('defers retries for fifteen minutes after a provider failure',()=>{
  // Given: the latest source attempt failed moments ago.
  const job=makeJob({status:'failed',created_at:'2026-11-04T17:58:00Z',finished_at:'2026-11-04T17:59:00Z'});
  // When: planning immediately afterward.
  const result=planDue({now,covered_until:null,jobs:[job]});
  // Then: provider failures do not create a tight retry loop.
  assert.equal(result.status,'retry_deferred');assert.equal(result.retry_at,'2026-11-04T18:14:00.000Z');
});

test('skips correction days already successfully collected on the current Korean day',()=>{
  // Given: yesterday was successfully rechecked after today's Korean midnight.
  const job=makeJob({day:'2026-11-04',status:'succeeded',created_at:'2026-11-04T18:00:00Z',finished_at:'2026-11-04T18:01:00Z'});
  // When: planning at the same schedule boundary with a complete checkpoint.
  const result=planDue({now,covered_until:'2026-11-04T15:00:00.000Z',jobs:[job]});
  // Then: the same day is not collected twice.
  assert.ok(!result.days.includes('2026-11-04'));
});

test('does not count bootstrap imports as a successful cloud correction run',()=>{
  // Given: the data was imported today but not collected by the cloud provider.
  const job=makeJob({kind:'import',day:'2026-11-04',status:'succeeded',created_at:'2026-11-04T18:00:00Z'});
  // When: planning correction checks.
  const result=planDue({now,covered_until:'2026-11-04T15:00:00.000Z',jobs:[job]});
  // Then: the real source is still rechecked once.
  assert.ok(result.days.includes('2026-11-04'));
});

async function usingRealStore(run) {
  const mf=new Miniflare({modules:true,script:'export default { fetch() { return new Response("test"); } }',compatibilityDate:'2026-05-15',d1Databases:['DB'],r2Buckets:['BUCKET']});
  try {
    const db=await mf.getD1Database('DB');const bucket=await mf.getR2Bucket('BUCKET');
    const directory=new URL('../drizzle/',import.meta.url);
    const names=(await readdir(directory)).filter(name=>name.endsWith('.sql')).sort();
    for (const name of names) {
      const sql=await readFile(new URL(name,directory),'utf8');
      await db.batch(sql.split('--> statement-breakpoint').map(statement=>statement.trim()).filter(Boolean).map(statement=>db.prepare(statement)));
    }
    await run(new CloudStore(db,bucket),db,bucket);
  } finally {await mf.dispose();}
}

for (const count of [1,0]) {
  test(`publishes ${count}-row staged D1 window after an interrupted final step without another source request`,()=>usingRealStore(async(store,db,bucket)=>{
    // Given: every row is durable, but the worker stopped before publication and its lease expired.
    const job=await store.start({source:'sdot',day:'2026-11-03',kind:'collect'},now);
    const raw=await store.archive('sdot',bytes(count ? ['sensor-1'] : []),now);
    const records=count ? [await cloudRecord('sdot',{entity_id:'sensor-1',observed_at:'2026-11-03T14:08:19.000Z',published_at:'2026-11-03T14:08:20.000Z',revision_rank:1,source_updated_at:null,payload_json:'{"lux":20,"noise":40}',lat:null,lon:null},raw,now)] : [];
    await store.claim(job.id,'interrupted-worker',now);
    await store.stage(job.id,'interrupted-worker',{records,total_count:count,page_no:1,page_size:200},now);
    assert.equal((await store.overview()).counts.current_observations,0);
    let requests=0;
    // When: a fresh worker resumes the complete durable window after lease expiry.
    const result=await step(new CloudStore(db,bucket),job.id,{sdot:'fixture-key'},new Date(now.getTime()+31_000),async()=>{requests++;throw new RangeError('completed window must not request another source page');});
    // Then: publication and checkpoint commit without an out-of-range upstream request.
    assert.equal(requests,0);assert.equal(result.status,'succeeded');
    const overview=await store.overview();assert.equal(overview.counts.current_observations,count);
    assert.deepEqual(overview.checkpoints,[{source:'sdot',covered_until:'2026-11-03T15:00:00.000Z'}]);
  }));
}

test('collects two HTTP-shaped pages through real D1/R2 and publishes after resume',()=>usingRealStore(async(store,db,bucket)=>{
  // Given: one imported sensor location and a201-row provider day.
  const raw=await store.archive('sensor_locations',encoder.encode('position source'),now);
  const location=await cloudRecord('sensor_locations',{entity_id:'sensor-1',observed_at:'2026-03-09T15:00:00.000Z',published_at:'2026-03-09T15:00:00.000Z',revision_rank:1,source_updated_at:null,payload_json:JSON.stringify({district:'마포구',neighborhood:'성산동'}),lat:37.57,lon:126.89},raw,now);
  const imported=await store.start({source:'sensor_locations',day:'2026-03-10',kind:'import',expected_count:1},now);
  await store.claim(imported.id,'importer',now);await store.stage(imported.id,'importer',{records:[location],total_count:1,page_no:1,page_size:200},now);await store.publish(imported.id,'importer',now);
  const job=await store.start({source:'sdot',day:'2026-11-03',kind:'collect'},now);
  const pages=[];
  const fetcher=async(request)=>{
    const parts=new URL(request.url).pathname.split('/');const first=Number(parts[4]);pages.push(first);
    const count=Math.min(200,202-first);
    return new Response(bytes(Array.from({length:count},(_,index)=>`sensor-${first+index}`),201),{headers:{'content-type':'application/json'}});
  };
  const requester=(query,keys,signal)=>requestPage(query,keys,signal,fetcher);
  await step(store,job.id,{sdot:'fixture-key'},now,requester);
  assert.equal((await store.sensors()).total_sensors,0);
  // When: a fresh store instance resumes the durable second-page cursor.
  const resumed=await step(new CloudStore(db,bucket),job.id,{sdot:'fixture-key'},now,requester);
  // Then: all source rows are committed together and raw responses are retained.
  assert.equal(resumed.status,'succeeded');assert.deepEqual(pages,[1,201]);
  const view=await store.sensors();assert.equal(view.total_sensors,201);assert.equal(view.sensors.length,1);assert.equal(view.sensors[0].lux,20);
  const overview=await store.overview();assert.equal(overview.counts.raw_objects,3);assert.equal(overview.counts.current_observations,202);assert.equal(overview.checkpoints[0].covered_until,'2026-11-03T15:00:00.000Z');
}));

test('retains real R2 malformed bytes while failing the D1 job without publication',()=>usingRealStore(async(store,db,bucket)=>{
  // Given: an authenticated collection job and malformed provider response.
  const job=await store.start({source:'sdot',day:'2026-11-03',kind:'collect'},now);const body=encoder.encode('{malformed');
  // When: the complete coordinator processes those bytes.
  const result=await step(store,job.id,{sdot:'fixture-key'},now,async()=>({body,content_type:'application/json'}));
  // Then: the failed run does not advance its source or expose partial observations.
  assert.equal(result.status,'failed');assert.equal(result.error_code,'sdot_invalid_payload');
  const overview=await store.overview();assert.equal(overview.counts.raw_objects,1);assert.equal(overview.counts.current_observations,0);assert.deepEqual(overview.checkpoints,[]);
  const archived=await db.prepare('SELECT sha256 FROM raw_objects').first();assert.deepEqual(new Uint8Array(await (await bucket.get(`raw/${archived.sha256}`)).arrayBuffer()),body);
}));

test('fails repeated source pages through real D1 without exposing the staged day',()=>usingRealStore(async(store)=>{
  // Given: the provider repeats200identities while claiming400rows.
  const job=await store.start({source:'sdot',day:'2026-11-03',kind:'collect'},now);
  const body=bytes(Array.from({length:200},(_,index)=>`sensor-${index}`),400);
  const requester=async()=>({body,content_type:'application/json'});
  await step(store,job.id,{sdot:'fixture-key'},now,requester);
  // When: the second page repeats the same normalized fingerprint.
  const result=await step(store,job.id,{sdot:'fixture-key'},now,requester);
  // Then: storage's concrete typed error becomes a safe failed job, not complete coverage.
  assert.equal(result.status,'failed');assert.equal(result.error_code,'repeated_page');assert.equal((await store.overview()).counts.current_observations,0);
}));
