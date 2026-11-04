import { z } from 'zod';
import { parseContextDataset } from './context-data.ts';
import type { ContextDataset } from './context-data.ts';

export const contextSourceIdSchema = z.enum(['songpa-lights', 'seocho-lights', 'songpa-cctv', 'seocho-cctv']);
export type ContextSourceId = z.infer<typeof contextSourceIdSchema>;
export const CONTEXT_SOURCE_IDS = contextSourceIdSchema.options;
export const contextDefinitions = {
  'songpa-lights': { district: '송파구', dataset: '15097746', code: null },
  'seocho-lights': { district: '서초구', dataset: '15128039', code: null },
  'songpa-cctv': { district: '송파구', dataset: '15013094', code: '3230000' },
  'seocho-cctv': { district: '서초구', dataset: '15013094', code: '3210000' },
} satisfies Record<ContextSourceId, Readonly<{ district: string; dataset: string; code: string | null }>>;
export type ContextRefreshCode = 'invalid_source' | 'source_http_error' | 'source_timeout' | 'source_too_large' |
  'source_transport_error' | 'source_metadata_changed' | 'source_license_changed' | 'source_download_changed' |
  'source_encoding_invalid' | 'source_csv_invalid' | 'source_schema_changed' | 'source_coverage_loss';
export class ContextRefreshError extends Error {
  readonly code: ContextRefreshCode;
  constructor(code: ContextRefreshCode) { super(code); this.name = 'ContextRefreshError'; this.code = code; }
}
const metadataSchema = z.object({
  name: z.string().min(1), alternateName: z.string().optional(), dateModified: z.iso.date(),
  license: z.object({ name: z.string(), url: z.url() }),
});
export type SourceMetadata = z.infer<typeof metadataSchema>;
export function parseContextMetadata(html: string): SourceMetadata {
  const match = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  if (!match) throw new ContextRefreshError('source_metadata_changed');
  let value: unknown;
  try { value = JSON.parse(match[1]); } catch { throw new ContextRefreshError('source_metadata_changed'); }
  const result = metadataSchema.safeParse(value);
  if (!result.success) throw new ContextRefreshError('source_metadata_changed');
  if (result.data.license.name !== '이용허락범위 제한 없음') throw new ContextRefreshError('source_license_changed');
  return result.data;
}
function parseCsv(text: string): readonly (readonly string[])[] {
  const rows: string[][] = []; let row: string[] = []; let value = ''; let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { value += '"'; i += 1; } else quoted = !quoted;
    } else if (!quoted && (char === ',' || char === '\n')) {
      row.push(value.replace(/\r$/, '')); value = '';
      if (char === '\n') { if (row.some(Boolean)) rows.push(row); row = []; }
    } else value += char;
  }
  if (quoted) throw new ContextRefreshError('source_csv_invalid');
  if (value || row.length) { row.push(value.replace(/\r$/, '')); rows.push(row); }
  return rows;
}
const lightHeaders: Readonly<Record<'songpa-lights' | 'seocho-lights', readonly string[]>> = {
  'songpa-lights': ['순번', '구분', '일련번호', '위도', '경도'],
  'seocho-lights': ['연번', '행정동', '도로명주소', '지번주소', '위도', '경도'],
};
const cctvHeaders = ['개방자치단체코드', '관리번호', '설치목적구분', '카메라대수', 'WGS84위도', 'WGS84경도', '데이터기준일자', '소재지도로명주소', '소재지지번주소'];
const lightKinds: Readonly<Record<string, string>> = { 가로등: 'streetlight', 보안등: 'security_light' };
type ParseInput = Readonly<{ source_id: ContextSourceId; bytes: Uint8Array; sha256: string; metadata: SourceMetadata; download_url: string; now: Date }>;

