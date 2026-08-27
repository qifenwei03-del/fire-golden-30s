import { readFile, writeFile } from 'node:fs/promises';
const IN='C:/Users/USER/Desktop/vb/一層/逃生動線/逃生動線.gltf';
const OUT='C:/Users/USER/Desktop/coding/網頁/fire-golden-30s/models/routes.json';
const g=JSON.parse(await readFile(IN,'utf8'));
const acc=g.accessors, bvs=g.bufferViews, bufs=g.buffers;
const bufData=bufs.map(b=>{ if(!b.uri?.startsWith('data:')) throw new Error('external buffer not supported'); return Buffer.from(b.uri.split(',')[1],'base64'); });
const readVec3=(ai)=>{ const a=acc[ai]; const bv=bvs[a.bufferView]; const buf=bufData[bv.buffer];
  const base=buf.byteOffset+(bv.byteOffset||0)+(a.byteOffset||0);
  const stride=bv.byteStride||12; const dv=new DataView(buf.buffer);
  const pts=[]; for(let i=0;i<a.count;i++){const o=base+i*stride; pts.push([+dv.getFloat32(o,true).toFixed(3),+dv.getFloat32(o+4,true).toFixed(3),+dv.getFloat32(o+8,true).toFixed(3)]);} return pts; };
// 檢查有沒有節點變換（若有需另外套用）
let hasXform=false;
const routes=[];
g.nodes.forEach(n=>{
  if(!(n.name&&n.name.startsWith('動線'))) return;
  if(n.matrix||n.translation||n.rotation||n.scale) hasXform=true;
  const child=g.nodes[n.children[0]];
  if(child&&(child.matrix||child.translation||child.rotation||child.scale)) hasXform=true;
  const m=g.meshes[child.mesh];
  routes.push({name:n.name, points:readVec3(m.primitives[0].attributes.POSITION)});
});
routes.sort((a,b)=>a.name.localeCompare(b.name));
console.log('hasTransform:',hasXform);
console.log(routes.map(r=>r.name+':'+r.points.length+'pts start='+JSON.stringify(r.points[0])+' end='+JSON.stringify(r.points.at(-1))).join('\n'));
await writeFile(OUT, JSON.stringify({routes}, null, 0));
console.log('-> wrote', OUT);
