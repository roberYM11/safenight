import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

async function workerRequest(status) {
  const result=await build({stdin:{contents:`
    import {requestPage,ProviderError} from './app/server/cloud/providers.ts';
    export default {async fetch(){let calls=0;let port=null;try{
      const response=await requestPage({source:'sdot',day:'2026-11-03',page_no:1,page_size:1,full_snapshot:false},{sdot:'fixture-only-key'},AbortSignal.timeout(8000),async request=>{
        calls++;port=new URL(request.url).port;
        return new Response('{}',{status:${status},headers:{Location:'https://untrusted.invalid/'}});
      });return Response.json({calls,port,bytes:response.body.length});
    }catch(error){if(error instanceof ProviderError)return Response.json({calls,port,error:error.code});throw error;}}};
  `,resolveDir:path.resolve('.')},bundle:true,format:'esm',platform:'browser',write:false,target:'es2022'});
  const mf=new Miniflare({modules:true,compatibilityDate:'2026-05-15',cf:false,script:result.outputFiles[0].text});
  try{return await(await mf.dispatchFetch('https://example.test/')).json();}
  finally{await mf.dispose();}
}
test('constructs bounded provider requests in the actual Worker runtime',async()=>{
  assert.deepEqual(await workerRequest(200),{calls:1,port:'8088',bytes:2});
});
test('rejects redirects without forwarding the provider credential',async()=>{
  assert.deepEqual(await workerRequest(302),{calls:1,port:'8088',error:'sdot_http_error'});
});
