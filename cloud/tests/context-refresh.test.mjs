import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, readdir } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { downloadContextSource, ContextRefreshError } from '../app/server/context-refresh.ts';

const now = new Date('2026-11-04T12:00:00.000Z');
const metadata = { name: 'CCTV fixture', dateModified: '2026-04-22', license: { name: '이용허락범위 제한 없음', url: 'https://www.data.go.kr/ugs/selectPortalPolicyView.do' } };
const html = `<script type="application/ld+json">${JSON.stringify(metadata)}</script>`;
const downloadPage = '<button data-download-urls="/file/download/cctv_info/info"></button><option value="3230000">서울송파구</option>';
const header = Buffer.from('sLO55sDaxKG03MO8xNq15Syw/LiuufjIoyy8s8ShuPHA+7G4utAsxKu43rbztOu89ixXR1M4NMCntbUsV0dTODSw5rW1LLWlwMzFzbHiwdjAz8DaLLzSwOfB9rW1t8647cHWvNIsvNLA58H2wfa5+MHWvNIK', 'base64');
const makeCsv = (rows = 100) => Buffer.concat([header, Buffer.from(Array.from({ length: rows }, (_, i) => `3230000,id-${i},public,3,37.5133,127.1001,2026-05-01,road-${i},\n`).join(''))]);
function fixtureFetcher(overrides = {}) {
  return async request => {
    const url = new URL(request.url);
    if (url.pathname.endsWith('standard.do')) return new Response(overrides.html ?? html);
    if (url.pathname === '/file/cctv_info/info') return new Response(downloadPage);
    if (url.pathname === '/file/download/cctv_info/info') return new Response(overrides.csv ?? makeCsv());
    throw new Error(`Unexpected fixture request ${url.pathname}`);
  };
}

test('downloads one source, archives each response before parsing, and preserves original dates', async () => {
  const archived = [];
  const result = await downloadContextSource('songpa-cctv', now, { fetcher: fixtureFetcher(), archive: async doc => { archived.push(doc); } });
  assert.deepEqual(archived.map(doc => doc.role), ['metadata', 'download_page', 'csv']);
  assert.equal(result.facilities.length, 100);
  assert.equal(result.facilities.reduce((sum, row) => sum + row[7], 0), 300);
  assert.equal(result.sources[0].reference_date, '2026-05-01');
  assert.equal(result.sources[0].updated_at, '2026-04-22');
  assert.equal(result.sources[0].retrieved_at, now.toISOString());
  assert.equal(result.sources[0].raw_sha256, archived[2].sha256);
});

test('malformed or collapsed source data is archived and rejected instead of replacing current data', async () => {
  const archived = [];
  await assert.rejects(downloadContextSource('songpa-cctv', now, { fetcher: fixtureFetcher({ csv: makeCsv(2) }), archive: async doc => { archived.push(doc.role); } }), error => error instanceof ContextRefreshError && error.code === 'source_coverage_loss');
  assert.deepEqual(archived, ['metadata', 'download_page', 'csv']);
});

test('license changes stop before the CSV is requested', async () => {
  const archived = [];
  const modified = `<script type="application/ld+json">${JSON.stringify({ ...metadata, license: { ...metadata.license, name: 'restricted' } })}</script>`;
  await assert.rejects(downloadContextSource('songpa-cctv', now, { fetcher: fixtureFetcher({ html: modified }), archive: async doc => { archived.push(doc.role); } }), error => error instanceof ContextRefreshError && error.code === 'source_license_changed');
  assert.deepEqual(archived, ['metadata']);
});

test('upstream HTTP rejection is archived before the refresh fails', async () => {
  const archived = [];
  await assert.rejects(downloadContextSource('songpa-lights', now, { fetcher: async () => new Response('upstream unavailable fixture', { status: 503 }), archive: async document => { archived.push(document); } }), error => error instanceof ContextRefreshError && error.code === 'source_http_error');
  assert.equal(archived.length, 1);
  assert.equal(archived[0].role, 'metadata');
  assert.equal(new TextDecoder().decode(archived[0].bytes), 'upstream unavailable fixture');
});

test('provider requests reject redirects and oversized HTML without following arbitrary locations', async () => {
  let calls = 0;
  await assert.rejects(downloadContextSource('songpa-cctv', now, { fetcher: async () => { calls += 1; return new Response(null, { status: 302, headers: { Location: 'https://outside.invalid/' } }); } }), error => error instanceof ContextRefreshError && error.code === 'source_http_error');
  assert.equal(calls, 1);
  await assert.rejects(downloadContextSource('songpa-cctv', now, { fetcher: async () => new Response('large', { headers: { 'Content-Length': String(2 * 1024 * 1024) } }) }), error => error instanceof ContextRefreshError && error.code === 'source_too_large');
});

