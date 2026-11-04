import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTEXT_SOURCE_IDS, ContextRefreshError, downloadContextSource } from '../cloud/app/server/context-refresh.ts';
import { contextDefinitions, parseContextMetadata } from '../cloud/app/server/context-source-parser.ts';

// Public data only. No government key, Sites token, environment file or browser session is read.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FORMAT = 'safenight-context-mirror-v1';
const MAX_OBJECT_BYTES = 10 * 1024 * 1024;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
class MirrorError extends Error {
  constructor(code) { super(code); this.name = 'MirrorError'; this.code = code; }
}

function options() {
  let output = path.join(ROOT, '.omo/evidence/mirror-public'), verifyOnly = false;
  for (let i = 2; i < process.argv.length; i++) {
    switch (process.argv[i]) {
      case '--output': if (!process.argv[i + 1]) throw new MirrorError('mirror_output_required'); output = path.resolve(process.argv[++i]); break;
      case '--verify-only': verifyOnly = true; break;
      default: throw new MirrorError('mirror_invalid_argument');
    }
  }
  if (output === ROOT || output === path.parse(output).root) throw new MirrorError('mirror_unsafe_output');
  return { output, verifyOnly };
}

async function prepare(output) {
  await mkdir(output, { recursive: true });
  if (!(await lstat(output)).isDirectory() || (await lstat(output)).isSymbolicLink()) throw new MirrorError('mirror_unsafe_output');
  for (const entry of await readdir(output, { withFileTypes: true })) {
    if (!['.git', 'objects', 'snapshots', 'manifest.json'].includes(entry.name) || entry.isSymbolicLink()) throw new MirrorError('mirror_unexpected_file');
  }
  for (const directory of ['objects', 'snapshots']) {
    const target = path.join(output, directory);
    await mkdir(target, { recursive: true });
    const stat = await lstat(target);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new MirrorError('mirror_unsafe_directory');
    for (const entry of await readdir(target, { withFileTypes: true })) {
      const pattern = directory === 'objects' ? /^[a-f0-9]{64}\.bin$/ : /^[a-f0-9]{64}\.json$/;
      if (!entry.isFile() || entry.isSymbolicLink() || !pattern.test(entry.name)) throw new MirrorError('mirror_unexpected_artifact');
    }
  }
}

function publicRepresentation(document) {
  if (document.role === 'csv' || document.role === 'download_receipt') {
    if (document.role === 'download_receipt') {
      const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(document.bytes));
      if (/"[^"\n]*(?:token|password|authorization|cookie|secret)[^"\n]*"\s*:/i.test(JSON.stringify(value))) throw new MirrorError('mirror_unsafe_receipt');
    }
    return { bytes: document.bytes, representation: 'raw', content_type: document.content_type };
  }
  const definition = contextDefinitions[document.source_id];
  const html = new TextDecoder('utf-8', { fatal: true }).decode(document.bytes);
  let extracted;
  switch (document.role) {
    case 'metadata': {
      const metadata = parseContextMetadata(html);
      const json = JSON.stringify({ '@context': 'https://schema.org', '@type': 'Dataset', ...metadata, url: document.url }).replace(/</g, '\\u003c');
      extracted = `<script type="application/ld+json">${json}</script>\n`;
      if (definition.code === null) {
        const call = html.match(/fn_fileDataDown\('([0-9]+)',\s*'([^']+)',\s*'([^']*)',\s*'([^']+)'/);
        if (!call || call[1] !== definition.dataset || !/^uddi:[0-9a-f-]+$/i.test(call[2]) || (call[3] && !/^FILE_\d+$/.test(call[3])) || !/^\d+$/.test(call[4])) throw new MirrorError('mirror_download_reference_invalid');
        extracted += `<button onclick="fn_fileDataDown('${call[1]}','${call[2]}','${call[3]}','${call[4]}')">공개자료 내려받기</button>\n`;
      }
      break;
    }
    case 'download_page':
      if (definition.code === null || !html.includes('data-download-urls="/file/download/cctv_info/info"') || !html.includes(`value="${definition.code}">서울${definition.district}</option>`)) throw new MirrorError('mirror_download_reference_invalid');
      extracted = `<button data-download-urls="/file/download/cctv_info/info"></button>\n<select><option value="${definition.code}">서울${definition.district}</option></select>\n`;
      break;
    default: throw new MirrorError('mirror_unknown_document_role');
  }
  return { bytes: new TextEncoder().encode(extracted), representation: document.role === 'metadata' ? 'extracted_metadata' : 'extracted_download_page', content_type: 'text/html; charset=utf-8' };
}

