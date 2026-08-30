// 首頁三層建築（例：C:\Users\USER\Desktop\vb\3層\標準層三層.gltf）→ models/tower.glb 的前處理。
//
// 做的事：
//  1. 讀 IN 的 .gltf（BIM 匯出、內嵌 base64、材質全是玻璃 Plaster）。
//  2. 依「每個 mesh 的 POSITION accessor min/max（等於它的世界座標包圍盒）」做幾何分類：
//       slab      樓板  —— 很扁很寬（dy<0.6 且水平投影 > 全棟 15%）
//       stair     樓梯  —— 用另外匯出的「只有樓梯」那份 gltf（STAIR_IN）**逐個 mesh 比對包圍盒**認出來。
//                 **跟 slab 分開**，執行期才能單獨變色
//       wall-cut  近側兩面外牆（東 +X、南 +Z）—— 剖面要「挖掉」的兩面，執行期隱藏
//       wall      其餘全部（牆、柱、窗框、家具…）
//  3. 把材質收斂成 4 個純色材質（wall/slab/stair/wall-cut，名稱保留給執行期辨識），丟掉貼圖與所有
//     KHR_materials_* 擴充。**每個都給不同顏色**，避免 gltf-transform dedup 把它們併成一個。
//  4. 輸出 restyled.gltf。
//
// 接著再壓縮成 tower.glb（會 join 成 ~3 個 primitive、Draco 壓幾何）：
//   node_modules/.bin/gltf-transform optimize restyled.gltf tower.glb --compress draco --texture-compress false --simplify false
//
// 執行期（js/viewer.js）：wall→玻璃、slab/stair→白（stair 在待機反轉那半趟會轉綠）、
// wall-cut→隱藏；名稱是唯一橋樑。
// 換模型：改 IN/OUT 路徑即可。需要 `npm i @gltf-transform/cli`（含 core/extensions/functions）。

import { readFile, writeFile } from 'node:fs/promises';

const IN  = 'C:/Users/USER/Desktop/vb/3層/標準層三層.gltf';
// 「只有樓梯」的那一份（使用者另外從 Revit 匯出）。同一份幾何匯出兩次，POSITION 的 min/max
// 會一模一樣，所以拿包圍盒當指紋就能精準對上（46/46 全中）。
// ⚠️ 不要用節點名 —— 主檔裡名字含「樓梯」的只有 7 個，而且 4 個其實不是樓梯。
const STAIR_IN = 'C:/Users/USER/Desktop/vb/3層/梯/樓梯.gltf';
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

// 樓梯 → 自己一個材質。拿 STAIR_IN 每個 mesh 的包圍盒當指紋去比對
const fp = (b) => [...b.lo, ...b.hi].map((x) => x.toFixed(3)).join(',');
const stair = new Set();
{
  const sg = JSON.parse(await readFile(STAIR_IN, 'utf8'));
  const sacc = sg.accessors;
  const want = new Set();
  for (const m of sg.meshes || []) {
    let lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
    for (const pr of m.primitives || []) {
      const a = sacc[pr.attributes.POSITION]; if (!a?.min) continue;
      for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], a.min[i]); hi[i] = Math.max(hi[i], a.max[i]); }
    }
    if (lo[0] < 1e8) want.add(fp({ lo, hi }));
  }
  g.meshes.forEach((m, i) => { const b = box(m); if (b.lo[0] < 1e8 && want.has(fp(b))) stair.add(i); });
  console.log('樓梯檔', want.size, '個 mesh，主檔對到', stair.size, '個');
}

// 0=wall 1=slab 2=wall-cut 3=stair
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
stair.forEach((mi) => { cls[mi] = 3; });                                            // 樓梯自己一組（覆蓋）
g.meshes.forEach((m, i) => { for (const pr of m.primitives) pr.material = cls[i]; });

g.materials = [
  { name: 'wall',     pbrMetallicRoughness: { baseColorFactor: [0.30, 0.42, 0.55, 1], metallicFactor: 0, roughnessFactor: 0.9 } },
  { name: 'slab',     pbrMetallicRoughness: { baseColorFactor: [0.90, 0.95, 1.0, 1], metallicFactor: 0, roughnessFactor: 0.9 } },
  { name: 'wall-cut', pbrMetallicRoughness: { baseColorFactor: [0.9, 0.1, 0.1, 1], metallicFactor: 0, roughnessFactor: 0.9 } }, // 不同色，避免被 dedup 併回 wall
  { name: 'stair',    pbrMetallicRoughness: { baseColorFactor: [0.1, 0.9, 0.4, 1], metallicFactor: 0, roughnessFactor: 0.9 } }, // 同上，別跟 slab 撞色
];
delete g.textures; delete g.images; delete g.samplers;
g.extensionsUsed = (g.extensionsUsed || []).filter((e) => !e.startsWith('KHR_materials') && e !== 'KHR_texture_transform');
if (!g.extensionsUsed.length) delete g.extensionsUsed;

await writeFile(OUT, JSON.stringify(g));
const n = (c) => cls.filter((x) => x === c).length;
console.log('slab:', n(1), 'stair:', n(3), 'wall-cut:', n(2), 'wall:', n(0), '->', OUT);
