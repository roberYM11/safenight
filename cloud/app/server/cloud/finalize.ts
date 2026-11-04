import { CloudStoreError } from './store.ts';
import type { CloudStore } from './store.ts';

/** Finish a fully staged job after a process or network interruption, without refetching. */
export async function finalizeJob(store:CloudStore,id:string,now=new Date()) {
  const job=await store.get(id);
  if(!job)throw new CloudStoreError('job_missing');
  if(job.status==='succeeded')return job;
  if(job.total_count===null||job.fetched_rows!==job.total_count)throw new CloudStoreError('invalid_page_length');
  const token=crypto.randomUUID();
  if(!await store.claim(id,token,now))throw new CloudStoreError('source_busy');
  try{return await store.publish(id,token,now);}
  finally{await store.release(id,token,new Date());}
}
