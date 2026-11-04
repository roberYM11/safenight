import assert from 'node:assert/strict';
import test from 'node:test';
import { dayStart, parsePage, ProviderError, providerTime, requestPage } from '../app/server/cloud/providers.ts';

const encoder = new TextEncoder();
const query = { source:'sdot',day:'2026-11-03',page_no:1,page_size:2,full_snapshot:false };
function row(overrides={}) { return { SERIAL:'sensor-1',SENSING_TIME:'2026-11-03_23-08-19',DATE:'2026-11-03 23:08:20',DATA_NO:'1',AVG_INTE_ILLU:'0',AVG_NOISE:'40',TEMPERATURE:'8.1',...overrides }; }
function payload(rows,total=rows.length) { return encoder.encode(JSON.stringify({sDoTEnv:{list_total_count:total,RESULT:{CODE:'INFO-000'},row:rows}})); }
function code(expected) { return error=>error instanceof ProviderError && error.code===expected; }

test('parses verified clocks and preserves original fields, missingness and zero',()=>{
  // Given: actual-shaped observations with distinct null and zero values.
  const bytes=payload([row(),row({SERIAL:'sensor-2',AVG_INTE_ILLU:null,AVG_NOISE:''})]);
  // When: a complete page crosses the provider boundary.
  const page=parsePage(bytes,query);
  // Then: units and raw extras survive without inventing coordinates.
  assert.equal(page.records[0].observed_at,'2026-11-03T14:08:19.000Z');
  assert.equal(page.records[0].lat,null);
  assert.deepEqual(JSON.parse(page.records[0].payload_json),{...row(),lux:0,noise_db:40,source_clock_skew_seconds:0});
  assert.equal(JSON.parse(page.records[1].payload_json).lux,null);
  assert.equal(JSON.parse(page.records[1].payload_json).noise_db,null);
});

test('keeps small source-clock reversal as quality evidence',()=>{
  // Given: the source publication clock trails its measurement by two minutes.
  const bytes=payload([row({DATE:'2026-11-03 23:06:19',DATA_NO:'2'})]);
  // When: normalizing the page.
  const page=parsePage(bytes,query);
  // Then: the measured timestamp stays unchanged and correction rank survives.
  assert.equal(JSON.parse(page.records[0].payload_json).source_clock_skew_seconds,120);
  assert.equal(page.records[0].revision_rank,2);
});

for (const [name,overrides,expected] of [
  ['outside requested day',{SENSING_TIME:'2026-11-04_00-00-00'},'sdot_row_outside_window'],
  ['large clock reversal',{DATE:'2026-11-03 23:03:18'},'sdot_excessive_clock_skew'],
  ['invalid calendar date',{SENSING_TIME:'2026-02-30_23-08-19'},'invalid_provider_time'],
  ['invalid hour',{SENSING_TIME:'2026-11-03_24-08-19'},'invalid_provider_time'],
  ['nonfinite lux',{AVG_INTE_ILLU:'NaN'},'invalid_number'],
  ['hexadecimal lux',{AVG_INTE_ILLU:'0x10'},'invalid_number'],
  ['negative noise',{AVG_NOISE:'-1'},'invalid_number'],
  ['out-of-range lux',{AVG_INTE_ILLU:'200001'},'invalid_number'],
]) test(`rejects ${name}`,()=>{
  // Given: one invalid source observation.
  const bytes=payload([row(overrides)]);
  // When/Then: validation fails with a credential-safe code.
  assert.throws(()=>parsePage(bytes,query),code(expected));
});

test('accepts documented empty envelope without treating authentication errors as empty data',()=>{
  // Given: the source's explicit INFO-200 response.
  const bytes=encoder.encode(JSON.stringify({RESULT:{CODE:'INFO-200'}}));
  // When: parsing that response.
  const page=parsePage(bytes,query);
  // Then: there is a declared complete zero, rather than a fabricated observation.
  assert.equal(page.total_count,0);assert.deepEqual(page.records,[]);
});

