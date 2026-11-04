import { env } from 'cloudflare:workers';
import { authorizedCollection } from '../../../server/cloud/auth';
import { cloudStore } from '../../../server/cloud/bindings';
import { sourceSchema,sha256 } from '../../../server/cloud/contracts';

export const dynamic='force-dynamic';
export async function POST(request:Request) {
  if (!await authorizedCollection(request,env.SAFENIGHT_COLLECT_AUTH_TOKEN)) return Response.json({error:'unauthorized'},{status:401});
  const query=new URL(request.url).searchParams;
  const source=sourceSchema.safeParse(query.get('source'));
  const backup=query.get('purpose')==='backup';
  if (!backup&&!source.success) return Response.json({error:'invalid_source'},{status:400});
  const length=Number(request.headers.get('Content-Length'));
  if (!Number.isFinite(length)||length<1||length>8*1024*1024) return Response.json({error:'invalid_raw_size'},{status:413});
  const bytes=new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength!==length) return Response.json({error:'invalid_raw_size'},{status:400});
  if(backup){
    if(!env.BUCKET)return Response.json({error:'cloud_storage_unavailable'},{status:503});
    const sha=await sha256(bytes);const key=`backups/${sha}`;
    await env.BUCKET.put(key,bytes,{customMetadata:{origin:'native-migration',source:(query.get('source')??'native_postgres').slice(0,80)}});
    return Response.json({sha,key,bytes:bytes.length},{headers:{'Cache-Control':'no-store'}});
  }
  if(!source.success)return Response.json({error:'invalid_source'},{status:400});
  const sha=await cloudStore().archive(source.data,bytes,new Date());
  return Response.json({sha,bytes:bytes.length},{headers:{'Cache-Control':'no-store'}});
}
