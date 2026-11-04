import { canonicalJson, sha256 } from '../cloud/contracts.ts';

export class PipelineError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = 'PipelineError'; this.code = code; }
}

/** Upload first; callers publish references only after reading back the exact hash. */
export async function putJson(bucket: R2Bucket, prefix: string, value: unknown) {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const digest = await sha256(bytes);
  const object_key = `${prefix}/${digest}.json`;
  if (!await bucket.head(object_key)) await bucket.put(object_key, bytes, { httpMetadata: { contentType: 'application/json' }, customMetadata: { sha256: digest } });
  await readBytes(bucket, object_key, digest);
  return { object_key, sha256: digest };
}

export async function readBytes(bucket: R2Bucket, key: string, digest: string): Promise<Uint8Array> {
  const object = await bucket.get(key);
  if (!object) throw new PipelineError('object_missing');
  if (object.size > 32 * 1024 * 1024) throw new PipelineError('object_too_large');
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (await sha256(bytes) !== digest) throw new PipelineError('object_digest_mismatch');
  return bytes;
}

export async function readJson(bucket: R2Bucket, key: string, digest: string): Promise<unknown> {
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readBytes(bucket, key, digest)));
}