export function parseContextCsv(input: ParseInput): ContextDataset {
  let text: string;
  try { text = new TextDecoder('euc-kr', { fatal: true }).decode(input.bytes).replace(/^\uFEFF/, ''); }
  catch { throw new ContextRefreshError('source_encoding_invalid'); }
  const [headers, ...rows] = parseCsv(text);
  if (!headers) throw new ContextRefreshError('source_schema_changed');
  const definition = contextDefinitions[input.source_id];
  const isCamera = definition.code !== null;
  const expected = input.source_id === 'songpa-lights' ? lightHeaders['songpa-lights'] : lightHeaders['seocho-lights'];
  if (isCamera ? cctvHeaders.some(header => !headers.includes(header)) : JSON.stringify(headers) !== JSON.stringify(expected)) throw new ContextRefreshError('source_schema_changed');
  const seen = new Set<string>(); const facilities: unknown[] = []; const referenceDates: string[] = []; let rejected = 0;
  const referenceMatch = input.metadata.alternateName?.match(/_(\d{4})(\d{2})(\d{2})$/);
  const lightReference = referenceMatch ? `${referenceMatch[1]}-${referenceMatch[2]}-${referenceMatch[3]}` : null;
  if (!isCamera && !z.iso.date().safeParse(lightReference).success) throw new ContextRefreshError('source_metadata_changed');
  for (const row of rows) {
    const record: Readonly<Record<string, string>> = Object.fromEntries(headers.map((header, index) => [header, row[index]?.trim() ?? '']));
    const lat = Number(record[isCamera ? 'WGS84위도' : '위도']); const lon = Number(record[isCamera ? 'WGS84경도' : '경도']);
    const localId = isCamera ? record['관리번호'] : record['순번'] || record['연번'];
    const kind = isCamera ? 'cctv' : input.source_id === 'songpa-lights' ? lightKinds[record['구분']] : 'security_light';
    const cameraCount = Number(record['카메라대수']); const referenceDate = record['데이터기준일자'];
    if (row.length !== headers.length || !localId || !kind || seen.has(localId) || !Number.isFinite(lat) || !Number.isFinite(lon) || lat < 37.4 || lat > 37.72 || lon < 126.7 || lon > 127.2 || (isCamera && (record['개방자치단체코드'] !== definition.code || !/^\d+$/.test(record['카메라대수']) || !Number.isSafeInteger(cameraCount) || cameraCount < 1 || cameraCount > 1000 || !z.iso.date().safeParse(referenceDate).success))) { rejected += 1; continue; }
    seen.add(localId);
    const address = record[isCamera ? '소재지도로명주소' : '도로명주소'] || record[isCamera ? '소재지지번주소' : '지번주소'] || null;
    const name = isCamera ? `${record['설치목적구분'] || '공공'} CCTV ${localId}` : input.source_id === 'songpa-lights' ? `${record['구분']} ${record['일련번호']}` : `${record['행정동']} 보안등 ${localId}`;
    const facility = [input.source_id, kind, `${input.source_id}:${localId}`, name, lat, lon, address];
    if (isCamera) { facilities.push([...facility, cameraCount, referenceDate]); referenceDates.push(referenceDate); }
    else facilities.push(facility);
  }
  if (facilities.length < 100 || rejected / rows.length > 0.05) throw new ContextRefreshError('source_coverage_loss');
  referenceDates.sort();
  const source = {
    id: input.source_id, title: isCamera ? `행정안전부 CCTV정보 · ${definition.district}` : input.metadata.name,
    url: `https://www.data.go.kr/data/${definition.dataset}/${isCamera ? 'standard' : 'fileData'}.do`, download_url: input.download_url,
    license: input.metadata.license.name, license_url: input.metadata.license.url, updated_at: input.metadata.dateModified,
    reference_date: isCamera ? referenceDates[0] : lightReference, ...(isCamera ? { reference_date_end: referenceDates.at(-1) } : {}), retrieved_at: input.now.toISOString(), district: definition.district,
    coverage_note: isCamera ? `${definition.district} 공개 설치기록의 카메라대수를 합산합니다. 기준일 이후 변경·현재 작동·촬영범위는 확인되지 않습니다. 일부 원천 좌표는 반올림되어 거리와 반경 집계에 오차가 있습니다. 같은 위치에 여러 관리번호가 있어 설치기록 수는 물리적 지점 수와 다를 수 있습니다. 영상·IP 주소는 제공하지 않습니다.` : `${definition.district} 공개자료의 설치 위치입니다. 기준일 이후 변경·철거와 현재 점등 상태는 확인되지 않습니다. 공개자료 미등록은 시설 부재를 뜻하지 않습니다.`,
    raw_sha256: input.sha256, source_rows: rows.length, accepted_rows: facilities.length, rejected_rows: rejected,
  };
  return parseContextDataset({ format: 'safenight-context-v1', sources: [source], facilities });
}
