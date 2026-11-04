import modelText from './data/model.json?raw';
import manifestText from './data/manifest.json?raw';
import { assess,loadBundle } from './forest';
import type { Bundle } from './forest';
import { cloudStore } from './cloud/bindings';

// One immutable model per isolate; observations always come from committed cloud DB rows.
let bundlePromise:Promise<Bundle>|undefined;
export function getBundle():Promise<Bundle>{return bundlePromise??=loadBundle(modelText,manifestText);}

export async function buildMap(now=new Date()) {
  const store=cloudStore();
  const [bundle,observations,overview]=await Promise.all([getBundle(),store.sensors(),store.overview()]);
  const metadata=bundle.metadata;
  const last=overview.jobs.find(job=>job.source==='sdot'&&job.kind==='collect'&&job.status==='succeeded');
  return {
    generated_at:now.toISOString(),captured_at:last?.finished_at??null,data_status:'cloud',
    data_note:last?'클라우드에서 수집한 관측자료입니다.':'클라우드 DB로 이전한 관측자료입니다.',
    model:{name:metadata.name,version:metadata.version,experimental:true,target:metadata.target,features:metadata.features,training_rows:metadata.training_rows,validation_mae:metadata.validation_mae,validation_r2:metadata.validation_r2,validation_note:metadata.validation_note,status:'ready'},
    sensors:observations.sensors.map(sensor=>{const result=assess(bundle,sensor,now);return {...sensor,score:result.score,status:result.status};}),
    total_sensors:observations.total_sensors,unlocated_sensors:observations.unlocated_sensors,
  };
}
export async function assessSensor(sensorId:string,now=new Date()) {
  const [bundle,observations]=await Promise.all([getBundle(),cloudStore().sensors()]);
  return assess(bundle,observations.sensors.find(sensor=>sensor.sensor_id===sensorId)??null,now);
}