test('rejects authentication envelope',()=>{
  // Given: a successful HTTP transport carrying a source rejection.
  const bytes=encoder.encode(JSON.stringify({RESULT:{CODE:'ERROR-300'}}));
  // When/Then: no empty source batch is published.
  assert.throws(()=>parsePage(bytes,query),code('sdot_provider_rejected'));
});

test('rejects a short nonfinal page',()=>{
  // Given: the source promises more rows than this page contains.
  const bytes=payload([row()],3);
  // When/Then: pagination completeness cannot pass.
  assert.throws(()=>parsePage(bytes,query),code('sdot_invalid_pagination'));
});

test('rejects malformed JSON',()=>{
  // Given: bytes retained before parsing by the coordinator.
  const bytes=encoder.encode('{bad');
  // When/Then: parsing yields a safe schema error.
  assert.throws(()=>parsePage(bytes,query),code('sdot_invalid_payload'));
});

test('recognizes offset ISO clocks independently of machine timezone',()=>{
  // Given/When: equivalent explicit timezone timestamps.
  const result=providerTime('2026-11-03T14:08:19Z');
  // Then: normalization is canonical UTC.
  assert.equal(result,'2026-11-03T14:08:19.000Z');
});

test('rejects invalid query day before making a network request',async()=>{
  // Given: a normalized-but-invalid calendar day and a recording wire.
  let calls=0;
  const fetcher=async()=>{calls++;return new Response('{}');};
  // When/Then: the boundary rejects before any external call.
  await assert.rejects(requestPage({...query,day:'2026-02-30'},{sdot:'fixture-key'},new AbortController().signal,fetcher),code('invalid_query'));
  assert.equal(calls,0);
});

test('requests the exact day and page while returning unparsed original bytes',async()=>{
  // Given: an HTTP-shaped wire carrying a deliberately malformed body.
  const bytes=encoder.encode('unparsed-body');let observed;
  const fetcher=async(request)=>{observed=new Request(request);return new Response(bytes,{headers:{'content-type':'application/json'}});};
  // When: requesting the second provider page.
  const response=await requestPage({...query,page_no:2},{sdot:'fixture-key'},new AbortController().signal,fetcher);
  // Then: date/page/key stay server-side, and parsing has not occurred.
  assert.equal(new URL(observed.url).pathname,'/fixture-key/json/sDoTEnv/3/4/2026-11-03');
  assert.deepEqual(response.body,bytes);
});

test('does not retry or expose the URL after an HTTP failure',async()=>{
  // Given: the authorized fixed provider returns a server error.
  let calls=0;
  const fetcher=async()=>{calls++;return new Response('failure',{status:503});};
  // When/Then: diagnostics contain only a code and one attempt was made.
  await assert.rejects(requestPage(query,{sdot:'fixture-key'},new AbortController().signal,fetcher),error=>code('sdot_http_error')(error)&&!error.message.includes('fixture-key'));
  assert.equal(calls,1);
});

test('sanitizes an aborted request',async()=>{
  // Given: a caller whose request budget is already spent.
  const controller=new AbortController();controller.abort();
  // When/Then: no credential-bearing abort message escapes.
  await assert.rejects(requestPage(query,{sdot:'fixture-key'},controller.signal,async()=>new Response('{}')),code('sdot_timeout'));
});

test('rejects declared oversized responses',async()=>{
  // Given: a source violating the bounded body budget.
  const fetcher=async()=>new Response('x',{headers:{'content-length':'9000000'}});
  // When/Then: it cannot consume unbounded Worker memory.
  await assert.rejects(requestPage(query,{sdot:'fixture-key'},new AbortController().signal,fetcher),code('sdot_body_too_large'));
});

test('keeps Korean midnight boundaries exact',()=>{
  // Given/When: a source query date in Korea.
  const time=dayStart('2026-11-03');
  // Then: it begins nine hours before UTC midnight of that date.
  assert.equal(new Date(time).toISOString(),'2026-11-02T15:00:00.000Z');
});
