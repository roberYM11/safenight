import { env } from 'cloudflare:workers';
import modelText from '../../../server/data/model.json?raw';
import manifestText from '../../../server/data/manifest.json?raw';
import { cloudStore } from '../../../server/cloud/bindings';
import { pipelineHttp } from '../../../server/pipeline/http';

export const dynamic = 'force-dynamic';
function handle(request: Request) {
  const { db, bucket } = cloudStore();
  return pipelineHttp(request, { db, bucket, token: env.SAFENIGHT_COLLECT_AUTH_TOKEN, modelText, manifestText });
}
export const GET = handle;
export const POST = handle;
