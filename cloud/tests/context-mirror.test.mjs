import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { CloudContextStore } from '../app/server/context-store.ts';
import { getBundledContextDataset } from '../app/server/context-data.ts';
import { CONTEXT_SOURCE_IDS, contextDefinitions } from '../app/server/context-source-parser.ts';
import { ContextMirrorError, CONTEXT_MIRROR_BASE, downloadPinnedContextMirror, parseContextMirrorManifest } from '../app/server/context-mirror.ts';

const now = new Date('2026-11-04T12:00:00.000Z');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const headerCamera = Buffer.from('sLO55sDaxKG03MO8xNq15Syw/LiuufjIoyy8s8ShuPHA+7G4utAsxKu43rbztOu89ixXR1M4NMCntbUsV0dTODSw5rW1LLWlwMzFzbHiwdjAz8DaLLzSwOfB9rW1t8647cHWvNIsvNLA58H2wfa5+MHWvNIK', 'base64');
function fixture() {
  const objects = new Map();
  const sources = CONTEXT_SOURCE_IDS.map(id => {
    const definition = contextDefinitions[id];
    const metadata = { name: `fixture-${id}`, alternateName: 'fixture_20240513', dateModified: '2026-04-22', license: { name: '이용허락범위 제한 없음', url: 'https://www.data.go.kr/ugs/selectPortalPolicyView.do' } };
    const html = `<script type="application/ld+json">${JSON.stringify(metadata)}</script>${definition.code === null ? `fn_fileDataDown('${definition.dataset}', 'uddi:aaaa-bbbb', '', '1')` : ''}`;
    const raw = [{ role: 'metadata', bytes: Buffer.from(html), url: `https://www.data.go.kr/data/${definition.dataset}/${definition.code === null ? 'fileData' : 'standard'}.do` }];
    let csv;
    if (definition.code === null) {
      raw.push({ role: 'download_receipt', bytes: Buffer.from(JSON.stringify({ status: true, atchFileId: `FILE_${definition.dataset}`, fileDetailSn: '1', dataSetFileDetailInfo: { publicDataPk: definition.dataset, dataNm: metadata.alternateName } })), url: 'https://www.data.go.kr/tcs/dss/selectFileDataDownload.do' });
      csv = id === 'songpa-lights' ? Buffer.concat([Buffer.from('vPi5+CyxuLrQLMDPt8O5+MijLMCntbUssOa1tQo=', 'base64'), ...Array.from({ length: 100 }, (_, i) => Buffer.concat([Buffer.from(`${i},`), Buffer.from('sKG3zrXu', 'base64'), Buffer.from(`,light-${i},37.5133,127.1001\n`)]))]) : Buffer.concat([Buffer.from('v6y5+CzH4MGktb8stbW3zrjtwda80izB9rn4wda80izAp7W1LLDmtbUK', 'base64'), Buffer.from(Array.from({ length: 100 }, (_, i) => `${i},district,road,address,37.48,127.03\n`).join(''))]);
    } else {
      raw.push({ role: 'download_page', bytes: Buffer.from(`<button data-download-urls="/file/download/cctv_info/info"></button><option value="${definition.code}">서울${definition.district}</option>`), url: 'https://file.localdata.go.kr/file/cctv_info/info' });
      csv = Buffer.concat([headerCamera, Buffer.from(Array.from({ length: 100 }, (_, i) => `${definition.code},id-${i},public,3,37.5133,127.1001,2026-05-01,road-${i},\n`).join(''))]);
    }
    raw.push({ role: 'csv', bytes: csv, url: definition.code === null ? `https://www.data.go.kr/cmm/cmm/fileDownload.do?atchFileId=FILE_${definition.dataset}&fileDetailSn=1` : `https://file.localdata.go.kr/file/download/cctv_info/info?orgCode=${definition.code}` });
    return { id, documents: raw.map(document => {
      const digest = hash(document.bytes); const path = `objects/${digest}.bin`; objects.set(path, document.bytes);
      return { role: document.role, official_url: document.url, sha256: digest, original_sha256: digest, representation: document.role === 'metadata' ? 'extracted_metadata' : document.role === 'download_page' ? 'extracted_download_page' : 'raw', size_bytes: document.bytes.length, content_type: 'application/octet-stream', path };
    }) };
  });
  const manifest = { format: 'safenight-context-mirror-v1', collected_at: now.toISOString(), workflow_run_id: '123', sources };
  return { manifest, objects };
}
async function usingStore(run) {
  const worker = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("fixture")}}', compatibilityDate: '2026-05-15', cf: false, d1Databases: ['DB'], r2Buckets: ['BUCKET'] });
  try {
    const db = await worker.getD1Database('DB'); const bucket = await worker.getR2Bucket('BUCKET');
    const directory = new URL('../drizzle/', import.meta.url);
    for (const file of (await readdir(directory)).filter(file => file.endsWith('.sql')).sort()) {
      const sql = await readFile(new URL(file, directory), 'utf8');
      await db.batch(sql.split('--> statement-breakpoint').map(part => part.trim()).filter(Boolean).map(part => db.prepare(part)));
    }
    await run(new CloudContextStore(db, bucket), db, bucket);
  } finally { await worker.dispose(); }
}

