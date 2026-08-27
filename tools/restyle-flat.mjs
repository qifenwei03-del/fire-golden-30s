// 第一頁單層「切平面」（例：C:\Users\USER\Desktop\vb\一層切平面\切平面.gltf）→ models/flat.glb 的前處理。
//
// 跟 restyle-tower 幾乎一樣，差別：
//  - 第一頁不做剖面挖牆（保留全牆，實心深色）。
//  - 樓板另外分成一個材質 'floor'，執行期「抽掉」（js/viewer.js 把 name==='floor' 的 mesh 隱藏）。
//    樓梯仍是 'slab'（白，保留）。
//
// 分類：
//    floor  大樓板 —— 很扁很寬（dy<0.6 且水平投影 > 全棟 15%）→ 執行期隱藏
//    slab   樓梯（節點名含「樓梯」的子樹）→ 白，保留
//    wall   其餘 —— 實心深色牆
//
// 壓縮：
//   node_modules/.bin/gltf-transform optimize restyled1.gltf flat.glb --compress draco --texture-compress false --simplify false
//
// 換模型：改 IN/OUT。

import { readFile, writeFile } from 'node:fs/promises';

const IN  = 'C:/Users/USER/Desktop/vb/一層切平面/切平面.gltf';
const OUT = 'restyled1.gltf';

const g = JSON.parse(await readFile(IN, 'utf8'));
const acc = g.accessors;
const box = (m) => {
  let lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
  for (const pr of m.primitives || []) {
    const a = acc[pr.attributes.POSITION]; if (!a?.min) continue;
    for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], a.min[i]); hi[i] = Math.max(hi[i], a.max[i]); }
  }
  return { lo, hi };
};

let LO = [1e9, 1e9, 1e9], HI = [-1e9, -1e9, -1e9];
g.meshes.forEach((m) => { const b = box(m); if (b.lo[0] > 1e8) return; for (let i = 0; i < 3; i++) { LO[i] = Math.min(LO[i], b.lo[i]); HI[i] = Math.max(HI[i], b.hi[i]); } });
const fpTotal = (HI[0] - LO[0]) * (HI[2] - LO[2]);

const stair = new Set();
const collect = (ni) => { const n = g.nodes[ni]; if (!n) return; if (n.mesh != null) stair.add(n.mesh); (n.children || []).forEach(collect); };
g.nodes.forEach((n, i) => { if (n.name && n.name.includes('樓梯')) collect(i); });

// 0=wall 1=slab(樓梯,白) 2=floor(大樓板,要抽掉)
const cls = new Array(g.meshes.length).fill(0);
g.meshes.forEach((m, i) => {
  const b = box(m); if (b.lo[0] > 1e8) return;
  const { lo, hi } = b; const dy = hi[1] - lo[1];
  if (dy < 0.6 && (hi[0] - lo[0]) * (hi[2] - lo[2]) > fpTotal * 0.15) cls[i] = 2;   // 大樓板
});
stair.forEach((mi) => { cls[mi] = 1; });                                            // 樓梯白
g.meshes.forEach((m, i) => { for (const pr of m.primitives) pr.material = cls[i]; });

g.materials = [
  { name: 'wall',  pbrMetallicRoughness: { baseColorFactor: [0.30, 0.42, 0.55, 1], metallicFactor: 0, roughnessFactor: 0.9 } },
  { name: 'slab',  pbrMetallicRoughness: { baseColorFactor: [0.90, 0.95, 1.0, 1], metallicFactor: 0, roughnessFactor: 0.9 } },
  { name: 'floor', pbrMetallicRoughness: { baseColorFactor: [0.9, 0.1, 0.1, 1], metallicFactor: 0, roughnessFactor: 0.9 } }, // 不同色，避免被 dedup 併走
];
delete g.textures; delete g.images; delete g.samplers;
g.extensionsUsed = (g.extensionsUsed || []).filter((e) => !e.startsWith('KHR_materials') && e !== 'KHR_texture_transform');
if (!g.extensionsUsed.length) delete g.extensionsUsed;

await writeFile(OUT, JSON.stringify(g));
console.log('floor(抽掉):', cls.filter((c) => c === 2).length, 'slab樓梯:', cls.filter((c) => c === 1).length, 'wall:', cls.filter((c) => c === 0).length, '->', OUT);
