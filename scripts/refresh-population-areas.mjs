import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Downloads the official boundary release, not population observations or user locations.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceUrl = 'https://data.seoul.go.kr/dataList/OA-21285/F/1/datasetView.do';
const downloadUrl = 'https://datafile.seoul.go.kr/bigfile/iot/inf/nio_download.do?useCache=false';
const evidence = path.join(root, '.omo/evidence/population-source');
const html = await (await fetch(sourceUrl, { signal: AbortSignal.timeout(15000) })).text();
const match = /title="(서울시 주요\s*(\d+)장소 영역\.zip)"[^>]*downloadFile\('(\d+)'\)/.exec(html);
if (!match) throw new Error('official_boundary_attachment_missing');
const response = await fetch(downloadUrl, { method: 'POST', body: new URLSearchParams({ infId: 'OA-21285', seq: match[3], infSeq: '2' }), headers: { Referer: sourceUrl }, signal: AbortSignal.timeout(15000) });
if (!response.ok) throw new Error('official_boundary_download_failed');
const bytes = Buffer.from(await response.arrayBuffer());
if (bytes.length > 4 * 1024 * 1024 || bytes.readUInt32LE(0) !== 0x04034b50) throw new Error('invalid_boundary_archive');
await mkdir(evidence, { recursive: true });
const archive = path.join(evidence, 'population-areas.zip');
await writeFile(archive, bytes);
// Python standard library only: read the official WGS84 shapefile and UTF-8 DBF without reprojection.
const parser = String.raw`
import json,math,struct,sys,zipfile
with zipfile.ZipFile(sys.argv[1]) as archive:
 def member(suffix):
  names=[name for name in archive.namelist() if name.endswith(suffix)]
  assert len(names)==1
  return archive.read(names[0])
 assert member('.cpg').decode().strip().upper()=='UTF-8'
 assert 'WGS_1984' in member('.prj').decode()
 dbf=member('.dbf'); shp=member('.shp')
 count,header,row_length=struct.unpack_from('<IHH',dbf,4)
 assert 1<=count<=300 and struct.unpack_from('<i',shp,32)[0]==5
 fields=[]
 for offset in range(32,header-1,32):
  item=dbf[offset:offset+32]
  if item[0]==13:break
  fields.append((item[:11].split(b'\0')[0].decode(),item[16]))
 records=[]
 for row_index in range(count):
  row=dbf[header+row_index*row_length:header+(row_index+1)*row_length]
  assert len(row)==row_length and row[0]==32
  record={}; offset=1
  for name,size in fields:
   record[name]=row[offset:offset+size].decode('utf8').strip(); offset+=size
  records.append(record)
 areas=[]; offset=100; index=0
 while offset<len(shp):
  record_number,words=struct.unpack_from('>2i',shp,offset); data=shp[offset+8:offset+8+words*2]; offset+=8+words*2
  assert struct.unpack_from('<i',data,0)[0]==5
  bbox=list(struct.unpack_from('<4d',data,4)); part_count,point_count=struct.unpack_from('<2i',data,36)
  assert 1<=part_count<=100 and 4<=point_count<=100000
  starts=list(struct.unpack_from('<'+'i'*part_count,data,44))+[point_count]
  point_offset=44+4*part_count
  points=[list(struct.unpack_from('<2d',data,point_offset+16*i)) for i in range(point_count)]
  assert all(all(math.isfinite(value) for value in point) and 126<=point[0]<=128 and 37<=point[1]<=38 for point in points)
  rings=[points[starts[i]:starts[i+1]] for i in range(part_count)]
  assert all(len(ring)>=4 and ring[0]==ring[-1] for ring in rings)
  record=records[index]; index+=1
  areas.append({'code':record['AREA_CD'],'name':record['AREA_NM'],'category':record['CATEGORY'],'bbox':bbox,'rings':rings})
 assert len(areas)==count and len(set(area['code'] for area in areas))==count
 print(json.dumps(areas,ensure_ascii=False,separators=(',',':')))
`;
const areas = JSON.parse(execFileSync('python3', ['-c', parser, archive], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }));
if (areas.length !== Number(match[2])) throw new Error('boundary_count_mismatch');
const rowText = html.slice(match.index, html.indexOf('</tr>', match.index));
const date = /(20\d{2})\.(\d{2})\.(\d{2})\./.exec(rowText);
const result = {
  source: '서울특별시 주요 장소 영역', source_url: sourceUrl, download_url: downloadUrl,
  source_filename: match[1], source_published_at: date ? `${date[1]}-${date[2]}-${date[3]}` : null,
  downloaded_at: new Date().toISOString(), source_sha256: createHash('sha256').update(bytes).digest('hex'),
  license: '공공누리 제1유형: 출처표시', crs: 'EPSG:4326', area_count: areas.length, areas,
};
const output = path.join(root, 'cloud/app/server/data/population-areas.json');
await writeFile(output, JSON.stringify(result));
console.log(JSON.stringify({ output: path.relative(root, output), area_count: areas.length, source_sha256: result.source_sha256, source_published_at: result.source_published_at }));
