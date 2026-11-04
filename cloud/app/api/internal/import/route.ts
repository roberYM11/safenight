import { env } from 'cloudflare:workers';
import { authorizedCollection,importQuery } from '../../../server/cloud/auth';
import { cloudStore } from '../../../server/cloud/bindings';
import { cloudRecord } from '../../../server/cloud/contracts';
import { finalizeJob } from '../../../server/cloud/finalize';

export const dynamic='force-dynamic';
export async function POST(request:Request) {
  if (!await authorizedCollection(request,env.SAFENIGHT_COLLECT_AUTH_TOKEN)) return Response.json({error:'unauthorized'},{status:401});
  const parsed=importQuery.safeParse(await request.json());
  if (!parsed.success) return Response.json({error:'invalid_import'},{status:400});
  const store=cloudStore();
  const job=await store.get(parsed.data.job_id);
  if (!job||job.kind!=='import') return Response.json({error:'import_job_missing'},{status:404});
  if (job.status==='succeeded') return Response.json(job);
  if (job.total_count!==null&&job.fetched_rows===job.total_count) return Response.json(await finalizeJob(store,job.id));
  if (parsed.data.page_no<job.page_no) return Response.json(job);
  if (parsed.data.page_no!==job.page_no||job.total_count===null) return Response.json({error:'unexpected_import_page'},{status:409});
  const now=new Date();const token=crypto.randomUUID();
  if (!await store.claim(job.id,token,now)) return Response.json({error:'job_busy'},{status:409});
  try {
    const records=await Promise.all(parsed.data.records.map(record=>cloudRecord(job.source,record,record.raw_sha,now,record.legacy_id)));
    const staged=await store.stage(job.id,token,{records,total_count:job.total_count,page_no:job.page_no,page_size:job.page_size},now);
    return Response.json(staged.fetched_rows===staged.total_count?await store.publish(job.id,token,new Date()):staged);
  } finally {await store.release(job.id,token,new Date());}
}