test('actual Worker runtime decodes EUC-KR and executes bounded public source parsing', async () => {
  const resolveDir = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
  const bundled = await build({ stdin: { resolveDir, contents: `
    import {downloadContextSource} from './app/server/context-refresh.ts';
    export default {async fetch() {
      const csv = Uint8Array.from(atob(${JSON.stringify(makeCsv().toString('base64'))}), char => char.charCodeAt(0));
      const result = await downloadContextSource('songpa-cctv', new Date(${JSON.stringify(now.toISOString())}), {fetcher: async request => {
        const p = new URL(request.url).pathname;
        return p.endsWith('standard.do') ? new Response(${JSON.stringify(html)}) : p === '/file/cctv_info/info' ? new Response(${JSON.stringify(downloadPage)}) : new Response(csv);
      }});
      return Response.json({decoded:new TextDecoder('euc-kr',{fatal:true}).decode(Uint8Array.from([188,173,191,239])), records:result.facilities.length,cameras:result.facilities.reduce((sum,row)=>sum+row[7],0)});
    }};` }, bundle: true, platform: 'browser', format: 'esm', target: 'es2022', write: false });
  const worker = new Miniflare({ modules: true, compatibilityDate: '2026-05-15', cf: false, script: bundled.outputFiles[0].text });
  try { assert.deepEqual(await (await worker.dispatchFetch('https://fixture.test/')).json(), { decoded: '서울', records: 100, cameras: 300 }); }
  finally { await worker.dispose(); }
});

test('protected HTTP writer publishes all four sources in real D1/R2 and reuses the completed daily job', async () => {
  const cloudDir = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
  const bundled = await build({ stdin: { resolveDir: cloudDir, contents: `
    import {GET,POST} from './app/api/internal/context/route.ts';
    export default {fetch(request){return request.method==='GET'?GET(request):POST(request)}};
  ` }, bundle: true, platform: 'browser', format: 'esm', target: 'es2022', external: ['cloudflare:workers'], write: false });
  const auth = 'fixture-only-collection-token-32-characters'; let requests = 0;
  const songpaLightCsv = Buffer.concat([Buffer.from('vPi5+CyxuLrQLMDPt8O5+MijLMCntbUssOa1tQo=', 'base64'), ...Array.from({ length: 100 }, (_, i) => Buffer.concat([Buffer.from(`${i},`), Buffer.from('sKG3zrXu', 'base64'), Buffer.from(`,light-${i},37.5133,127.1001\n`)]))]);
  const seochoLightCsv = Buffer.concat([Buffer.from('v6y5+CzH4MGktb8stbW3zrjtwda80izB9rn4wda80izAp7W1LLDmtbUK', 'base64'), Buffer.from(Array.from({ length: 100 }, (_, i) => `${i},district,road,address,37.48,127.03\n`).join(''))]);
  const worker = new Miniflare({ modules: true, compatibilityDate: '2026-05-15', cf: false, script: bundled.outputFiles[0].text, d1Databases: ['DB'], r2Buckets: ['BUCKET'], bindings: { SAFENIGHT_COLLECT_AUTH_TOKEN: auth }, outboundService: async request => {
    requests += 1; const url = new URL(request.url);
    if (url.pathname.endsWith('standard.do')) return new Response(html);
    if (url.pathname.endsWith('fileData.do')) {
      const dataset = url.pathname.split('/')[2];
      return new Response(`<script type="application/ld+json">${JSON.stringify({ ...metadata, alternateName: 'fixture_20240513' })}</script>fn_fileDataDown('${dataset}', 'uddi:aaaa-bbbb', '', '1')`);
    }
    if (url.pathname.endsWith('selectFileDataDownload.do')) {
      const params = new URLSearchParams(await request.text());
      return Response.json({ status: true, atchFileId: `FILE_${params.get('publicDataPk')}`, fileDetailSn: '1' });
    }
    if (url.pathname.endsWith('fileDownload.do')) return new Response(url.searchParams.get('atchFileId') === 'FILE_15097746' ? songpaLightCsv : seochoLightCsv);
    if (url.pathname === '/file/cctv_info/info') return new Response(downloadPage + '<option value="3210000">서울서초구</option>');
    if (url.pathname === '/file/download/cctv_info/info') return new Response(url.searchParams.get('orgCode') === '3230000' ? makeCsv() : Buffer.concat([header, Buffer.from(Array.from({ length: 100 }, (_, i) => `3210000,id-${i},public,1,37.48,127.03,2026-05-01,road-${i},\n`).join(''))]));
    throw new Error(`Unexpected upstream ${url.pathname}`);
  } });
  try {
    const db = await worker.getD1Database('DB');
    const migrations = (await readdir(path.join(cloudDir, 'drizzle'))).filter(name => name.endsWith('.sql')).sort();
    for (const name of migrations) {
      const sql = await readFile(path.join(cloudDir, 'drizzle', name), 'utf8');
      await db.batch(sql.split('--> statement-breakpoint').map(part => part.trim()).filter(Boolean).map(part => db.prepare(part)));
    }
    const invoke = async (body, token = auth) => worker.dispatchFetch('https://fixture.test/api/internal/context', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-SafeNight-Collection-Token': token }, body: JSON.stringify(body) });
    assert.equal((await invoke({ action: 'start' }, 'invalid')).status, 401);
    assert.equal(requests, 0);
    let job = await (await invoke({ action: 'start' })).json();
    const id = job.id;
    for (let i = 0; i < 4; i += 1) {
      const response = await invoke({ action: 'step', job_id: id });
      assert.equal(response.status, 200, await response.clone().text());
      job = await response.json();
      assert.equal(job.status, i === 3 ? 'succeeded' : 'running');
    }
    assert.equal(job.stage_count, 4);
    const before = requests;
    assert.equal((await (await invoke({ action: 'start' })).json()).id, id);
    assert.equal(requests, before);
    const overview = await (await worker.dispatchFetch('https://fixture.test/api/internal/context', { headers: { 'X-SafeNight-Collection-Token': auth } })).json();
    assert.equal(overview.current.source_count, 4);
    assert.equal(overview.current.facility_count, 400);
    assert.equal(overview.protocol.frequency, 'daily');
  } finally { await worker.dispose(); }
});