test('manifest rejects stale collections, arbitrary hosts/paths, role omissions, and false raw representations', () => {
  const original = fixture().manifest;
  for (const modify of [
    value => { value.collected_at = '2026-11-01T12:00:00.000Z'; },
    value => { value.sources[0].documents[0].official_url = 'https://untrusted.invalid/data'; },
    value => { value.sources[0].documents[0].path = '../private'; },
    value => { value.sources[0].documents.pop(); },
    value => { value.sources[0].documents[2].original_sha256 = '0'.repeat(64); },
  ]) {
    const candidate = structuredClone(original); modify(candidate);
    assert.throws(() => parseContextMirrorManifest(candidate, now), error => error instanceof ContextMirrorError);
  }
});

test('all four sources use one pinned manifest and preserve current data until verified publication', () => usingStore(async (store, db) => {
  const { manifest, objects } = fixture(); let manifestReads = 0;
  const fetcher = async request => {
    assert.ok(request.url.startsWith(CONTEXT_MIRROR_BASE));
    const path = request.url.slice(CONTEXT_MIRROR_BASE.length);
    if (path === 'manifest.json') { manifestReads += 1; assert.equal(manifestReads, 1); return Response.json(manifest); }
    const bytes = objects.get(path); assert.ok(bytes); return new Response(bytes);
  };
  await store.ensureSeed(getBundledContextDataset(), now); const initial = await store.current();
  let job = await store.start(now);
  for (const source of CONTEXT_SOURCE_IDS) {
    const token = await store.claim(job.id, now); assert.ok(token);
    const dataset = await downloadPinnedContextMirror(store, job.id, source, now, token, fetcher);
    assert.equal(dataset.sources[0].retrieved_at, manifest.collected_at);
    job = await store.stage(job.id, source, dataset, now, token);
    assert.equal((await store.current()).id, initial.id);
    if (job.next_source_index === 4) job = await store.publish(job.id, now, token);
    await store.release(job.id, token, now);
  }
  assert.equal(job.status, 'succeeded'); assert.equal(manifestReads, 1);
  assert.equal((await store.current()).dataset.facilities.length, 400);
  const pins = await db.prepare("SELECT COUNT(*) AS n FROM context_raw_documents WHERE job_id=? AND role='mirror_manifest'").bind(job.id).first();
  assert.equal(pins.n, 1);
}));

test('tampered mirror bytes are rejected before staging and leave the current snapshot unchanged', () => usingStore(async store => {
  const { manifest, objects } = fixture(); const badPath = manifest.sources[0].documents[2].path;
  const fetcher = async request => {
    const path = request.url.slice(CONTEXT_MIRROR_BASE.length);
    if (path === 'manifest.json') return Response.json(manifest);
    const bytes = Buffer.from(objects.get(path)); if (path === badPath) bytes[bytes.length - 2] ^= 1;
    return new Response(bytes);
  };
  await store.ensureSeed(getBundledContextDataset(), now); const initial = await store.current();
  const job = await store.start(now); const token = await store.claim(job.id, now);
  await assert.rejects(downloadPinnedContextMirror(store, job.id, 'songpa-lights', now, token, fetcher), error => error instanceof ContextMirrorError && error.code === 'context_mirror_digest_mismatch');
  assert.equal((await store.get(job.id)).stage_count, 0);
  assert.equal((await store.current()).id, initial.id);
}));

test('a correctly hashed receipt pointing at a different file is rejected by the source chain', () => usingStore(async store => {
  const { manifest, objects } = fixture(); const receipt = manifest.sources[0].documents[1];
  const replacement = Buffer.from(JSON.stringify({ status: true, atchFileId: 'FILE_99999', fileDetailSn: '1' }));
  receipt.sha256 = hash(replacement); receipt.original_sha256 = receipt.sha256; receipt.path = `objects/${receipt.sha256}.bin`; receipt.size_bytes = replacement.length; objects.set(receipt.path, replacement);
  const fetcher = async request => { const path = request.url.slice(CONTEXT_MIRROR_BASE.length); return path === 'manifest.json' ? Response.json(manifest) : new Response(objects.get(path)); };
  const job = await store.start(now); const token = await store.claim(job.id, now);
  await assert.rejects(downloadPinnedContextMirror(store, job.id, 'songpa-lights', now, token, fetcher), error => error instanceof ContextMirrorError && error.code === 'context_mirror_chain_invalid');
  assert.equal((await store.get(job.id)).stage_count, 0);
}));

test('yesterday Korean-calendar collection cannot count as today even when less than thirty-six hours old', () => usingStore(async store => {
  const { manifest } = fixture(); manifest.collected_at = '2026-11-03T14:30:00.000Z';
  const job = await store.start(now); const token = await store.claim(job.id, now); let calls = 0;
  await assert.rejects(downloadPinnedContextMirror(store, job.id, 'songpa-lights', now, token, async () => { calls += 1; return Response.json(manifest); }), error => error instanceof ContextMirrorError && error.code === 'context_mirror_not_current_day');
  assert.equal(calls, 1);
  assert.equal((await store.get(job.id)).stage_count, 0);
}));
