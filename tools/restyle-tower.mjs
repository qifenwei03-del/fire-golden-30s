// 首頁三層建築（例：C:\Users\USER\Desktop\vb\3層\標準層三層.gltf）→ models/tower.glb 的前處理。
//
// 做的事：
//  1. 讀 IN 的 .gltf（BIM 匯出、內嵌 base64、材質全是玻璃 Plaster）。
//  2. 依「每個 mesh 的 POSITION accessor min/max（等於它的世界座標包圍盒）」做幾何分類：
//       slab      樓板  —— 很扁很寬（dy<0.6 且水平投影 > 全棟 15%）
//       wall-cut  近側兩面外牆（東 +X、南 +Z）—— 剖面要「挖掉」的兩面，執行期隱藏
//       wall      其餘全部（牆、柱、窗框、家具…）
//     另外把節點名含「樓梯」的（連子樹）強制歸到 slab（塗白）。
//  3. 把材質收斂成 3 個純色材質（wall/slab/wall-cut，名稱保留給執行期辨識），丟掉貼圖與所有
//     KHR_materials_* 擴充。wall-cut 給不同顏色，避免 gltf-transform dedup 把它併回 wall。
//  4. 輸出 restyled.gltf。
//
// 接著再壓縮成 tower.glb（會 join 成 ~3 個 primitive、Draco 壓幾何）：
//   node_modules/.bin/gltf-transform optimize restyled.gltf tower.glb --compress draco --texture-compress false --simplify false
//
// 執行期（js/viewer.js）：wall→玻璃、slab→白、wall-cut→隱藏；名稱是唯一橋樑。
// 換模型：改 IN/OUT 路徑即可。需要 `npm i @gltf-transform/cli`（含 core/extensions/functions）。

import { readFile, writeFile } from 'node:fs/promises';

const IN  = 'C:/Users/USER/Desktop/vb/3層/標準層三層.gltf';
const OUT = 'restyled.gltf';

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

// 樓梯（連子樹）→ 塗白
const stair = new Set();
const collect = (ni) => { const n = g.nodes[ni]; if (!n) return; if (n.mesh != null) stair.add(n.mesh); (n.children || []).forEach(collect); };
g.nodes.forEach((n, i) => { if (n.name && n.name.includes('樓梯')) collect(i); });

// 0=wall 1=slab 2=wall-cut
const cls = new Array(g.meshes.length).fill(0);
g.meshes.forEach((m, i) => {
  const b = box(m); if (b.lo[0] > 1e8) return;
  const { lo, hi } = b; const dx = hi[0] - lo[0], dy = hi[1] - lo[1], dz = hi[2] - lo[2];
  if (dy < 0.6 && dx * dz > fpTotal * 0.15) { cls[i] = 1; return; }               // 樓板
  if (dy > 2) {
    const east  = dx < 0.9 && dz > 2 && hi[0] > HI[0] - 1.2;                        // +X 東牆
    const south = dz < 0.9 && dx > 2 && hi[2] > HI[2] - 1.2;                        // +Z 南牆
    if (east || south) { cls[i] = 2; return; }
  }
});
stair.forEach((mi) => { cls[mi] = 1; });                                            // 樓梯白（覆蓋）
g.meshes.forEach((m, i) => { for (const pr of m.primitives) pr.material = cls[i]; });

g.materials = [
  { name: 'wall',     pbrMetallicRoughness: { baseColorFactor: [0.30, 0.42, 0.55, 1], metallicFactor: 0, roughnessFactor: 0.9 } },
  { name: 'slab',     pbrMetallicRoughness: { baseColorFactor: [0.90, 0.95, 1.0, 1], metallicFactor: 0, roughnessFactor: 0.9 } },
  { name: 'wall-cut', pbrMetallicRoughness: { baseColorFactor: [0.9, 0.1, 0.1, 1], metallicFactor: 0, roughnessFactor: 0.9 } }, // 不同色，避免被 dedup 併回 wall
];
delete g.textures; delete g.images; delete g.samplers;
g.extensionsUsed = (g.extensionsUsed || []).filter((e) => !e.startsWith('KHR_materials') && e !== 'KHR_texture_transform');
if (!g.extensionsUsed.length) delete g.extensionsUsed;

await writeFile(OUT, JSON.stringify(g));
console.log('slab+stairs:', cls.filter((c) => c === 1).length, 'wall-cut:', cls.filter((c) => c === 2).length, 'wall:', cls.filter((c) => c === 0).length, '->', OUT);
