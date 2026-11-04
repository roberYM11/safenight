import { z } from 'zod';

/** Protect unattended writers even if the Site audience changes later. */
export async function authorizedCollection(request:Request, expected:string|undefined):Promise<boolean> {
  const supplied = request.headers.get('X-SafeNight-Collection-Token');
  if (!expected || expected.length < 32 || !supplied || supplied.length > 4096) return false;
  const hash = async (value:string) => new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)));
  const [left,right] = await Promise.all([hash(expected),hash(supplied)]);
  return left.reduce((difference,value,index)=>difference|(value^right[index]),0)===0;
}
export const importQuery = z.object({
  job_id:z.string().min(1).max(100), page_no:z.number().int().positive(),
  records:z.array(z.object({
    entity_id:z.string().min(1), observed_at:z.iso.datetime({offset:true}),
    published_at:z.iso.datetime({offset:true}), revision_rank:z.number().int().nonnegative(),
    source_updated_at:z.iso.datetime({offset:true}).nullable(), payload_json:z.string().max(50000),
    lat:z.number().finite().min(-90).max(90).nullable(), lon:z.number().finite().min(-180).max(180).nullable(),
    raw_sha:z.string().regex(/^[a-f0-9]{64}$/), legacy_id:z.string().nullable().default(null),
  }).readonly()).min(1).max(200),
}).readonly();