async function immutable(file, bytes) {
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== bytes.byteLength || digest(await readFile(file)) !== digest(bytes)) throw new MirrorError('mirror_immutable_conflict');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await writeFile(file, bytes, { flag: 'wx' });
  }
}

async function verify(output) {
  const bytes = await readFile(path.join(output, 'manifest.json'));
  if (bytes.byteLength > 128 * 1024) throw new MirrorError('mirror_manifest_too_large');
  const manifest = JSON.parse(bytes);
  if (manifest.format !== FORMAT || !Number.isFinite(Date.parse(manifest.collected_at)) || !/^(?:local|\d{1,20})$/.test(manifest.workflow_run_id) || manifest.sources?.length !== CONTEXT_SOURCE_IDS.length) throw new MirrorError('mirror_manifest_invalid');
  let documentCount = 0;
  for (const [index, source] of manifest.sources.entries()) {
    if (source.id !== CONTEXT_SOURCE_IDS[index] || source.documents?.length !== 3) throw new MirrorError('mirror_source_contract_invalid');
    const expectedRoles = contextDefinitions[source.id].code === null ? ['metadata', 'download_receipt', 'csv'] : ['metadata', 'download_page', 'csv'];
    for (const [position, document] of source.documents.entries()) {
      if (document.role !== expectedRoles[position] || !/^[a-f0-9]{64}$/.test(document.sha256) || !/^[a-f0-9]{64}$/.test(document.original_sha256) || document.path !== `objects/${document.sha256}.bin` || !Number.isInteger(document.size_bytes) || document.size_bytes < 0 || document.size_bytes > MAX_OBJECT_BYTES) throw new MirrorError('mirror_document_contract_invalid');
      const expectedRepresentation = document.role === 'metadata' ? 'extracted_metadata' : document.role === 'download_page' ? 'extracted_download_page' : 'raw';
      if (document.representation !== expectedRepresentation || (expectedRepresentation === 'raw' && document.original_sha256 !== document.sha256)) throw new MirrorError('mirror_representation_invalid');
      const official = new URL(document.official_url);
      if (official.protocol !== 'https:' || !['www.data.go.kr', 'file.localdata.go.kr'].includes(official.hostname) || official.username || official.password || official.hash || official.port) throw new MirrorError('mirror_official_url_invalid');
      const object = await readFile(path.join(output, document.path));
      if (object.byteLength !== document.size_bytes || digest(object) !== document.sha256) throw new MirrorError('mirror_document_digest_mismatch');
      documentCount++;
    }
  }
  const sha256 = digest(bytes);
  if (digest(await readFile(path.join(output, `snapshots/${sha256}.json`))) !== sha256) throw new MirrorError('mirror_snapshot_digest_mismatch');
  return { format: FORMAT, collected_at: manifest.collected_at, workflow_run_id: manifest.workflow_run_id, sources: manifest.sources.length, documents: documentCount, manifest_sha256: sha256 };
}

async function main() {
  const { output, verifyOnly } = options();
  await prepare(output);
  if (verifyOnly) { console.log(JSON.stringify({ verified: true, ...await verify(output) })); return; }
  const workflowRunId = process.env.GITHUB_RUN_ID ?? 'local';
  if (!/^(?:local|\d{1,20})$/.test(workflowRunId)) throw new MirrorError('mirror_workflow_id_invalid');
  const sources = [];
  for (const id of CONTEXT_SOURCE_IDS) {
    const documents = [];
    const dataset = await downloadContextSource(id, new Date(), { archive: async document => {
      if (document.source_id !== id || digest(document.bytes) !== document.sha256) throw new MirrorError('mirror_original_digest_mismatch');
      const published = publicRepresentation(document);
      const sha256 = digest(published.bytes), relativePath = `objects/${sha256}.bin`;
      await immutable(path.join(output, relativePath), published.bytes);
      documents.push({ role: document.role, official_url: document.url, representation: published.representation, original_sha256: document.sha256, sha256, size_bytes: published.bytes.byteLength, content_type: published.content_type, path: relativePath });
    } });
    sources.push({ id, documents });
    console.log(JSON.stringify({ source: id, documents: documents.length, accepted_rows: dataset.facilities.length }));
  }
  const manifest = { format: FORMAT, collected_at: new Date().toISOString(), workflow_run_id: workflowRunId, sources };
  const bytes = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`), sha256 = digest(bytes);
  await immutable(path.join(output, `snapshots/${sha256}.json`), bytes);
  await writeFile(path.join(output, 'manifest.json'), bytes);
  console.log(JSON.stringify({ verified: true, ...await verify(output) }));
}

await main().catch(error => {
  console.error(JSON.stringify({ error: error instanceof MirrorError || error instanceof ContextRefreshError ? error.code : 'mirror_collection_failed' }));
  process.exitCode = 1;
});
