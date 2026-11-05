import { env } from 'cloudflare:workers';
import { z } from 'zod';
import { authorizedCollection } from '../../../server/cloud/auth';
import { BindingUnavailable,cloudStore } from '../../../server/cloud/bindings';
import { sourceSchema } from '../../../server/cloud/contracts';
import { JobError,planDue,step } from '../../../server/cloud/jobs';
import { ProviderError,parsePage,requestPage } from '../../../server/cloud/providers';
import { CloudStoreError } from '../../../server/cloud/store';
import { finalizeJob } from '../../../server/cloud/finalize';

export const dynamic='force-dynamic';
const day=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value=>{
  const date=new Date(`${value}T00:00:00+09:00`);
  return Number.isFinite(date.getTime())&&new Date(date.getTime()+9*3600000).toISOString().slice(0,10)===value;
});
const command=z.discriminatedUnion('action',[
  z.object({action:z.literal('due')}),
  z.object({action:z.literal('probe')}),
  z.object({action:z.literal('step'),job_id:z.string().min(1).max(100)}),
  z.object({action:z.literal('finalize'),job_id:z.string().min(1).max(100)}),
  z.object({action:z.literal('start'),source:sourceSchema,day,kind:z.enum(['collect','import']).default('collect'),expected_count:z.number().int().nonnegative().max(500000).optional()}),
  z.object({action:z.literal('sync_locations'),day,expected_count:z.number().int().positive().max(500000),location_sha256:z.string().regex(/^[a-f0-9]{64}$/)}),
]);
const headers={'Cache-Control':'no-store'};
function failure(error:unknown):Response {
  if(error instanceof CloudStoreError) return Response.json({error:error.code},{status:409,headers});
  if(error instanceof ProviderError||error instanceof JobError) return Response.json({error:error.code},{status:502,headers});
  if(error instanceof BindingUnavailable) return Response.json({error:error.code},{status:503,headers});
  if(error instanceof SyntaxError) return Response.json({error:'invalid_json'},{status:400,headers});
  throw error;
}
export async function GET(request:Request) {
  if(!await authorizedCollection(request,env.SAFENIGHT_COLLECT_AUTH_TOKEN))return Response.json({error:'unauthorized'},{status:401,headers});
  try {
    const jobId=new URL(request.url).searchParams.get('job_id');
    if(jobId)return Response.json(await cloudStore().get(jobId),{headers});
    return Response.json({...(await cloudStore().overview()),protocol:{source:'sdot',writer:'/api/internal/collection',actions:['due','step','start','sync_locations'],step_limit:'one_page_200_rows',clock:'Asia/Seoul',collection_hour:3,correction_days:7,instructions:'/CLOUD_OPERATIONS.md'}},{headers});
  } catch(error) {return failure(error);}
}
export async function POST(request:Request) {
  if(!await authorizedCollection(request,env.SAFENIGHT_COLLECT_AUTH_TOKEN))return Response.json({error:'unauthorized'},{status:401,headers});
  if(Number(request.headers.get('Content-Length'))>8192)return Response.json({error:'request_too_large'},{status:413,headers});
  try {
    const parsed=command.safeParse(await request.json());
    if(!parsed.success)return Response.json({error:'invalid_collection_command'},{status:400,headers});
    const store=cloudStore();const now=new Date();const keys={sdot:env.SAFENIGHT_SDOT_API_KEY??''};
    const yesterday=new Date(now.getTime()+9*3600000-86400000).toISOString().slice(0,10);
    switch(parsed.data.action) {
      case 'start': {
        if(parsed.data.kind==='collect'&&(parsed.data.source!=='sdot'||parsed.data.day>yesterday))return Response.json({error:'completed_sdot_day_required'},{status:400,headers});
        return Response.json(await store.start({source:parsed.data.source,day:parsed.data.day,kind:parsed.data.kind,...(parsed.data.expected_count===undefined?{}:{expected_count:parsed.data.expected_count})},now),{headers});
      }
      case 'sync_locations':return Response.json(await store.start({source:'sensor_locations',kind:'import',day:parsed.data.day,
        expected_count:parsed.data.expected_count,location_sha256:parsed.data.location_sha256},now),{headers});
      case 'step':return Response.json(await step(store,parsed.data.job_id,keys,now,requestPage,()=>new Date()),{headers});
      case 'finalize':return Response.json(await finalizeJob(store,parsed.data.job_id,now),{headers});
      case 'probe': {
        const query={source:'sdot',day:yesterday,page_no:1,page_size:1,full_snapshot:false} as const;
        const response=await requestPage(query,keys,AbortSignal.timeout(8000));
        const raw_sha=await store.archive('sdot',response.body,now);
        const page=parsePage(response.body,query);
        return Response.json({provider:'sdot',total_count:page.total_count,sample_rows:page.records.length,raw_sha},{headers});
      }
      case 'due': {
        const overview=await store.overview();
        const covered_until=overview.checkpoints.find(checkpoint=>checkpoint.source==='sdot')?.covered_until??null;
        const plan=planDue({now,covered_until,jobs:overview.jobs});
        const pending=plan.pending_job_ids[0];
        if(pending)return Response.json({plan,job:await store.get(pending)},{headers});
        const next=plan.days[0];
        if(plan.status!=='ready'||!next)return Response.json({plan,job:null},{headers});
        const job=await store.start({source:'sdot',day:next,kind:'collect'},now);
        return Response.json({plan,job},{headers});
      }
      default:return unreachable(parsed.data);
    }
  } catch(error) {return failure(error);}
}
function unreachable(value:never):never {throw new TypeError(`Unexpected collection operation: ${String(value)}`);}
