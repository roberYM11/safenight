import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { CONTEXT_SOURCE_IDS, downloadContextSource } from '../cloud/app/server/context-refresh.ts';
import { parseContextDataset } from '../cloud/app/server/context-data.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const evidence = path.join(root, '.omo/evidence/additional-sources');
const output = path.join(root, 'cloud/app/server/data/context-facilities.json');
await mkdir(evidence, { recursive: true });
const parts = [];
for (const source of CONTEXT_SOURCE_IDS) {
  parts.push(await downloadContextSource(source, new Date(), { archive: async document => {
    const suffix = document.role === 'csv' ? '.csv' : document.role === 'metadata' ? '-source.html' : document.role === 'download_page' ? '-download-page.html' : '-download-receipt.json';
    await writeFile(path.join(evidence, `${source}${suffix}`), document.bytes);
  } }));
}
const snapshot = parseContextDataset({ format: 'safenight-context-v1', sources: parts.flatMap(part => part.sources), facilities: parts.flatMap(part => part.facilities) });
await writeFile(output, JSON.stringify(snapshot) + '\n');
await writeFile(path.join(evidence, 'refresh-summary.json'), JSON.stringify({ output, facilities: snapshot.facilities.length, sources: snapshot.sources }, null, 2) + '\n');
console.log(JSON.stringify({ output, facilities: snapshot.facilities.length, sources: snapshot.sources.map(({ id, accepted_rows, rejected_rows, reference_date }) => ({ id, accepted_rows, rejected_rows, reference_date })) }));
