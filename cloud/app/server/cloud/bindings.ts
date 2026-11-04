import { env } from 'cloudflare:workers';
import { CloudStore } from './store';

export class BindingUnavailable extends Error {
  readonly code='cloud_storage_unavailable';
  constructor(){super('cloud_storage_unavailable');this.name='BindingUnavailable';}
}
export function cloudStore():CloudStore {
  if (!env.DB || !env.BUCKET) throw new BindingUnavailable();
  return new CloudStore(env.DB,env.BUCKET);
}
