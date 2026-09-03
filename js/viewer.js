import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
// 粗線：WebGL 的 THREE.Line 畫不出寬度（linewidth 幾乎都被鎖在 1px），首頁的動線改用這一組
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

// Draco 解碼器放在專案內（models/draco/），不依賴外部 CDN —— 離線／網路被擋也能載入模型。
// 路徑相對於網頁根目錄（頁面在 / 下），DRACOLoader 會去 /models/draco/ 抓。
const DRACO_PATH = './models/draco/';

/** 每個佔位場景的鏡頭預設值 */
const SCENE_VIEWS = {
  // 第一頁不轉、不擺動，而且 lock:true ＝**完全不能用滑鼠動鏡頭**（見 setCameraLock）
  flat:  { pos: [14, 15, 18], target: [0, 1, 0], min: 6, max: 90, fog: [26, 62], autoRotate: false, swing: false, lock: true },
  tower: { pos: [18, 14, 22], target: [0, 3.2, 0], min: 8, max: 110, fog: [30, 76] },
};

/** 通關「整棟變白」的陰影設定：
    span     = 漸層吃掉全高的幾成（0.55 = 下面 55% 由白壓到 --m-shade，上面維持白）
    emissive = 白模式的自發光強度。**這支越大底部越亮、層次越平**，要更深就往下調（0 = 完全靠打光） */
const SHADE = { span: 0.55, emissive: 0.07 };

/** 待機起火點的節奏與挑選規則。

    ⚠️ **整組節奏是掛在「擺盪的時間軸」上的，不是固定秒數。**
    擺盪是 k = (1-cos(w·Δt))/2，把一趟切成四段，w·Δt 每走 π/2 就經過時間軸上的一個點：

      點 1（相位 0）     一端      正轉 → 起火點換新的（挑**畫面左邊**那一帶）、樓梯白、紅字
      點 2（相位 π/2）   中間      正轉 → 起火點換新的（挑**畫面中間**）、樓梯白、黃字
      點 3（相位 π）     另一端    正轉到底 → 起火點換新的（挑**畫面右邊**那一帶）、樓梯白、綠字
      點 4（相位 3π/2）  中間      反轉 → **維持點 3 那顆起火點**、樓梯**轉綠**、綠字撐著，
                                   而且那顆起火點會在點 4 → 點 1 之間**慢慢淡到不見**
      （回到點 1 = 樓梯變回白、起火點重新出現，一個循環）

    每經過一個點就發一次 onSwingBeat({ point, fwd, word, first })：
      起火點 / 樓梯顏色 / 淡出 —— viewer 自己處理
      標語換字、按鈕抽動 —— 外面訂閱，見 js/main.js（按鈕四個點都抽，標語只有 1/2/3 換）

    一趟 = 2π / (0.9 × |autoRotateSpeed|) 秒，改擺盪速度整組節奏就自動跟著變。
    沒在擺盪（swing 關掉或速度 0）才退回 every 的固定秒數（那時只有起火點會換）。

    **一顆的壽命就是一拍**（下一拍換位置時它才熄掉），所以中間不會有空白。
    下一顆是在舊的熄掉前 overlap 秒就先冒出來的，那 overlap 秒是**兩處同時在燒**。
    overlap 設 0 就是無縫接替（永遠只有一顆）；沒有淡入淡出，一律直接開／關。

    因為要並存，起火點做成**兩格輪流用**（slots），不是一顆搬來搬去。

    位置從**離鏡頭最近的 pool 條**動線起點裡隨機挑，並避開正在燒的那一條
    （候選只剩一條時例外），所以每一輪都真的會換地方；
    不想每次都換就把 _pickFireStart() 裡的 pool.filter 拿掉。 */
const IDLE_FIRE = { overlap: 0.25, pool: 3, every: 4.75 };   // 節拍改由 SWING_BEATS 決定，不再切等分

/** 首頁（tower）逃生動線那條線的長相。**只有首頁用這一組，第一頁（flat）維持原本的細綠虛線。**
    做法是一條「核心」+ 一條更寬的「光暈」（相加混色）疊出發光感，兩條**共用同一份 geometry**，
    所以畫到哪裡只要更新一次。
    width / halo 的單位是**螢幕像素**（拉遠拉近都一樣粗，要靠 material.resolution，見 _syncLineRes）；
    dash / gap 是模型單位（數字越小虛線越密）。 */
/** 前言／結語頁替動線加的**覆蓋層**：陣列裡每一筆就是在原本的細線上再疊一層，
    width 是螢幕像素、**由粗到細往上疊**。
    ⚠️ add（相加混色）只給**光暈**用。芯要 add:false —— 相加混色會一路往白色堆，
       疊到夠亮的時候綠色早就被洗掉了（實測看起來就是一條白線，看不出是綠的）。
       芯改成一般混色、opacity 拉滿，顏色就是動線原本的顏色，不會偏白。
    ⚠️ 芯的 width 就是**看起來的線寬**。光暈的 opacity 壓低（0.2 上下）才是暈開的感覺，
       調太高會變成一條粗線。 */
const ROUTE_BOOST = [
  { width: 5,   opacity: 0.12, add: true  },   // 外圈光暈：暈開就好，不要有明顯的邊
  { width: 1.8, opacity: 1,    add: false },   // 實心的芯：這條決定看起來多粗、什麼顏色
];

/** 前言／結語頁動線兩端的標記：起點圓點 → 細虛線 → 箭頭 → 出口標誌。
    **第一頁不會出現**（第一頁維持原本的紅起點／綠終點）。單位是模型座標。 */
const ROUTE_MARK = {
  dot:   { core: 0.26, halo: 0.68, haloOp: 0.22 },   // 起點：實心圓 + 外圈暈
  arrow: { len: 0.62, half: 0.28 },                  // 末端箭頭：長度、單邊寬度
  sign:  { size: 2.6, gap: 1.5, lift: 1.2 },         // 出口標誌：大小、離線末端多遠、離地多高
};

/** 前言／結語頁「只壓建物、不壓動線」的畫圖順序：
    建物先畫 → 蓋一層 veil 把**已經畫好的東西**整片壓淡 → 動線最後畫上去。
    動線在 veil 之後，所以完全不受壓淡影響（見 setPlanDim）。 */
const PLAN_LAYER = { veil: 5, route: 6, boost: 7, mark: 9 };
const ROUTE_LINE = { width: 3.4, halo: 12, haloOpacity: 0.2, dash: 0.32, gap: 0.2 };

/** 待機的「擺盪時間軸」：**1 和 4 是擺幅的兩端，2 和 3 把中間平分成三段**。
    擺盪的位置是 k = (1-cos θ)/2（θ = w·Δt，一個循環 0~2π），所以四個點的 k 是 0 / ⅓ / ⅔ / 1，
    換算成 θ 就是 0 / acos(⅓) / acos(-⅓) / π —— **時間上不是等距的**（餘弦在兩端會變慢）。
    回程（θ π~2π）會再經過點 3、點 2，所以一個循環總共踩到 **6 個節拍**。 */
const _A13 = Math.acos(1 / 3);          // k = 1/3
const _A23 = Math.acos(-1 / 3);         // k = 2/3
// pick = 這個點要用哪幾條動線（0 起算，也就是「動線1」= 0）。多於一條就隨機挑、並避開剛剛那條。
// null = 不換起火點（點 4 之後整個回程都維持點 3 那一顆）。
const SWING_BEATS = [
  { th: 0,                    point: 1, fwd: true,  word: 1, pick: [0, 1], green: false },  // 動線 1 或 2
  { th: _A13,                 point: 2, fwd: true,  word: 2, pick: [2],    green: false },  // 動線 3
  { th: _A23,                 point: 3, fwd: true,  word: 3, pick: [3, 4], green: false },  // 動線 4 或 5
  { th: Math.PI,              point: 4, fwd: true,  word: 3, pick: null,   green: true  },  // 端點，開始回程
  { th: 2 * Math.PI - _A23,   point: 3, fwd: false, word: 3, pick: null,   green: true  },
  { th: 2 * Math.PI - _A13,   point: 2, fwd: false, word: 3, pick: null,   green: true  },
];

/** 回程那半圈「綠色樓梯」的長相。q = 回程走到幾成（θ 從 π 到 2π 換算成 0~1）。
    glow    = 綠的時候自發光開到多強。⚠️ 綠的期間 **diffuse 會被壓成純黑**，畫面上完全只剩自發光 ——
              不然打光會疊在綠色上面，看起來白白髒髒的（原本樓板的白透出來）。
              所以這個數字就是「那片綠有多亮」，1.0 差不多就是標語那個綠。
    swell   = 前幾成用來把光推上去（不要用跳的）
    blip    = **碰到點抖一下**的長度
    blinkAt = 走到幾成開始「消失前的連抖」
    blinks  = 抖幾次（改幾次就要把 duty 的長度一起改）
    duty    = 每一次抖「外溢」佔多少（故意不一樣，才不像節拍器）

    抖動不是「整座消失」，是**橫向外溢再收縮**（映像管訊號糊掉的感覺）：
    ghosts  = 左右各疊幾層殘影
    spread  = 最外那一層偏移多少（模型單位）—— 這支就是「糊得多開」，覺得誇張就往下調
    ghostOp = 殘影最濃的時候多濃
    dim     = 外溢的時候本體要淡掉多少 */
const STAIR_GREEN = {
  glow: 1.0, swell: 0.08, blip: 0.06, blinkAt: 0.78, blinks: 2, duty: [0.55, 0.4],
  ghosts: 3, spread: 0.18, ghostOp: 0.55, dim: 0.5,
};
/** 回程會踩到的點換算成 q（點 4 自己、點 3、點 2）—— 碰到就閃一下 */
const STAIR_BLIPS = [0, (2 * Math.PI - _A23 - Math.PI) / Math.PI, (2 * Math.PI - _A13 - Math.PI) / Math.PI];

/** 線頭那個「正在逃生的人」：白色的逃生標誌小人（sprite，永遠面向鏡頭）。
    size   = 模型單位的高度（一層樓約 3.5）
    glow   = 光暈是本體的幾倍大（也決定光暈貼圖裡本體要縮多小，才有空間讓模糊暈開）
    glowOp = 光暈濃度（相加混色，越大越亮）
    light  = 他隨身帶的那顆白光的強度（0 = 不打光） */
const RUNNER = { size: 1.0, glow: 2.2, glowOp: 0.55, light: 9 };

/** 第一頁的動線幾秒換一條。倒數一個時段 10 秒，所以最多剛好放得下 5 條 ——
    但**寧可少跑一條也不要有一條只閃過去**（見 setRoutePhase 的 _phaseEnd）。 */
const ROUTE_SLOT = 2.0;

/** 每幀都會用到的暫存物件，放外面重複使用，不要在動畫迴圈裡一直 new */
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3(), _v5 = new THREE.Vector3();
const _v6 = new THREE.Vector3(), _v7 = new THREE.Vector3(), _v8 = new THREE.Vector3();
/** 樓梯殘影專用的暫存（每幀都會動，不要跟 _v1~_v8 混用）*/
const _sgDir = new THREE.Vector3(), _sgMat = new THREE.Matrix4();
const _sa = new THREE.Spherical(), _sb = new THREE.Spherical(), _sc = new THREE.Spherical();
const _r2 = new THREE.Vector2();

/** 頭尾各 e 的區間加速／減速，中間完全等速。回傳「已經走完的比例」0~1。
    e=0 就是完全等速（起步和收尾會有點硬），0.12 大約是頭尾各一成的緩衝 */
const easeEnds = (x, e = 0.12) => {
  if (!(e > 0)) return x;
  let s;
  if (x < e) s = (x * x) / (2 * e);
  else if (x < 1 - e) s = e / 2 + (x - e);
  else { const u = x - (1 - e); s = e / 2 + (1 - 2 * e) + u - (u * u) / (2 * e); }
  return Math.min(1, Math.max(0, s / (1 - e)));
};

/** 煙霧用的**卡通雲朵**貼圖（畫一次就好）。
    幾個圓疊成雲朵剪影，邊緣是硬的（不是漸層糊掉），再用兩層透明度做出「深外圈 + 亮內裡」的賽璐珞感。
    整張是灰階，實際顏色由 sprite 的 color 上色。 */
/** 逃生標誌的小人（畫一次就好）。用粗的圓頭線條堆出來 —— 這樣縮到很小也還看得出是個在跑的人。
    整張是白色剪影，實際顏色由 sprite 的 color 決定。座標是 0~1 的比例，方便微調姿勢。 */
let _runnerTex = null;
let _runnerCanvas = null;
function runnerTexture() {
  if (_runnerTex) return _runnerTex;
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d');
  const P = (x, y) => [x * S, y * S];
  ctx.fillStyle = ctx.strokeStyle = '#fff';
  ctx.lineCap = ctx.lineJoin = 'round';
  ctx.lineWidth = 0.125 * S;

  // 頭。**跟肩膀之間要留一個看得見的空隙**，逃生標誌就是這樣畫的；
  // 貼太近會糊成一塊，遠看變成一顆有身體的球。
  ctx.beginPath();
  ctx.arc(...P(0.265, 0.115), 0.097 * S, 0, Math.PI * 2);
  ctx.fill();

  const line = (...pts) => {
    ctx.beginPath();
    ctx.moveTo(...P(...pts[0]));
    for (let i = 1; i < pts.length; i++) ctx.lineTo(...P(...pts[i]));
    ctx.stroke();
  };
  line([0.375, 0.315], [0.505, 0.555]);                   // 軀幹（往右前傾）
  line([0.405, 0.400], [0.625, 0.355], [0.740, 0.505]);   // 前臂：往前伸再往下折
  line([0.375, 0.385], [0.185, 0.485]);                   // 後臂：往後下方甩
  line([0.505, 0.555], [0.600, 0.715], [0.555, 0.875]);   // 前腳：抬膝再落下
  line([0.555, 0.875], [0.715, 0.885]);                   // 前腳掌
  line([0.505, 0.555], [0.315, 0.655], [0.155, 0.805]);   // 後腳：往後蹬
  line([0.155, 0.805], [0.105, 0.890]);                   // 後腳掌

  _runnerCanvas = c;                 // 光暈那張直接拿這張去模糊，形狀才會跟著人走
  _runnerTex = new THREE.CanvasTexture(c);
  return _runnerTex;
}

/** 出口標誌：圓角方框 + 裡面的小人（直接借上面那張，不用再畫一次）。
    整張是白色剪影，實際顏色由 sprite 的 color 決定。
    ⚠️ 外框的線寬要跟小人的筆畫差不多，遠看才像同一組符號；差太多會像「一個框裡塞了東西」。 */
let _exitTex = null;
function exitSignTexture() {
  if (_exitTex) return _exitTex;
  runnerTexture();                                  // 先確保小人那張畫好了
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d');
  ctx.strokeStyle = '#fff';
  ctx.lineJoin = ctx.lineCap = 'round';
  const w = 0.052 * S, pad = 0.13 * S;
  ctx.lineWidth = w;
  ctx.beginPath();
  ctx.roundRect(pad, pad, S - 2 * pad, S - 2 * pad, 0.055 * S);
  ctx.stroke();
  const k = 0.52;                                   // 小人在框裡佔多大
  ctx.drawImage(_runnerCanvas, S * (1 - k) / 2, S * (1 - k) / 2, S * k, S * k);
  _exitTex = new THREE.CanvasTexture(c);
  return _exitTex;
}

/** 小人的光暈：把小人本體縮小置中、模糊、疊兩次。
    **形狀是跟著人的**（不是一顆圓球），所以看起來像他自己在發光。
    縮小是為了讓模糊有地方暈開 —— 畫滿整張的話光暈會被畫布邊緣切掉。 */
let _runnerGlowTex = null;
function runnerGlowTexture() {
  if (_runnerGlowTex) return _runnerGlowTex;
  runnerTexture();                                  // 先確保本體那張畫好了
  const S = _runnerCanvas.width;
  const k = 1 / RUNNER.glow;                        // 本體在光暈貼圖裡佔的比例
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d');
  ctx.filter = `blur(${0.045 * S}px)`;
  for (let i = 0; i < 2; i++) {                     // 疊兩次，光暈才夠實
    ctx.drawImage(_runnerCanvas, S * (1 - k) / 2, S * (1 - k) / 2, S * k, S * k);
  }
  _runnerGlowTex = new THREE.CanvasTexture(c);
  return _runnerGlowTex;
}

let _smokeTex = null;
function smokeTexture() {
  if (_smokeTex) return _smokeTex;
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d');
  // 雲朵剪影：六個圓的聯集（每個圓前面要 moveTo，不然 arc 之間會連出直線）
  const puffs = [[0.50, 0.56, 0.30], [0.28, 0.60, 0.21], [0.72, 0.60, 0.21],
                 [0.39, 0.38, 0.23], [0.63, 0.40, 0.19], [0.50, 0.74, 0.22]];
  const cloud = new Path2D();
  for (const [x, y, r] of puffs) {
    cloud.moveTo((x + r) * S, y * S);
    cloud.arc(x * S, y * S, r * S, 0, Math.PI * 2);
  }
  const fill = (scale, alpha) => {
    ctx.save();
    ctx.translate(S / 2, S / 2);
    ctx.scale(scale, scale);
    ctx.translate(-S / 2, -S / 2);
    ctx.fillStyle = `rgba(255,255,255,${alpha})`;
    ctx.fill(cloud);
    ctx.restore();
  };
  fill(1.00, 0.5);      // 外圈：上色後會變成比較深的紅（等於描邊）
  fill(0.86, 1.0);      // 內裡：飽和的紅
  _smokeTex = new THREE.CanvasTexture(c);
  return _smokeTex;
}

/** 讀 css/style.css 的主題變數，讓 3D 場景跟版面同一組配色 */
const css = (name, fallback) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

/**
 * 可掛載到任意 DOM 容器的 3D 檢視器。
 * mount(el) 會把 canvas 塞進 el 並跟著它的尺寸縮放，
 * 之後其他頁面要用同一顆 renderer 只要再 mount 到別的容器即可。
 */
export class Viewer {
  constructor() {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(new THREE.Color(css('--m-fog', '#031020')), 26, 62);

    this.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 400);
    this.camera.position.set(14, 15, 18);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.enablePan = false;
    this.controls.minDistance = 6;
    this.controls.maxDistance = 90;
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.45;

    this.modelRoot = new THREE.Group();
    this.scene.add(this.modelRoot);

    this.fires = [];
    this.routes = [];
    this._lineMats = [];         // 粗線材質（LineMaterial 要知道畫布尺寸才算得出像素寬度）
    this.savedViews = {};        // { flat: {pos,target,autoRotate}, tower: {...} }
    this._shots = {};            // 分鏡：{ tower: { route1..route5, clear: {pos,target} } }
    this._fly = null;            // 正在飛往某個分鏡
    this._hold = false;          // 停在分鏡上（這期間不擺動、不自轉）
    this._override = false;      // 待機以外的狀態接管中（分鏡、通關的自轉…）
    this._allWhite = false;      // 通關畫面：整棟變白
    this.customModels = {};      // { tower: Object3D } 外部載入的真實模型，蓋掉同名佔位場景
    this.customViews = {};       // { tower: {pos,target,...} } 依模型尺寸自動框好的視角
    // 來回擺動。兩種模式：
    //   沒設 a/b：在 center ± amp 之間擺（只轉水平角度）
    //   設了 a/b：鎖定在這兩個視角之間來回（角度、俯仰、遠近、軸心全部一起內插）
    this.swing = { on: false, center: 0, amp: THREE.MathUtils.degToRad(40), t0: 0, a: null, b: null, dir: 'auto' };
    this._addLights();
    this._addPlaceholder();

    this.clock = new THREE.Clock();
    this._raf = 0;
    this._host = null;
    this._ro = new ResizeObserver(() => this.resize());
  }

  /* ---------- 燈光 ---------- */
  _addLights() {
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x000000, 1.1);
    this.scene.add(this.hemi);

    this.key = new THREE.DirectionalLight(0xffffff, 1.5);
    this.key.position.set(12, 20, 10);
    this.scene.add(this.key);

    this.rim = new THREE.DirectionalLight(0xffffff, 0.9);
    this.rim.position.set(-14, 8, -12);
    this.scene.add(this.rim);

    this._tintLights();
  }

  _tintLights() {
    this.hemi.color.set(css('--m-edge', '#74d4ff'));
    this.hemi.groundColor.set(css('--m-fog', '#031020'));
    this.key.color.set('#ffffff');
    this.rim.color.set(css('--m-grid', '#2f9dff'));
  }

  /* ---------- 預設佔位模型 ----------
     flat  = 單層平面圖（第一頁用）
     tower = 三層疊起來的大樓（首頁用）
     兩組都掛在 modelRoot 底下，用 visible 切換，共用同一顆 renderer。
     ------------------------------------ */
  _addPlaceholder() {
    // 只清掉「上一份佔位場景」自己的動畫項目（換主題會重建）。
    // 真實模型的逃生動線和圓點也在同兩個清單裡，清光的話換一次主題就不會動了。
    this.fires = (this.fires ?? []).filter((f) => !f.ph);
    this.routes = (this.routes ?? []).filter((r) => !r.userData.ph);
    this._ph = true;                    // 接下來建立的都算佔位場景的
    this.scenes = {
      flat: this._buildFlat(),
      tower: this._buildTower(),
    };
    this._ph = false;
    this.placeholder = new THREE.Group();
    for (const g of Object.values(this.scenes)) this.placeholder.add(g);
    this.modelRoot.add(this.placeholder);
    // 只切顯示，**不要重套視角** —— 換主題會重建這裡，順便重套視角的話
    // 跑動線跑到一半鏡頭會被拉回存檔的位置，分鏡也會被覆蓋掉
    this.sceneName ??= 'flat';
    this._syncSceneVisibility();
  }

  /** 只處理「這個場景的東西看得見、別的藏起來」，不動鏡頭 */
  _syncSceneVisibility() {
    const name = this.sceneName;
    // 佔位場景：只有在沒有同名真實模型時才顯示
    if (this.scenes) {
      for (const [k, g] of Object.entries(this.scenes)) g.visible = k === name && !this.customModels[k];
    }
    // 外部真實模型：只顯示目前這一頁的
    for (const [k, m] of Object.entries(this.customModels)) m.visible = k === name;
  }

  /** 切換場景：有載入真實模型就用它（蓋掉同名佔位），視角優先用存過的，其次自動框好的，再其次預設 */
  setScene(name) {
    if (!SCENE_VIEWS[name] && !this.customModels[name]) return;
    this.sceneName = name;
    this._syncSceneVisibility();
    this._fly = null;                 // 換場景就取消接管與飛行，不然會飛到別頁去
    this._hold = false;
    this._override = false;
    // 有真實模型就以它自動框好的視角為底，否則用佔位場景預設；存過的視角再蓋上去
    const base = (this.customModels[name] && this.customViews[name]) || SCENE_VIEWS[name] || {};
    this._applyView({ ...base, ...(this.savedViews[name] ?? {}) });
    this.setCameraLock(!!SCENE_VIEWS[name]?.lock);    // 第一頁鎖住鏡頭，首頁照常可以轉
  }

  _applyView(v) {
    if (!v.pos) return;
    this.camera.position.set(...v.pos);
    this.controls.target.set(...v.target);
    this.controls.autoRotate = v.autoRotate ?? true;
    if (v.min != null) this.controls.minDistance = v.min;
    if (v.max != null) this.controls.maxDistance = v.max;
    if (v.near != null) this.camera.near = v.near;
    if (v.far != null) this.camera.far = v.far;
    if (v.near != null || v.far != null) this.camera.updateProjectionMatrix();
    if (v.speed != null) this.controls.autoRotateSpeed = v.speed;
    if (v.swingAmp != null) this.swing.amp = THREE.MathUtils.degToRad(v.swingAmp);
    this.setSwingDir(v.swingDir);
    // 鎖定的兩端跟著視角一起換（沒有就清掉，免得留著上一個場景的）
    this.setSwingRange(v.swingA, v.swingB);
    if (v.swing != null) {
      this.swing.on = v.swing;
      if (v.swing) {
        this.controls.autoRotate = false;
        this.swing.center = new THREE.Spherical()
          .setFromVector3(this.camera.position.clone().sub(this.controls.target)).theta;
        this.swing.t0 = this.clock.getElapsedTime();
      }
    }
    if (v.fog) { this.scene.fog.near = v.fog[0]; this.scene.fog.far = v.fog[1]; }
    this.controls.update();
  }

  /* ---------- 視角（角度 / 遠近 / 自動旋轉），可存檔 ---------- */
  getView() {
    const r = (n) => +n.toFixed(3);
    return {
      pos: this.camera.position.toArray().map(r),
      target: this.controls.target.toArray().map(r),   // target = 自動旋轉的軸心
      autoRotate: this.controls.autoRotate,
      speed: +this.controls.autoRotateSpeed.toFixed(3),
      swing: this.swing.on,
      swingAmp: +THREE.MathUtils.radToDeg(this.swing.amp).toFixed(1),
      swingDir: this.swing.dir ?? 'auto',
      swingA: this.swing.a && { pos: this.swing.a.pos.map(r), target: this.swing.a.target.map(r) },
      swingB: this.swing.b && { pos: this.swing.b.pos.map(r), target: this.swing.b.target.map(r) },
      shots: { ...(this._shots[this.sceneName] ?? {}) },
    };
  }

  /* ---------- 擺動鎖定在兩個視角之間 ---------- */

  /** 設定擺動的兩端。a / b 都是 `{pos:[x,y,z], target:[x,y,z]}`（直接餵 getView() 的結果也可以）。
     兩端都有值時，擺動就在這兩個視角之間來回，「擺幅」失效；任一個給 null 就回到 center ± 擺幅。 */
  setSwingRange(a, b) {
    const pick = (v) =>
      (Array.isArray(v?.pos) && Array.isArray(v?.target))
        ? { pos: v.pos.slice(0, 3).map(Number), target: v.target.slice(0, 3).map(Number) }
        : null;
    this.swing.a = pick(a);
    this.swing.b = pick(b);
    if (this.swing.on) this.swing.t0 = this.clock.getElapsedTime();   // 從 A 那一端重新起算
    return this.hasSwingRange();
  }

  hasSwingRange() { return !!(this.swing.a && this.swing.b); }
  getSwingRange() { return { a: this.swing.a, b: this.swing.b }; }
  clearSwingRange() { this.swing.a = null; this.swing.b = null; }

  /** 把目前鏡頭記成擺動的某一端（'a' | 'b'） */
  setSwingEnd(which) {
    const v = this.getView();
    this.swing[which === 'b' ? 'b' : 'a'] = { pos: v.pos, target: v.target };
    if (this.swing.on) this.swing.t0 = this.clock.getElapsedTime();
    return this.hasSwingRange();
  }

  /** 鏡頭直接跳到擺動的某一端（編輯時確認位置用）。會順便關掉擺動，不然馬上又被拉走 */
  gotoSwingEnd(which) {
    const v = this.swing[which === 'b' ? 'b' : 'a'];
    if (!v) return false;
    this.swing.on = false;
    this.controls.autoRotate = false;
    this.controls.target.set(...v.target);
    this.camera.position.set(...v.pos);
    this.controls.update();
    return true;
  }

  /* ---------- 分鏡：每條逃生動線、通關畫面各存一個鏡頭 ----------
     名稱自己定，首頁用的是 'route1'~'route5' 和 'clear'。跟視角一樣是每個場景各一份，
     存在 layout*.json 的 `view.shots` 裡。沒設過的分鏡＝不動鏡頭（維持原本的擺動）。 */

  /** 把目前鏡頭（或指定的 view）記成某個分鏡，**連運鏡狀態一起記**
     （自動旋轉／擺動／速度／擺幅／A B）。通關要不要自己轉就是靠這個。 */
  setShot(name, view = null) {
    const v = view ?? this.getView();
    if (!name || !Array.isArray(v?.pos) || !Array.isArray(v?.target)) return false;
    const s = (this._shots[this.sceneName] ??= {});
    s[name] = {
      keys: [{ t: 0, pos: v.pos.slice(0, 3).map(Number), target: v.target.slice(0, 3).map(Number) }],
      motion: {
        autoRotate: !!v.autoRotate, speed: v.speed,
      swing: !!v.swing, swingAmp: v.swingAmp, swingDir: v.swingDir ?? 'auto',
        swingA: v.swingA ?? null, swingB: v.swingB ?? null,
      },
    };
    return true;
  }

  /** 鏡頭留在原地，直接切成某個運鏡狀態（並解除分鏡的「定住」）。
     例如通關沒設鏡頭，但還是要讓它自己轉的時候 */
  freeMotion(m) {
    this._override = true;
    this._hold = false;
    this.applyMotion(m);
  }

  /** 只更新某個狀態的「運鏡」，不動它的關鍵影格。
     動線也能有自己的運鏡（例如某一條想定住不動、或想自己轉），七個狀態的資料形狀一致 */
  setShotMotion(name, view = null) {
    const v = view ?? this.getView();
    if (!name) return false;
    const s = (this._shots[this.sceneName] ??= {});
    s[name] = {
      ...(s[name] ?? {}),
      motion: {
        autoRotate: !!v.autoRotate, speed: v.speed,
        swing: !!v.swing, swingAmp: v.swingAmp, swingDir: v.swingDir ?? 'auto',
        swingA: v.swingA ?? null, swingB: v.swingB ?? null,
      },
    };
    return true;
  }

  getShotMotion(name) { return this.getShot(name)?.motion ?? null; }

  /**
   * 進入某個狀態，依「它存了什麼」決定鏡頭怎麼走。七個狀態（待機、動線1~5、通關）共用這一支：
   *   兩個以上關鍵影格 → 沿時間軸走，回 `'keys'`（實際驅動交給呼叫端，每幀跟著進度跑）
   *   剛好一個關鍵影格 → 飛過去停住，落地再套它的運鏡，回 `'shot'`
   *   只有運鏡沒有鏡頭 → 鏡頭留在原地，直接套運鏡，回 `'motion'`
   *   什麼都沒設       → 回到待機的視角和運鏡，回 `'idle'`
   */
  enterState(name, blend = 0.8, { defaultMotion = null } = {}) {
    const keys = this.shotKeys(name);
    const motion = this.getShotMotion(name) ?? defaultMotion;
    if (keys && keys.length >= 2) {
      this._override = true;
      this._hold = true;
      this._fly = null;
      return 'keys';
    }
    if (keys && keys.length === 1) { this.playShot(name, blend, { defaultMotion }); return 'shot'; }
    if (motion) { this.freeMotion(motion); return 'motion'; }
    this.releaseShot(blend);
    return 'idle';
  }

  /** 只套運鏡狀態，不動鏡頭位置（切換「藍 / 紅 / 綠」三個狀態時用） */
  applyMotion(m = {}) {
    if (m.speed != null) this.controls.autoRotateSpeed = m.speed;
    this.setSwingDir(m.swingDir);
    if (m.swingAmp != null) this.swing.amp = THREE.MathUtils.degToRad(m.swingAmp);
    this.setSwingRange(m.swingA, m.swingB);
    this.controls.autoRotate = !!m.autoRotate;
    this.swing.on = !!m.swing;
    if (this.swing.on) {
      this.controls.autoRotate = false;                 // 兩種轉法互斥
      this.swing.center = new THREE.Spherical()
        .setFromVector3(this.camera.position.clone().sub(this.controls.target)).theta;
      this.swing.t0 = this.clock.getElapsedTime();
    }
  }

  getShot(name) { return this._shots[this.sceneName]?.[name] ?? null; }

  /* ---------- 分鏡的關鍵影格（沿著動線的時間軸放鏡頭） ----------
     一個分鏡可以是「單一鏡頭」`{pos,target}`（舊格式），也可以是一串
     `{keys:[{t,pos,target}, …]}`，t 是 0~1 的進度（不是秒，這樣改 ROUTE_RUN 也不用重設）。
     播動線時鏡頭就照著這串走，等於「運鏡跟著行徑路線」。 */

  /** 統一成排好序的 [{t,pos,target}]；沒設過回 null。舊的單一鏡頭＝t=0 的一個點 */
  shotKeys(name) {
    const s = this.getShot(name);
    if (!s) return null;
    const keys = Array.isArray(s.keys) ? s.keys : (Array.isArray(s.pos) ? [{ t: 0, pos: s.pos, target: s.target }] : []);
    return keys.length ? keys.slice().sort((a, b) => a.t - b.t) : null;
  }

  /** 在 t（0~1）放一個鏡頭。±0.02 內已經有點就覆蓋掉它 */
  setShotKey(name, t, view = null) {
    const v = view ?? this.getView();
    if (!name || !Array.isArray(v?.pos)) return false;
    const tt = Math.max(0, Math.min(1, t));
    const keys = this.shotKeys(name) ?? [];
    const key = { t: +tt.toFixed(4), pos: v.pos.slice(0, 3).map(Number), target: v.target.slice(0, 3).map(Number) };
    const at = keys.findIndex((k) => Math.abs(k.t - tt) < 0.02);
    if (at >= 0) keys[at] = key; else keys.push(key);
    keys.sort((a, b) => a.t - b.t);
    this._writeShot(name, keys);
    return true;
  }

  /** 移動第 i 個點的時間 */
  moveShotKey(name, i, t) {
    const keys = this.shotKeys(name);
    if (!keys?.[i]) return false;
    keys[i].t = +Math.max(0, Math.min(1, t)).toFixed(4);
    keys.sort((a, b) => a.t - b.t);
    this._writeShot(name, keys);
    return true;
  }

  /** 刪掉第 i 個點；全刪完就把整個分鏡清掉 */
  removeShotKey(name, i) {
    const keys = this.shotKeys(name);
    if (!keys?.[i]) return false;
    keys.splice(i, 1);
    if (keys.length) this._writeShot(name, keys);
    else this.clearShot(name);
    return true;
  }

  /** 只換掉關鍵影格，保留這個分鏡已經存過的運鏡狀態（motion） */
  _writeShot(name, keys) {
    const s = (this._shots[this.sceneName] ??= {});
    s[name] = { ...(s[name] ?? {}), keys };
  }

  /** t 落在哪兩個影格之間 → [前, 後, 0~1]。每一段各自 smoothstep，經過關鍵點會稍微放慢，不會有折角 */
  _keyPair(keys, t) {
    const last = keys[keys.length - 1];
    if (keys.length === 1 || t <= keys[0].t) return [keys[0], keys[0], 0];
    if (t >= last.t) return [last, last, 0];
    let i = 1;
    while (i < keys.length - 1 && keys[i].t < t) i++;
    const a = keys[i - 1], b = keys[i];
    const k = (t - a.t) / ((b.t - a.t) || 1);
    return [a, b, k * k * (3 - 2 * k)];
  }

  /** 把鏡頭放到某個分鏡的 t 進度上（編輯預覽用，直接套、不飛） */
  gotoShotAt(name, t) {
    const keys = this.shotKeys(name);
    if (!keys) return false;
    this._fly = null;
    this._lerpView(...this._keyPair(keys, t));
    return true;
  }

  /** 編輯預覽：把某條動線畫到 t（0~1）、線頭放好；有給 shotName 就連鏡頭一起帶到那個時間點 */
  previewRouteAt(setName, index, t, shotName = null) {
    const set = this._routeSets?.[setName];
    if (!set?.groups.length) return false;
    const i = Math.max(0, Math.min(set.groups.length - 1, index));
    set.play = null;                      // 停掉自動播放，交給時間軸
    set.cur = i;
    set.groups.forEach((g, j) => { g.visible = j === i; });
    const e = set.entries[i];
    this._drawRouteAt(e, t);
    if (set.runner) { set.runner.group.visible = true; set.runner.group.position.copy(e.tip); }
    if (shotName) this.gotoShotAt(shotName, t);
    return true;
  }
  listShots() { return { ...(this._shots[this.sceneName] ?? {}) }; }
  clearShot(name) {
    const s = this._shots[this.sceneName];
    if (!s?.[name]) return false;
    delete s[name];
    return true;
  }

  /** 鏡頭直接放到某個分鏡上（編輯時預覽用，不飛、不動任何開關） */
  gotoShot(name) {
    const v = this.getShot(name);
    if (!v) return false;
    this._fly = null;
    this.controls.target.set(...v.target);
    this.camera.position.set(...v.pos);
    this.controls.update();
    return true;
  }

  /** 飛到某個分鏡。落地後：這個分鏡有存運鏡狀態就套上去（例如通關要自動旋轉），
     沒存就停在那裡不動。沒設過這個分鏡就什麼都不做、回 false */
  playShot(name, dur = 0.8, { defaultMotion = null } = {}) {
    const keys = this.shotKeys(name);
    if (!keys) return false;
    const motion = this.getShot(name)?.motion ?? defaultMotion;
    this._override = true;
    this._hold = true;
    this._flyTo(keys[0], dur, () => {
      if (!motion) {                    // 沒存運鏡＝定住。旗標也一起關掉，狀態才誠實
        this.controls.autoRotate = false;
        this.swing.on = false;
        return;
      }
      this._hold = false;               // 有存就放行，讓它照那個狀態轉
      this.applyMotion(motion);
    });
    return true;
  }

  /** 回到「待機」狀態：飛回存下來的視角，落地那一刻把待機的運鏡整組套回來
     （自動旋轉／擺動／速度／擺幅／A B）。鎖了 A/B 就回到 A 那一端，擺動接得剛剛好不會跳。 */
  releaseShot(dur = 0.8) {
    if (!this._override && !this._fly) return false;   // 沒被接管就不用還原
    const idle = this.savedViews[this.sceneName] ?? SCENE_VIEWS[this.sceneName];
    if (!idle?.pos) { this._hold = false; this._fly = null; this._override = false; return false; }
    const back = (idle.swing && idle.swingA) ? idle.swingA : idle;
    this._flyTo(back, dur, () => {
      this._hold = false;
      this._override = false;
      this.applyMotion(idle);
    });
    return true;
  }

  /** 從目前鏡頭平滑飛到 to（`{pos,target}`），dur 秒 */
  _flyTo(to, dur = 0.8, onEnd = null) {
    this._fly = {
      from: { pos: this.camera.position.toArray(), target: this.controls.target.toArray() },
      to: { pos: [...to.pos], target: [...to.target] },
      t0: this.clock.getElapsedTime(),
      dur: Math.max(0.01, dur),
      onEnd,
    };
  }

  /** 通關畫面：整棟建物全部變成白色實心（玻璃牆也套白色樓板那組色）。再叫一次 false 就變回去。
     白的時候會另外套一層「由上往下壓到陰影色」的頂點漸層，底部才不會一片死白 */
  setAllWhite(on) {
    this._allWhite = !!on;
    this._applyModelLook();
    this._applyHeightShade();
  }

  /** 依 `_allWhite` 決定牆板／樓板長什麼樣（顏色都從 CSS 主題變數讀，換主題也走這裡） */
  _applyModelLook() {
    const m = this._blueprintMats;
    if (!m) return;
    const white = this._allWhite;
    const slab = css('--m-slab', '#e4efff');
    // 白模式：材質本身設純白，實際顏色交給頂點色的漸層（不然兩個顏色相乘會整個變暗）
    m.wall.color.set(white ? 0xffffff : css('--m-wall', '#123049'));
    m.wall.emissive.set(slab);
    m.wall.emissiveIntensity = white ? SHADE.emissive : 0;
    m.wall.opacity = white ? 1 : 0.28;
    m.wall.transparent = !white;
    m.wall.depthWrite = white;                      // 變白＝實心，要寫深度才不會透出後面
    m.slab.color.set(white ? 0xffffff : slab);
    m.slab.emissive.set(slab);
    // 平常樓板帶 .35 自發光是為了「陰影裡不要變灰」；白模式反過來，就是要讓陰影看得出來
    m.slab.emissiveIntensity = white ? SHADE.emissive : 0.35;
    // 樓梯平常跟樓板一模一樣；**只有回程那半圈它會變成純綠**（白模式／通關優先，不受影響）。
    // 綠色期間的實際上色是每幀在 _updateStairGreen() 做的，這裡只負責「不是綠色時」的樣子。
    if (m.stair) {
      this._setStairVisible(true);                    // 可能停在抖動的某一格
      this._setStairSmear(0);                         // 殘影一定要收掉
      m.stair.color.set(white ? 0xffffff : slab);
      m.stair.emissive.set(slab);
      m.stair.emissiveIntensity = white ? SHADE.emissive : 0.35;
      m.stair.needsUpdate = true;
    }
    m.wall.needsUpdate = true;
    m.slab.needsUpdate = true;
  }

  /** 白模式的高度漸層：上面是 `--m-slab`、下面壓到 `--m-shade`，用頂點色做。
     算過的存在 geometry.userData 裡（key = 兩個顏色），換主題才重算，來回切不用重跑。 */
  _applyHeightShade() {
    const obj = this.customModels.tower;
    const m = this._blueprintMats;
    if (!obj || !m) return;
    const on = this._allWhite;
    for (const mat of [m.wall, m.slab, m.stair].filter(Boolean)) {
      if (mat.vertexColors !== on) { mat.vertexColors = on; mat.needsUpdate = true; }
    }
    if (!on) return;                                 // 關掉時留著算好的資料，下次再開就不用重算

    // ⚠️ 高度範圍只能用「建物本體」算。逃生動線的圓點也是 Mesh，而且線頭那顆待機時在原點，
    //    一起算進去的話 y 範圍會從 0 開始，整棟就都落在漸層的白色端、看起來完全沒有陰影。
    const meshes = [];
    obj.traverse((o) => {
      if (o.isMesh && (o.material === m.wall || o.material === m.slab || o.material === m.stair)) meshes.push(o);
    });
    if (!meshes.length) return;

    const cTop = new THREE.Color(css('--m-slab', '#e4efff'));
    const cBot = new THREE.Color(css('--m-shade', '#4d6a86'));
    const key = `${cTop.getHexString()}-${cBot.getHexString()}`;
    const box = new THREE.Box3();
    for (const o of meshes) { o.updateWorldMatrix(true, false); box.expandByObject(o); }
    const y0 = box.min.y;
    const span = Math.max(1e-3, (box.max.y - box.min.y) * SHADE.span);
    const v = new THREE.Vector3();
    const c = new THREE.Color();

    for (const o of meshes) {
      const g = o.geometry;
      const pos = g.getAttribute('position');
      if (g.userData.shadeKey === key && g.getAttribute('color')?.count === pos.count) continue;
      let col = g.getAttribute('color');
      if (!col || col.count !== pos.count) {
        col = new THREE.BufferAttribute(new Float32Array(pos.count * 3), 3);
        g.setAttribute('color', col);
      }
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
        let k = (v.y - y0) / span;
        k = k < 0 ? 0 : k > 1 ? 1 : k;
        k = k * k * (3 - 2 * k);                     // smoothstep，交界不要有一條硬邊
        col.setXYZ(i, ...c.copy(cBot).lerp(cTop, k).toArray());
      }
      col.needsUpdate = true;
      g.userData.shadeKey = key;
    }
  }

  /** 算出兩個視角之間 k 的位置，寫進 outPos / outTarget（不動相機）。
     軸心直接內插，鏡頭用球座標插角度／俯仰／距離 */
  _viewAt(a, b, k, outPos, outTarget, dir = 'auto') {
    const ta = _v1.fromArray(a.target);
    const tb = _v2.fromArray(b.target);
    const sa = _sa.setFromVector3(_v3.fromArray(a.pos).sub(ta));
    const sb = _sb.setFromVector3(_v4.fromArray(b.pos).sub(tb));
    let dTheta = sb.theta - sa.theta;
    while (dTheta > Math.PI) dTheta -= Math.PI * 2;      // 先收斂到 ±180°
    while (dTheta < -Math.PI) dTheta += Math.PI * 2;
    // 指定方向就強制繞那一邊（A→B 的去程方向；回程是原路折返）
    if (dir === 'ccw' && dTheta <= 0) dTheta += Math.PI * 2;
    else if (dir === 'cw' && dTheta >= 0) dTheta -= Math.PI * 2;
    _sc.radius = sa.radius + (sb.radius - sa.radius) * k;
    _sc.phi = sa.phi + (sb.phi - sa.phi) * k;
    _sc.theta = sa.theta + dTheta * k;
    outTarget.copy(ta.lerp(tb, k));
    outPos.copy(outTarget).add(_v5.setFromSpherical(_sc));
  }

  /** 在兩個視角之間內插並套到相機上（k=0 在 a、k=1 在 b） */
  _lerpView(a, b, k, dir = 'auto') {
    this._viewAt(a, b, k, _v6, _v7, dir);
    this.controls.target.copy(_v7);
    this.camera.position.copy(_v6);
  }

  /* ---------- 讓鏡頭等速：把時間改成按「鏡頭要走多遠」分配 ----------
     使用者設關鍵影格時是照「走到路徑的哪裡」放的，兩點之間鏡頭要移動多少完全不一定，
     照進度平均分時間的話，鏡頭就會忽快忽慢（實測差到 3.5 倍）。
     所以改成：先量每一段鏡頭實際要移動多遠，再照那個比例分配時間 ——
     鏡頭等速，代價是**人在路徑上會忽快忽慢**（使用者要的就是這個）。 */

  /**
   * 把關鍵影格串成一條**平滑曲線**並量好弧長表。兩個重點：
   *  1. 分段直線在關鍵點會有折角，等速通過折角看起來就是「頓一下轉向」→ 改走 Catmull-Rom。
   *  2. 球座標內插本身不等速（角度和距離同時在變）→ 量弧長做重新參數化，之後才能等速取樣。
   * 曲線走在 (水平角, 俯仰角, 距離) 這個空間，水平角要先解纏繞，不然會繞遠路。
   */
  _camPath(keys, samples = 96) {
    const sph = [], tgt = [];
    let prev = null;
    for (const k of keys) {
      const tv = new THREE.Vector3().fromArray(k.target);
      const s = _sa.setFromVector3(_v1.fromArray(k.pos).sub(tv));
      let th = s.theta;
      if (prev !== null) {                                // 解纏繞：跟上一個取最短的一邊
        while (th - prev > Math.PI) th -= Math.PI * 2;
        while (th - prev < -Math.PI) th += Math.PI * 2;
      }
      prev = th;
      sph.push(new THREE.Vector3(th, s.phi, s.radius));
      tgt.push(tv);
    }
    const path = {
      curveS: new THREE.CatmullRomCurve3(sph, false, 'catmullrom', 0.5),
      curveT: new THREE.CatmullRomCurve3(tgt, false, 'catmullrom', 0.5),
      keyT: keys.map((k) => k.t),
      n: Math.max(64, samples * (keys.length - 1)),   // 弧長表要夠密，不然重新參數化會有速度漣漪
    };
    // 弧長表：世界座標的實際移動量（鏡頭 + 軸心）
    const p0 = new THREE.Vector3(), p1 = new THREE.Vector3();
    const t0 = new THREE.Vector3(), t1 = new THREE.Vector3();
    path.table = new Float64Array(path.n + 1);
    this._camEval(path, 0, p0, t0);
    for (let i = 1; i <= path.n; i++) {
      this._camEval(path, i / path.n, p1, t1);
      path.table[i] = path.table[i - 1] + p0.distanceTo(p1) + t0.distanceTo(t1);
      p0.copy(p1); t0.copy(t1);
    }
    path.total = path.table[path.n];
    // 每個關鍵影格落在曲線上的弧長位置（影格平均分在 u = i/(影格數-1)）
    const m = Math.max(1, keys.length - 1);
    path.keyArc = keys.map((_, i) => {
      const x = Math.min(path.n, Math.max(0, (i / m) * path.n));
      const j = Math.min(path.n - 1, Math.floor(x));
      return path.table[j] + (path.table[j + 1] - path.table[j]) * (x - j);
    });
    return path;
  }

  /**
   * 鏡頭的時間表：**在每個關鍵影格停 hold 秒，中間再滑過去**。
   * 停的時間先扣掉，剩下的時間按「這一段鏡頭要走多遠」分給各段移動，
   * 每一段自己 ease in/out（停→動→停才不會突然抽動）。
   * 動線上的點不看這張表，照自己的等速跑（所以鏡頭和點不會完全對齊，這是刻意的）。
   */
  _camSchedule(path, dur, hold = 0.5) {
    const n = path.keyArc.length;
    const H = Math.min(hold, (dur * 0.7) / n);      // 至少留三成的時間給移動
    const move = Math.max(0.01, dur - H * n);
    const segs = [];
    let t = 0;
    for (let i = 0; i < n; i++) {
      segs.push({ hold: true, t0: t, t1: t + H, i });
      t += H;
      if (i < n - 1) {
        const cost = path.keyArc[i + 1] - path.keyArc[i];
        const d = move * (path.total > 0 ? cost / path.total : 1 / (n - 1));
        segs.push({ hold: false, t0: t, t1: t + d, i });
        t += d;
      }
    }
    return { segs, hold: H, end: t };
  }

  /** 依時間表算出這一刻鏡頭在曲線上的 u */
  _camUAtTime(path, sch, sec) {
    let s = sch.segs[sch.segs.length - 1];
    for (const x of sch.segs) if (sec <= x.t1) { s = x; break; }
    if (s.hold) return this._camAt(path, path.keyArc[s.i]).u;
    const f = Math.min(1, Math.max(0, (sec - s.t0) / (s.t1 - s.t0 || 1)));
    const e = f * f * (3 - 2 * f);                  // 這一段自己的加減速
    const a = path.keyArc[s.i], b = path.keyArc[s.i + 1];
    return this._camAt(path, a + (b - a) * e).u;
  }

  /** 曲線上 u（0~1）的鏡頭與軸心，寫進 out（不動相機） */
  _camEval(path, u, outPos, outTarget) {
    const x = Math.min(1, Math.max(0, u));
    const s = path.curveS.getPoint(x, _v2);
    path.curveT.getPoint(x, outTarget);
    _sc.theta = s.x;
    _sc.phi = Math.min(Math.PI - 1e-3, Math.max(1e-3, s.y));   // 別翻過天頂
    _sc.radius = Math.max(1e-3, s.z);                          // Catmull-Rom 會過衝，夾住
    outPos.copy(outTarget).add(_v3.setFromSpherical(_sc));
  }

  /** 鏡頭已經走了 s（弧長）時：在曲線上的 u，以及對應到動線的哪個進度 */
  _camAt(path, s) {
    let i = 1;
    while (i < path.n && path.table[i] < s) i++;
    const d = path.table[i] - path.table[i - 1];
    const u = (i - 1 + (d > 0 ? (s - path.table[i - 1]) / d : 0)) / path.n;
    // 關鍵影格平均落在 u = j/(影格數-1) 上，動線進度就照那個內插
    const m = path.keyT.length - 1;
    const x = Math.min(m - 1e-9, Math.max(0, u * m));
    const j = Math.floor(x);
    return { u, t: path.keyT[j] + (path.keyT[j + 1] - path.keyT[j]) * (x - j) };
  }

  /** 把曲線上 u 的鏡頭套到相機 */
  _applyCamAt(path, u) {
    this._camEval(path, u, _v6, _v7);
    this.controls.target.copy(_v7);
    this.camera.position.copy(_v6);
  }

  /** 把目前畫面上的視角記成這個場景的固定視角 */
  saveView(name = this.sceneName) {
    this.savedViews[name] = this.getView();
    delete this.savedViews[name].shots;   // 分鏡的唯一來源是 _shots
    return this.savedViews[name];
  }

  /** 存檔用：視角 + **目前**的分鏡。分鏡不存在 savedViews 裡，讀的時候才合併，
     不然編輯完分鏡又切一次狀態，就會被視角裡的舊快照蓋回去 */
  getSavedView(name = this.sceneName) {
    const v = this.savedViews[name];
    const shots = this._shots[name] ?? {};
    if (!v && !Object.keys(shots).length) return null;
    return { ...(v ?? {}), shots: { ...shots } };
  }

  applyView(name, v) {
    if (v && typeof v === 'object') this._shots[name] = { ...(v.shots ?? {}) };
    if (!Array.isArray(v?.pos) || !Array.isArray(v?.target)) return false;
    this.savedViews[name] = {
      pos: v.pos, target: v.target, autoRotate: !!v.autoRotate, speed: v.speed,
      swing: !!v.swing, swingAmp: v.swingAmp, swingDir: v.swingDir ?? 'auto',
      swingA: v.swingA ?? null, swingB: v.swingB ?? null,   // 鎖定的兩端
    };
    if (this.sceneName === name) this.setScene(name);
    return true;
  }

  /** 丟掉存下來的視角，回到該場景的預設 */
  clearView(name = this.sceneName) {
    delete this.savedViews[name];
    if (this.sceneName === name) this.setScene(name);
  }

  setAutoRotate(on) { this.controls.autoRotate = !!on; if (on) this.swing.on = false; }  // 兩種轉法互斥

  /** 暫停自動旋轉／擺動（編輯視角時用）。**不會動到存檔裡的開關狀態**，只是這段時間不要跟使用者搶鏡頭 */
  pauseMotion(on) { this._motionPaused = !!on; }
  /** 自動旋轉速度（可正可負，負值反向）；擺動模式也用這支當快慢 */
  setAutoRotateSpeed(s) { this.controls.autoRotateSpeed = s; }

  /** 來回擺動：在目前角度 ± 擺幅之間來回，不轉整圈。
     設過 A / B 兩端（`setSwingRange`）的話改成在那兩個視角之間來回。 */
  setSwing(on) {
    this.swing.on = !!on;
    if (on) {
      this.controls.autoRotate = false;
      this.swing.center = new THREE.Spherical()
        .setFromVector3(this.camera.position.clone().sub(this.controls.target)).theta;
      this.swing.t0 = this.clock.getElapsedTime();   // 鎖定兩端時＝從 A 那一端開始
    }
  }
  /** 擺動的去程要繞哪一邊：'auto' 走最短、'cw' 順時針、'ccw' 逆時針（由上往下看）。
     只有鎖了 A/B 才有意義；沒鎖的話是「目前角度 ± 擺幅」，本來就對稱 */
  setSwingDir(d) { this.swing.dir = (d === 'cw' || d === 'ccw') ? d : 'auto'; }

  /** 擺動幅度（左右各幾度） */
  setSwingAmp(deg) { this.swing.amp = THREE.MathUtils.degToRad(Math.max(0, deg)); }

  /** 整組動線顯示／隱藏。前言頁跟第一頁共用同一個 flat 場景，但前言頁只要建物的線，
      不要動線在那邊輪播 —— 收起來之後 slot 歸 -1，再打開時會重新挑一條。 */
  setRoutesVisible(name, on) {
    // ⚠️ **要記在 viewer 上**：模型是非同步載入的，開機第一頁（前言）呼叫進來的時候
    //    _routeSets[name] 通常還不存在，只改 set 的話這一次會整個沒作用（動線照樣在跑）。
    //    等 _buildRoutes 建好時再從這裡把狀態套上去。
    (this._routesOff ??= {})[name] = !on;
    const set = this._routeSets?.[name];
    if (!set) return;
    set.off = !on;
    set.slot = -1;
    if (!on) set.groups.forEach((g) => { g.visible = false; });
  }

  /** 逃生起點圓點的時段（跟倒數同步）：0=0-10s藍 1=10-20s黃 2=20-30s紅（-1 = 還沒開始）。
     顏色一切換就換一條動線，並把輪播節奏從這一刻重新起算。
     seconds = 這個時段有多長（秒），用來算「還放不放得下完整的一條」。

     ⚠️ **起訖時間要記在 viewer 上、不要只記在 set 裡**：模型是非同步載入的，
     第一個時段（藍）通知進來的時候 _routeSets.flat 通常還不存在，
     等它建好時再從這裡把節奏對齊 —— 不然藍色那段的格子會錨在「載入完 + 1 秒」，
     跟倒數的時段邊界對不起來，接黃色的時候就會有一條只跑到一半就被換掉。 */
  setRoutePhase(idx, seconds = 0) {
    const changed = idx !== this._routePhase;
    this._routePhase = idx;
    if (changed) {
      const t = this.clock.getElapsedTime();
      this._phaseT0 = t;
      this._phaseEnd = (idx >= 0 && seconds > 0) ? t + seconds : Infinity;
    }
    const set = this._routeSets?.flat;                 // 只有第一頁的動線跟倒數時段連動
    if (changed && set?.groups.length) {
      set.t0 = this._phaseT0;                          // 顏色一換 = 換一條動線 + 節奏重新起算
      set.slot = 0;
      this._pickRouteInSet(set);
    }
  }

  /** 互動模式：
     'orbit'  編輯用 —— 左鍵轉角度、右鍵平移、滾輪縮放（右鍵平移同時移動旋轉軸心）
     'pivot'  只平移 —— 左鍵拖曳平移（觸控／不方便按右鍵時用）
     'kiosk'  展示用 —— 只能轉、不能平移，避免現場把模型拖走 */
  setInteractionMode(mode) {
    const c = this.controls;
    if (mode === 'pivot') {
      c.enableRotate = false; c.enablePan = true;
      c.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
      c.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE };
    } else if (mode === 'kiosk') {
      c.enableRotate = true; c.enablePan = false;
      c.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
      c.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    } else {
      c.enableRotate = true; c.enablePan = true;   // 右鍵平移
      c.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
      c.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    }
  }

  /** 鎖住鏡頭：滑鼠完全不能轉／縮放／平移。第一頁（flat）用。
      它是固定俯視，現場手滑一下就轉走而且回不來 —— 而且**接近正俯視是 OrbitControls 的極點**，
      在那附近拖一點點就會甩很大，所以乾脆整個鎖掉。
      只影響「使用者輸入」：controls.update() 照跑，自動旋轉／擺動／程式設定的鏡頭都不受影響。 */
  setCameraLock(on) { this._camLock = !!on; this._syncCamLock(); }

  /** 編輯模式的「調整模型／調整軸心」期間暫時解鎖，不然第一頁就永遠調不了了 */
  freeCamera(on) { this._camFree = !!on; this._syncCamLock(); }

  _syncCamLock() { this.controls.enabled = !(this._camLock && !this._camFree); }

  /** 顯示／隱藏「旋轉軸心」的視覺輔助線（一條通過 target 的垂直軸） */
  showPivot(on) {
    if (!this._pivotHelper) {
      const mat = new THREE.LineBasicMaterial({
        color: new THREE.Color(css('--amber', '#ffb42e')),
        transparent: true, opacity: 0.9, depthTest: false,
      });
      const geo = new THREE.BufferGeometry().setFromPoints(
        [new THREE.Vector3(0, -1000, 0), new THREE.Vector3(0, 1000, 0)]
      );
      const line = new THREE.Line(geo, mat);
      line.renderOrder = 999;
      this._pivotHelper = line;
      this.scene.add(line);
    }
    this._pivotHelper.visible = !!on;
  }

  /** 使用者拖／縮放結束時通知一次（自動旋轉不會觸發） */
  onViewEnd(cb) { this.controls.addEventListener('end', cb); }

  /* ---------- 單層平面圖 ---------- */
  _buildFlat() {
    const g = new THREE.Group();

    // 地板
    const floor = new THREE.Mesh(
      new THREE.BoxGeometry(20.4, 0.3, 12.4),
      new THREE.MeshStandardMaterial({
        color: new THREE.Color(css('--m-floor', '#0a1c30')),
        roughness: 0.95,
        metalness: 0,
      })
    );
    floor.position.y = -0.15;
    g.add(floor);

    const grid = new THREE.GridHelper(
      20, 20,
      new THREE.Color(css('--m-grid', '#2f9dff')),
      new THREE.Color(css('--m-grid-2', '#1c4a6b'))
    );
    grid.material.transparent = true;
    grid.material.opacity = 0.16;
    grid.position.y = 0.012;
    g.add(grid);

    // 牆體（線段定義：x1,z1,x2,z2）
    const segs = [
      [-10, -6, 10, -6], [10, -6, 10, 6], [10, 6, -10, 6], [-10, 6, -10, -6],
      [-2, -6, -2, 1], [-2, 1, 4, 1], [4, 1, 4, 6], [-10, 1, -6, 1], [4, -6, 4, -2],
    ];
    const wallMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(css('--m-wall', '#123049')),
      roughness: 0.8,
      metalness: 0.05,
    });
    const edgeMat = new THREE.LineBasicMaterial({
      color: new THREE.Color(css('--m-edge', '#74d4ff')),
      transparent: true,
      opacity: 0.55,
    });
    const H = 1.7, T = 0.28;

    for (const [x1, z1, x2, z2] of segs) {
      const len = Math.hypot(x2 - x1, z2 - z1);
      const geo = new THREE.BoxGeometry(len, H, T);
      const wall = new THREE.Mesh(geo, wallMat);
      wall.position.set((x1 + x2) / 2, H / 2, (z1 + z2) / 2);
      wall.rotation.y = -Math.atan2(z2 - z1, x2 - x1);
      g.add(wall);
      wall.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo), edgeMat));
    }

    g.add(this._makeFire(-6, 0.6, -3));

    // 逃生出口（沿用國際通用的綠色，不隨主題變動）
    const exitColor = new THREE.Color(css('--exit', '#3dffa0'));
    const exit = new THREE.Mesh(
      new THREE.BoxGeometry(0.16, 1.0, 1.7),
      new THREE.MeshBasicMaterial({ color: exitColor })
    );
    exit.position.set(10, 0.9, 3.6);
    g.add(exit);
    const exitLight = new THREE.PointLight(exitColor, 14, 12, 2);
    exitLight.position.set(9.2, 1.4, 3.6);
    g.add(exitLight);

    g.add(this._makeRoute([
      [-6, 0.12, -3], [-6, 0.12, 3.6], [9.4, 0.12, 3.6],
    ]));
    return g;
  }

  /* ---------- 三層疊起來的大樓 ---------- */
  _buildTower() {
    const g = new THREE.Group();
    const FLOORS = 3;
    const FH = 2.95;                 // 樓層間距（牆高 2.3，留一點縫看得到分層）
    const W = 15, D = 9.5;           // 樓板尺寸

    // 樓板：偏藍的白，帶一點自發光才不會在陰影裡變灰
    const slabColor = new THREE.Color(css('--m-slab', '#e4efff'));
    const slabMat = new THREE.MeshStandardMaterial({
      color: slabColor,
      emissive: slabColor,
      emissiveIntensity: 0.16,
      roughness: 0.9, metalness: 0,
      transparent: true, opacity: 0.62,
    });
    const wallMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(css('--m-wall', '#123049')),
      roughness: 0.8, metalness: 0.05, transparent: true, opacity: 0.5,
    });
    const edgeMat = new THREE.LineBasicMaterial({
      color: new THREE.Color(css('--m-edge', '#74d4ff')),
      transparent: true, opacity: 0.6,
    });

    // 每層的隔間（線段：x1,z1,x2,z2）
    const plan = [
      [-W / 2, -D / 2, W / 2, -D / 2], [W / 2, -D / 2, W / 2, D / 2],
      [W / 2, D / 2, -W / 2, D / 2], [-W / 2, D / 2, -W / 2, -D / 2],
      [-2.5, -D / 2, -2.5, 0.5], [-2.5, 0.5, 3.5, 0.5], [3.5, 0.5, 3.5, D / 2],
    ];
    const H = 2.3, T = 0.2;

    for (let f = 0; f < FLOORS; f++) {
      const fl = new THREE.Group();
      fl.position.y = f * FH;
      g.add(fl);

      const slab = new THREE.Mesh(new THREE.BoxGeometry(W + 0.4, 0.22, D + 0.4), slabMat);
      slab.position.y = -0.11;
      fl.add(slab);
      fl.add(new THREE.LineSegments(new THREE.EdgesGeometry(slab.geometry), edgeMat).translateY(-0.11));

      for (const [x1, z1, x2, z2] of plan) {
        const len = Math.hypot(x2 - x1, z2 - z1);
        const geo = new THREE.BoxGeometry(len, H, T);
        const wall = new THREE.Mesh(geo, wallMat);
        wall.position.set((x1 + x2) / 2, H / 2, (z1 + z2) / 2);
        wall.rotation.y = -Math.atan2(z2 - z1, x2 - x1);
        fl.add(wall);
        wall.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo), edgeMat));
      }
    }

    // 起火點在頂樓
    g.add(this._makeFire(-5, (FLOORS - 1) * FH + 0.6, -2.6));

    // 一樓出口
    const exitColor = new THREE.Color(css('--exit', '#3dffa0'));
    const exit = new THREE.Mesh(
      new THREE.BoxGeometry(0.16, 1.0, 1.6),
      new THREE.MeshBasicMaterial({ color: exitColor })
    );
    exit.position.set(W / 2, 0.85, 3);
    g.add(exit);
    const exitLight = new THREE.PointLight(exitColor, 16, 14, 2);
    exitLight.position.set(W / 2 - 0.8, 1.3, 3);
    g.add(exitLight);

    // 逃生動線：頂樓 → 樓梯間垂直往下 → 一樓出口
    const SX = 5.6, SZ = -2.6;                    // 樓梯間位置
    const top = (FLOORS - 1) * FH + 0.14;
    g.add(this._makeRoute([
      [-5, top, -2.6], [SX, top, SZ],
      [SX, FH + 0.14, SZ], [SX, 0.14, SZ],
      [SX, 0.14, 3], [W / 2 - 0.4, 0.14, 3],
    ]));
    return g;
  }

  /* ---------- 共用零件 ---------- */
  _makeFire(x, y, z) {
    const fire = new THREE.Group();
    fire.position.set(x, y, z);
    fire.add(new THREE.Mesh(
      new THREE.SphereGeometry(0.42, 24, 18),
      new THREE.MeshBasicMaterial({ color: 0xff5a3d })
    ));
    const halo = new THREE.Mesh(
      new THREE.SphereGeometry(1.1, 24, 18),
      new THREE.MeshBasicMaterial({ color: 0xff3b2a, transparent: true, opacity: 0.18, depthWrite: false })
    );
    fire.add(halo);
    const light = new THREE.PointLight(0xff5530, 26, 16, 2);
    fire.add(light);
    this.fires.push({ halo, light, ph: this._ph });   // ph = 佔位場景的，換主題重建時會被清掉
    return fire;
  }

  _makeRoute(points) {
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(points.map((p) => new THREE.Vector3(...p))),
      new THREE.LineDashedMaterial({
        color: new THREE.Color(css('--exit', '#3dffa0')),
        dashSize: 0.7, gapSize: 0.45, transparent: true, opacity: 0.9,
      })
    );
    line.computeLineDistances();
    line.userData.ph = this._ph;                     // 同上，佔位場景的虛線
    this.routes.push(line);
    return line;
  }

  /* ---------- 首頁：把真實建築模型改成「透視感牆面 + 白色樓板 + 逃生動線」 ----------
     模型在離線步驟已把材質收斂成兩種（名稱 'wall' / 'slab'），這裡照第一頁佔位場景那套
     配色重新上材質（讀 CSS 主題變數，所以藍／綠主題一樣會跟著變）。 */
  async loadHomeModel(url, onProgress) {
    let routeData = null;
    try {
      const res = await fetch('./models/routes-home.json', { cache: 'no-cache' });
      if (res.ok) routeData = await res.json();
    } catch { /* 沒有路線檔就不畫逃生動線 */ }
    return new Promise((resolve, reject) => {
      this._loader().load(
        url,
        (gltf) => {
          const prev = this.customModels.tower;
          if (prev) { this.modelRoot.remove(prev); disposeTree(prev); }
          const obj = gltf.scene;
          if (!this._blueprintMats) this._blueprintMats = this._makeBlueprintMats();  // 首頁：玻璃 + 白樓板
          this._styleBlueprint(obj, this._blueprintMats);   // 換材質 + 加結構邊線（透視感）
          // 逃生動線（固定紅/綠）：首頁改成按鈕觸發，平常藏著
          if (routeData?.routes?.length) obj.add(this._buildRoutes('tower', routeData.routes, { phase: false, mode: 'manual', glow: true }));
          this.customModels.tower = obj;
          this.modelRoot.add(obj);
          this.customViews.tower = this._frameView(obj);
          this.setScene(this.sceneName);
          resolve(gltf);
        },
        (e) => onProgress?.(e.total ? (e.loaded / e.total) * 100 : 0),
        reject
      );
    });
  }

  /** 第一頁：載入單層真實模型到 flat 場景，套用同一套玻璃/白樓板/框線 + 單層逃生動線 */
  async loadFlatModel(url, onProgress) {
    let routeData = null;
    try {
      const res = await fetch('./models/routes.json', { cache: 'no-cache' });
      if (res.ok) routeData = await res.json();
    } catch { /* 沒有路線檔就不畫逃生動線 */ }
    return new Promise((resolve, reject) => {
      this._loader().load(
        url,
        (gltf) => {
          const prev = this.customModels.flat;
          if (prev) { this.modelRoot.remove(prev); disposeTree(prev); }
          const obj = gltf.scene;
          if (!this._flatMats) this._flatMats = this._makeFlatMats();   // 第一頁：深色 + 強框線
          this._styleBlueprint(obj, this._flatMats);
          if (routeData?.routes?.length) obj.add(this._buildRoutes('flat', routeData.routes, { phase: true }));  // 逃生動線（起點跟倒數變色）
          this.customModels.flat = obj;
          this.modelRoot.add(obj);
          this.customViews.flat = { ...this._frameView(obj), autoRotate: false, swing: false };  // 第一頁預設就不轉
          this.setScene(this.sceneName);
          resolve(gltf);
        },
        (e) => onProgress?.(e.total ? (e.loaded / e.total) * 100 : 0),
        reject
      );
    });
  }

  _makeBlueprintMats() {
    // 牆板：半透明玻璃面（保留牆板、可看穿內部）+ 上面再加框線 —— 玻璃屋剖面的透視感
    const wall = new THREE.MeshStandardMaterial({
      color: new THREE.Color(css('--m-wall', '#123049')),
      roughness: 0.85, metalness: 0.0,
      transparent: true, opacity: 0.28, depthWrite: false,   // 不寫深度，前後玻璃才會層層疊透
      side: THREE.DoubleSide,   // 兩面都畫，轉到牆背面玻璃也在
    });
    const slab = new THREE.MeshStandardMaterial({
      color: new THREE.Color(css('--m-slab', '#e4efff')),
      emissive: new THREE.Color(css('--m-slab', '#e4efff')), emissiveIntensity: 0.35,
      roughness: 0.9, metalness: 0,
      side: THREE.DoubleSide,   // 實心白樓板（不透明），任何角度都是穩定的實面
    });
    // 樓梯：平常跟樓板長得一模一樣，但**是獨立的材質**，這樣待機反轉那半趟才能只把它變綠
    const stair = slab.clone();
    // 框線不寫深度：不然近側框線會把後面牆板的玻璃遮掉，整棟就變成只剩線框
    const edge = new THREE.LineBasicMaterial({
      color: new THREE.Color(css('--m-edge', '#74d4ff')), transparent: true, opacity: 0.5,
      depthWrite: false,
    });
    return { wall, slab, stair, edge, wallEdgeAngle: 30 };   // 首頁牆面只留主要結構線（30°）
  }

  _styleBlueprint(obj, mats) {
    const { wall, slab, edge } = mats;
    const stair = mats.stair ?? slab;                         // 第一頁沒有獨立的樓梯材質，就跟樓板同一個
    const wallAngle = mats.wallEdgeAngle ?? 30;
    obj.traverse((o) => {
      if (!o.isMesh) return;
      const nm = o.material?.name;
      if (nm === 'wall-cut') { o.visible = false; return; }   // 剖面：挖掉靠近視角的兩面外牆
      if (nm === 'floor') { o.visible = false; return; }      // 第一頁：地板抽掉（樓梯 slab 保留）
      const isSlab = nm === 'slab' || nm === 'stair';
      o.material = nm === 'stair' ? stair : isSlab ? slab : wall;
      // 記下來：抖動的時候要拿它做殘影
      if (nm === 'stair' && mats.stair) (this._stairMeshes ??= []).push(o);
      // 樓板整圈邊線（1°）；牆板依材質設定的門檻（首頁 30° 只留結構線、第一頁 1° 每個轉角都畫）
      o.add(new THREE.LineSegments(new THREE.EdgesGeometry(o.geometry, isSlab ? 1 : wallAngle), edge));
    });
    if (mats.stair) this._makeStairGhosts();
  }

  /** 樓梯的「橫向殘影」：左右各 ghosts 層，共用同一份 geometry（不佔記憶體）。
      平常藏著，抖動的時候才推出去 —— 這就是外溢的視覺。
      材質用 MeshBasicMaterial（不吃光）+ 相加混色，所以疊起來只會更亮、不會變髒。 */
  _makeStairGhosts() {
    const src = this._stairMeshes?.[0];
    if (!src || this._stairGhosts) return;
    const n = STAIR_GREEN.ghosts;
    this._stairGhosts = [];
    for (let i = 0; i < n * 2; i++) {
      const g = new THREE.Mesh(src.geometry, new THREE.MeshBasicMaterial({
        color: new THREE.Color(css('--exit', '#3dffa0')),
        transparent: true, opacity: 0, depthWrite: false,
        blending: THREE.AdditiveBlending,
      }));
      g.visible = false;
      g.renderOrder = 1;
      g.userData.step = Math.floor(i / 2) + 1;          // 第幾層（1 = 最靠近本體）
      g.userData.side = i % 2 ? 1 : -1;
      src.parent.add(g);
      this._stairGhosts.push(g);
    }
    this._stairBase = src;
  }

  /** 把殘影推出去／收回來。b = 外溢強度 0~1。
      **偏移方向取「相機的右方」**，所以不管鏡頭轉到哪，外溢永遠是畫面上的水平方向。 */
  _setStairSmear(b) {
    const gs = this._stairGhosts;
    if (!gs?.length) return;
    if (b <= 0.001) { for (const g of gs) g.visible = false; return; }
    const src = this._stairBase;
    src.updateWorldMatrix(true, false);
    // 相機的右方向 → 換算成 src 父層的區域方向（transformDirection 只轉方向、不含位移）
    src.parent.updateWorldMatrix(true, false);
    _sgDir.setFromMatrixColumn(this.camera.matrixWorld, 0);
    _sgMat.copy(src.parent.matrixWorld).invert();
    _sgDir.transformDirection(_sgMat);
    const n = STAIR_GREEN.ghosts;
    for (const g of gs) {
      const k = g.userData.step / n;                     // 越外層偏移越大、越淡
      g.visible = true;
      g.position.copy(src.position).addScaledVector(_sgDir, g.userData.side * STAIR_GREEN.spread * k * b);
      g.material.opacity = STAIR_GREEN.ghostOp * b * (1 - 0.55 * (k - 1 / n));
    }
  }

  /** 第一頁：跟佔位模型同一套簡單材質 —— 實心深色牆 + 淺藍框線（每個轉角都有線）+ 白色樓板 */
  _makeFlatMats() {
    const wall = new THREE.MeshStandardMaterial({
      color: new THREE.Color(css('--m-wall', '#123049')),
      roughness: 0.8, metalness: 0.05, side: THREE.DoubleSide,  // 實心（不透明）深色牆，後面的框線會被擋掉→乾淨
    });
    const slab = new THREE.MeshStandardMaterial({
      color: new THREE.Color(css('--m-slab', '#e4efff')),
      emissive: new THREE.Color(css('--m-slab', '#e4efff')), emissiveIntensity: 0.14,
      roughness: 0.9, metalness: 0, side: THREE.DoubleSide,   // 白色樓板
    });
    const edge = new THREE.LineBasicMaterial({
      color: new THREE.Color(css('--m-edge', '#74d4ff')),
      transparent: true, opacity: 0.6, depthWrite: false,   // 淺藍框線
    });
    return { wall, slab, edge, wallEdgeAngle: 1 };   // 1° = 每條邊/每個轉角都畫（同佔位）
  }

  /** 前言／結語頁把整張 canvas 壓淡（CSS）之後，第一頁那組動線細得看不見。
      這支就是**替動線單獨加一層粗的相加光暈**，只在那兩頁打開 —— 模型的材質完全不碰。
      ⚠️ 光暈是 _buildRoutes 就先做好放著（set.boost），這裡只切 visible。
         現做的話 Line2 要重新算 lineDistances 和畫布解析度，切頁會頓一下。 */
  /** 前言／結語頁把平面圖的**建物**壓淡到 k（1 = 原本亮度，0.18 = 現在用的）。
      逃生動線**不會**跟著淡掉。

      做法是在建物和動線中間插一張蓋滿畫面的 veil，用自訂混色把**已經畫好的畫面**
      整片乘上 k（rgb 和 alpha 一起乘，等同於「對這一半的畫面下 CSS opacity」），
      動線排在 veil 後面才畫，所以維持原本的亮度。

      ⚠️ **不要改回用 CSS 壓整張 canvas** —— 建物和動線畫在同一張畫布上，
         CSS 的 opacity 會把動線一起壓掉，而且是**硬上限**：canvas 壓到 .18 之後，
         不管在裡面把動線加多亮，最多也只有 18% 的亮度（實測疊兩層光暈只從 9.27 進步到 10.74）。
      ⚠️ **也不要改回去調模型的材質** —— 牆改成半透明的話後面的框線會全部透出來、
         整張圖會糊；把顏色往背景色 lerp 又會整棟發黑。兩種都試過了。
      這支從頭到尾沒有碰任何一支模型材質，離開那兩頁只要 setPlanDim(1) 就完全復原。 */
  setPlanDim(k = 1) {
    this._planDim = k;
    const on = k < 0.999;
    if (!on && !this._planVeil) return;             // 沒壓過也不用壓，veil 連建都不用建
    const veil = (this._planVeil ??= this._makePlanVeil());
    veil.material.uniforms.a.value = k;
    veil.visible = on;
  }

  /** setPlanDim 用的那張 veil：蓋滿整個畫面、把 destination 乘上 a。
      ⚠️ 頂點直接吐 clip space（不吃相機矩陣），所以要關掉 frustumCulled，
         不然相機轉一下它就被剔除、壓淡整片消失。
      ⚠️ 混色是 dst = dst * srcAlpha（src 完全不加進去），**rgb 和 alpha 要分別設**，
         alpha 沒跟著乘的話畫布的透明度不對，底下 CSS 的漸層會透不出來。 */
  _makePlanVeil() {
    const mat = new THREE.ShaderMaterial({
      uniforms: { a: { value: 1 } },
      vertexShader: 'void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: 'uniform float a; void main(){ gl_FragColor = vec4(0.0, 0.0, 0.0, a); }',
      transparent: true, depthTest: false, depthWrite: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.ZeroFactor,      blendDst: THREE.SrcAlphaFactor,
      blendEquationAlpha: THREE.AddEquation,
      blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.SrcAlphaFactor,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = PLAN_LAYER.veil;
    mesh.visible = false;
    this.scene.add(mesh);
    return mesh;
  }

  /** 這一組**多久換一條**（秒）。傳 0／不傳就回到預設的 ROUTE_SLOT。
      前言／結語頁要跟畫面上輪播的文字踩同一個節拍，所以外面會把 CSS 的 --roll 傳進來。
      ⚠️ 不能只改長度不動起點 —— 那樣第一條會接在上一個節拍剩下的殘量上，跟文字差半拍。
         所以這裡一併把 t0 對到現在、把 slot 設成 -1（下一幀立刻換一條），
         文字那邊同時重播動畫，兩邊就從同一個瞬間一起起跑。
      ⚠️ 回到預設的時候要把 t0 **對回倒數時段的起點**（第一頁那組），
         不然時段邊界不會落在格子邊界上，又會出現一條只閃過去的。 */
  setRouteSlot(name, seconds = 0) {
    const custom = seconds > 0;
    (this._routeSlot ??= {})[name] = custom ? seconds : 0;
    const set = this._routeSets?.[name];
    if (!set) return;                             // 模型還沒載完，記著等 _buildRoutes 之後補
    set.slotSec = custom ? seconds : ROUTE_SLOT;
    set.t0 = (!custom && set.phase && this._phaseT0 != null)
      ? this._phaseT0
      : this.clock.getElapsedTime();
    set.slot = -1;
  }

  setRouteBoost(name, on) {
    (this._routeBoost ??= {})[name] = !!on;
    const set = this._routeSets?.[name];
    if (!set) return;                             // 模型還沒載完，記著等 _buildRoutes 之後補
    this._applyBoost(set, !!on);
  }

  /** 覆蓋層 + 兩端標記一起切。**兩端是二選一**：
      打開＝前言／結語那套（起點圓點 → 箭頭 → 出口標誌），關掉＝第一頁原本的紅起點／綠終點。
      兩套同時出現會變成起點有紅有藍、終點有綠點又有標誌，很亂。 */
  _applyBoost(set, on) {
    for (const l of set.boost ?? []) l.visible = on;
    for (const m of set.marks ?? []) m.visible = on;
    for (const d of set.startDots ?? []) d.group.visible = !on;
    for (const d of set.endDots ?? []) d.group.visible = !on;
  }

  /** 動線兩端的標記，回一組還沒掛上去的物件（起點圓點、末端箭頭、出口標誌）。
      ⚠️ 每一支都要 transparent:true —— 不透明的物件會被排進**不透明那一輪**，
         在 veil 之前就畫完了，renderOrder 排再後面也沒用，會跟著建物一起被壓淡。
      ⚠️ 出口標誌用 Sprite（永遠面向鏡頭）。平面圖是斜視角，貼在地上的話會被壓成一片斜的。 */
  _makeRouteMarks(pts, color) {
    const out = [];
    const last = pts[pts.length - 1];
    const prev = pts[pts.length - 2] ?? pts[0];
    const dir = last.clone().sub(prev).setY(0).normalize();

    // 起點：實心圓 + 外圈暈
    const d = ROUTE_MARK.dot;
    const core = new THREE.Mesh(new THREE.SphereGeometry(d.core, 18, 12),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1, depthWrite: false }));
    core.position.copy(pts[0]);
    core.renderOrder = PLAN_LAYER.mark + 1;
    const halo = new THREE.Mesh(new THREE.SphereGeometry(d.halo, 18, 12),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: d.haloOp, depthWrite: false, blending: THREE.AdditiveBlending }));
    halo.position.copy(pts[0]);
    halo.renderOrder = PLAN_LAYER.mark;
    out.push(halo, core);

    // 末端箭頭：貼在地上（跟虛線同一個平面），所以透視是跟著動線走的
    const a = ROUTE_MARK.arrow;
    const side = new THREE.Vector3(-dir.z, 0, dir.x);
    const p1 = last.clone();
    const p2 = last.clone().addScaledVector(dir, -a.len).addScaledVector(side,  a.half);
    const p3 = last.clone().addScaledVector(dir, -a.len).addScaledVector(side, -a.half);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([...p1.toArray(), ...p2.toArray(), ...p3.toArray()], 3));
    const arrow = new THREE.Mesh(geo,
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1, depthWrite: false, side: THREE.DoubleSide }));
    arrow.renderOrder = PLAN_LAYER.mark + 1;
    out.push(arrow);

    // 出口標誌：站在動線末端再往前一點的位置
    const s = ROUTE_MARK.sign;
    const sign = new THREE.Sprite(new THREE.SpriteMaterial({
      map: exitSignTexture(), color, transparent: true, depthWrite: false, depthTest: false,
    }));
    sign.scale.setScalar(s.size);
    sign.position.copy(last).addScaledVector(dir, s.gap);
    sign.position.y += s.lift;
    sign.renderOrder = PLAN_LAYER.mark + 2;
    out.push(sign);

    for (const o of out) o.visible = false;
    return out;
  }

  _tintBlueprint() {
    if (this._blueprintMats) {                 // 首頁：玻璃 + 白樓板
      const m = this._blueprintMats;
      this._applyModelLook();                  // 牆板／樓板都走這支（通關的「整棟變白」也在裡面）
      this._applyHeightShade();                // 陰影漸層的顏色也跟著主題重算
      m.edge.color.set(css('--m-edge', '#74d4ff'));
    }
    if (this._flatMats) {                       // 第一頁：實心深色色塊 + 淺藍框線 + 白樓板
      const m = this._flatMats;
      m.wall.color.set(css('--m-wall', '#123049'));
      m.slab.color.set(css('--m-slab', '#e4efff'));
      m.slab.emissive.set(css('--m-slab', '#e4efff'));
      m.edge.color.set(css('--m-edge', '#74d4ff'));
    }
  }

  /* 逃生動線：第一頁(flat)、首頁(tower)各建立一組獨立的路線集。
     每條起點閃紅、終點閃綠。
     mode='auto'   ：一次只隨機顯示一條、每 2 秒換、下一條避開前兩條；載入後第一秒先不出現（第一頁）
     mode='manual' ：平常全部藏著，等 playRoute() 才從起點一路畫到出口（首頁的按鈕）
     phase=true：起點顏色跟倒數時段變（藍→黃→紅，第一頁用）；false：固定紅（首頁用）。
     glow=true ：粗的紅色發光虛線（Line2，見 ROUTE_LINE）。**只有首頁開，第一頁維持細綠線。** */
  _buildRoutes(name, routes, { phase = false, mode = 'auto', glow = false } = {}) {
    this._routeSets = this._routeSets || {};
    const g = new THREE.Group();
    // recent = playRoute（首頁按按鈕）避開最近播過的；bag = 第一頁自動輪播的洗牌袋
    // off = 整組收起來（前言頁只要平面圖的建物線，不要動線在跑）
    const set = { groups: [], entries: [], startDots: [], recent: [], bag: [], cur: -1, slot: -1, off: false, phase, mode, play: null };
    const lineColor = new THREE.Color(css('--exit', '#3dffa0'));   // 兩頁都用安全出口的綠（語意色，不隨主題變）
    for (const r of routes) {
      const rg = new THREE.Group();
      const pts = r.points.map((p) => new THREE.Vector3(p[0], p[1] + 0.15, p[2]));  // 稍微抬離地面
      // 位置另外開一份可改寫的緩衝區：manual 模式要一段一段把線畫出來（改座標 + drawRange）
      const pos = new Float32Array(pts.length * 3);
      pts.forEach((p, i) => { pos[i * 3] = p.x; pos[i * 3 + 1] = p.y; pos[i * 3 + 2] = p.z; });
      let line;
      if (glow) {
        // 粗的紅色發光虛線：核心 + 更寬的相加光暈，**兩條共用同一份 geometry**（畫到哪裡只更新一次）
        const geo = new LineGeometry();
        geo.setPositions(pos);
        const mk = (w, o, add) => {
          const m = new LineMaterial({
            color: lineColor, linewidth: w, dashed: true,
            dashSize: ROUTE_LINE.dash, gapSize: ROUTE_LINE.gap,
            transparent: true, opacity: o,
            depthWrite: !add,                                    // 光暈不寫深度，才不會互相切
            blending: add ? THREE.AdditiveBlending : THREE.NormalBlending,
          });
          this._lineMats.push(m);
          const l = new Line2(geo, m);
          l.computeLineDistances();
          l.renderOrder = add ? 1 : 2;                           // 光暈先畫、核心壓在上面
          return l;
        };
        const halo = mk(ROUTE_LINE.halo, ROUTE_LINE.haloOpacity, true);
        line = mk(ROUTE_LINE.width, 0.98, false);
        rg.add(halo); rg.add(line);
        this.routes.push(halo, line);                            // 虛線流動（兩條要同步）
      } else {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        geo.setDrawRange(0, pts.length);
        line = new THREE.Line(
          geo,
          new THREE.LineDashedMaterial({ color: lineColor, dashSize: 0.7, gapSize: 0.45, transparent: true, opacity: 0.95 })
        );
        line.computeLineDistances();
        line.renderOrder = PLAN_LAYER.route;                     // 一定要排在 veil 後面才不會被壓淡
        this.routes.push(line);                                  // 虛線流動
        rg.add(line);

        // 同一條路再疊幾層**相加的覆蓋層**，平常關著（setRouteBoost 才打開）。
        // 前言／結語頁的 canvas 被 CSS 壓到 .18，這條 1px 的細線會整條消失；
        // 疊上去之後同樣的壓淡下還看得到，而且模型的材質完全沒動。
        // ⚠️ 每一層都要**自己一份 geometry** —— Line2 把 lineDistances 算進 geometry 裡，
        //    共用的話後建的那層會把前一層的虛線節奏蓋掉。
        ROUTE_BOOST.forEach((b, bi) => {
          const bg = new LineGeometry();
          bg.setPositions(pos);
          const bm = new LineMaterial({
            color: lineColor, linewidth: b.width, dashed: true,
            dashSize: 0.7, gapSize: 0.45,                        // 跟細線同一組虛線節奏
            transparent: true, opacity: b.opacity,
            depthWrite: false,
            blending: b.add ? THREE.AdditiveBlending : THREE.NormalBlending,
          });
          this._lineMats.push(bm);
          const boost = new Line2(bg, bm);
          boost.computeLineDistances();
          boost.renderOrder = PLAN_LAYER.boost + bi;             // 也要在 veil 後面；粗的先、細的疊上去
          boost.visible = false;
          rg.add(boost);
          (set.boost ??= []).push(boost);
        });
      }
      const start = this._makeDot(pts[0].toArray(), 0xff3b2a, { big: true });        // 起點大紅點
      rg.add(start.group);
      set.startDots.push(phase
        ? { ...start, stops: [new THREE.Color(css('--m-edge', '#74d4ff')), new THREE.Color(css('--amber', '#ffb42e')), new THREE.Color('#ff3b2a')] }
        : { ...start });
      const end = this._makeDot(pts[pts.length - 1].toArray(), 0x3dffa0);            // 終點綠點
      rg.add(end.group);
      (set.endDots ??= []).push(end);
      this.fires.push({ halo: end.halo, light: end.light });                         // 綠終點：柔和脈動
      if (!glow) {                                  // 前言／結語頁那一組（第一頁共用，但標記平常藏著）
        for (const m of this._makeRouteMarks(pts, lineColor)) { rg.add(m); (set.marks ??= []).push(m); }
      }
      // 每個轉折點的累積長度，用來把「跑了幾成」換算成座標
      const cum = [0];
      for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + pts[i].distanceTo(pts[i - 1]));
      set.entries.push({ line, fat: glow, pts, cum, total: cum[cum.length - 1] || 1, tip: pts[0].clone() });
      rg.visible = false;
      g.add(rg);
      set.groups.push(rg);
    }
    if (mode === 'manual') {
      // 跑動線時停在線頭上的亮點（整組共用一顆，跟著目前那條走）
      const runner = this._makeRunner();
      runner.group.visible = false;
      g.add(runner.group);
      set.runner = runner;
    }
    set.root = g;                                 // 待機起火點之後要掛在這底下
    set.gate = this.clock.getElapsedTime() + 1;   // 載入後第一秒先不出現（避開載入卡頓弄亂第一條）
    set.t0 = set.gate;                            // 第一條從第 1 秒開始、完整一格
    // 跟倒數連動的那一組：倒數早就開跑了（模型是後來才載完的），把格子對齊到時段的起點，
    // 這樣時段邊界一定落在格子的邊界上，不會有一條被切一半
    if (phase && this._phaseT0 != null) set.t0 = this._phaseT0;
    set.off = !!this._routesOff?.[name];          // 建好之前就被叫去收起來的話，這裡補上
    if (this._routeBoost?.[name]) this._applyBoost(set, true);
    if (this._routeSlot?.[name]) this.setRouteSlot(name, this._routeSlot[name]);   // 建好之前就被指定過節拍
    this._routeSets[name] = set;
    this._syncLineRes();                          // 粗線建好就把畫布尺寸餵進去
    this.onRoutesReady?.(name);                   // 模型是非同步載入的，外面要等這一聲才拿得到起點
    return g;
  }

  /** 把一條動線畫到 k（0~1）的位置。
      whole=true ＝整條路都畫出來（線不隨進度長），只有線頭那顆亮點照 k 前進。
      不管哪一種，e.tip 都會算出來，呼叫端拿它擺線頭。

      ⚠️ **粗線（Line2）的段數從頭到尾固定不變**，還沒跑到的段全部收合到線頭上（長度 0 = 看不見）。
      **絕對不要用 setPositions 改段數** —— three 的 WebGLBindingStates 只在
      「第一次繪製這份 geometry」時決定 _maxInstanceCount，之後段數變多也不會跟著長。
      按下按鈕時線只有 1 段，就會被鎖在 1，整條動線永遠只畫得出第一段（實際踩過，見 HANDOFF 0.23）。 */
  _drawRouteAt(e, k, whole = false) {
    const target = Math.max(0, Math.min(1, k)) * e.total;
    let i = 1;
    while (i < e.cum.length - 1 && e.cum[i] < target) i++;     // target 落在 pts[i-1] → pts[i] 這一段
    const seg = e.cum[i] - e.cum[i - 1] || 1;
    const f = Math.max(0, Math.min(1, (target - e.cum[i - 1]) / seg));
    e.tip.lerpVectors(e.pts[i - 1], e.pts[i], f);
    const n = e.pts.length;
    // 第 j 個點畫在哪：已經跑過的照抄，還沒跑到的全部收到線頭上
    const at = whole ? (j) => e.pts[j] : (j) => (j < i ? e.pts[j] : e.tip);
    if (e.fat) {
      const st = e.line.geometry.attributes.instanceStart;
      const en = e.line.geometry.attributes.instanceEnd;
      for (let j = 0; j < n - 1; j++) {
        const a = at(j), b = at(j + 1);
        st.setXYZ(j, a.x, a.y, a.z);
        en.setXYZ(j, b.x, b.y, b.z);
      }
      st.data.needsUpdate = true;      // 兩個 attribute 共用同一份 interleaved buffer，標記一次就好
      e.line.computeLineDistances();   // 虛線間距要跟著重算（核心和光暈共用 geometry）
      return;
    }
    const attr = e.line.geometry.getAttribute('position');
    for (let j = 0; j < n; j++) { const p = at(j); attr.setXYZ(j, p.x, p.y, p.z); }
    attr.needsUpdate = true;
    e.line.geometry.setDrawRange(0, whole ? n : i + 1);        // 細線有 drawRange 可以直接切
    e.line.computeLineDistances();
  }

  /** 這一組有幾條逃生動線 */
  routeCount(name) { return this._routeSets?.[name]?.groups.length ?? 0; }

  /** 第 i 條動線的**起點投影到畫布上的位置**，回 {x, y}（0~1，左上角是 0,0）；
      還沒載入就回 null。前言頁的紅點用它把 CSS 畫的那顆擺到真的起火點上。
      ⚠️ 起點存的是動線群組的區域座標，**要先 localToWorld** 才能投影。
      ⚠️ 回的是「佔畫布寬高的幾成」，不是像素 —— 畫布尺寸變了要重算（相機的 aspect 會變）。 */
  routeStartScreen(name, i) {
    const set = this._routeSets?.[name];
    const e = set?.entries?.[i];
    if (!e) return null;
    // ⚠️ **投影前一定要自己把相機的矩陣更新好**：Vector3.project() 直接吃
    //    camera.matrixWorldInverse / projectionMatrix，而那兩支是 renderer.render() 才會更新的。
    //    這支通常是「剛切到這一頁、還沒畫過一幀」就被呼叫，用到的會是上一個視角的舊矩陣，
    //    算出來的位置會整個飛掉（實測 y 跑到 222%）。
    const el = this.renderer.domElement;
    if (el.clientWidth > 0 && el.clientHeight > 0) {
      const asp = el.clientWidth / el.clientHeight;
      if (Math.abs(this.camera.aspect - asp) > 1e-4) { this.camera.aspect = asp; this.camera.updateProjectionMatrix(); }
    }
    this.camera.updateMatrixWorld();
    this.camera.matrixWorldInverse.copy(this.camera.matrixWorld).invert();
    set.root.updateWorldMatrix(true, false);
    set.root.localToWorld(_v8.copy(e.pts[0]));
    _v8.project(this.camera);
    return { x: (_v8.x + 1) / 2, y: (1 - _v8.y) / 2 };
  }

  /** 每一條動線的折線總長度（模型單位），用來換算「走完要幾秒」 */
  routeLengths(name) { return (this._routeSets?.[name]?.entries ?? []).map((e) => e.total); }

  /** 某個狀態的鏡頭總移動量（沒有兩個以上關鍵影格就回 0）。秒數就是照這個換算的 */
  camCost(name) {
    const keys = this.shotKeys(name);
    return keys && keys.length >= 2 ? this._camPath(keys).total : 0;
  }

  /**
   * 播一條逃生動線：從紅色起點沿折線畫到綠色出口，duration 秒跑完後呼叫 onDone（只叫一次）。
   * index 沒給就隨機挑一條（avoidCurrent = 避開剛剛那一條）。回傳挑到的索引；沒有動線資料回 -1。
   */
  playRoute(name, {
    index = null, avoidCurrent = true, avoid = -1, duration = 2, onDone = null,
    whole = false,          // true = 整條路一開始就畫出來，只有線頭那顆亮點在跑
    shot = null, shotBlend = 0.8,
    camHold = 0.5,          // 鏡頭在每個關鍵影格停幾秒（0 = 不停，一路滑過去）
  } = {}) {
    const set = this._routeSets?.[name];
    if (!set?.groups.length) return -1;
    let i = index;
    if (i == null) {
      // avoid = 呼叫端指定要避開的那一條（首頁的「切換」用：避開待機正在冒煙／剛剛跑過的那一條）；
      // avoidCurrent = 避開這一組上一次播的那一條。兩個都排除之後沒得挑就逐步放寬。
      const all = set.groups.map((_, k) => k);
      let pool = all.filter((k) => k !== avoid && !(avoidCurrent && k === set.cur));
      if (!pool.length) pool = all.filter((k) => k !== avoid);
      if (!pool.length) pool = all;                             // 只有一條時照樣播那一條
      i = pool[Math.floor(Math.random() * pool.length)];
    }
    i = Math.max(0, Math.min(set.groups.length - 1, i));
    set.cur = i;
    set.recent = [i, ...set.recent].slice(0, 2);
    set.groups.forEach((rg, k) => { rg.visible = k === i; });
    const e = set.entries[i];
    this._drawRouteAt(e, 0, whole);
    if (set.runner) { set.runner.group.position.copy(e.tip); set.runner.group.visible = true; }

    // 這一條動線自己的運鏡（七個狀態共用 enterState 那套規則）
    const shotName = typeof shot === 'function' ? shot(i) : shot;
    const keys = shotName && this.enterState(shotName, shotBlend) === 'keys' ? this.shotKeys(shotName) : null;
    const cam = keys ? this._camPath(keys) : null;      // 鏡頭總移動量，拿來換算秒數與分配時間
    if (!shotName && this._override) this.releaseShot(shotBlend);

    // duration 可以給函式：拿得到這條的長度和鏡頭移動量，自己決定要跑幾秒
    const dur = typeof duration === 'function'
      ? duration(i, e.total, set.entries.map((x) => x.total), cam?.total ?? 0)
      : duration;
    set.play = { i, t0: this.clock.getElapsedTime(), dur: Math.max(0.1, dur), onDone, done: false, whole };
    if (keys) {
      set.play.keys = keys;
      set.play.cam = cam;
      if (cam?.total > 0) set.play.sch = this._camSchedule(cam, set.play.dur, camHold);
      set.play.blend = Math.max(0, shotBlend);   // 開頭這幾秒從原本的鏡頭接進來（0 = 直接切）
      set.play.from = { pos: this.camera.position.toArray(), target: this.controls.target.toArray() };
    }
    return i;
  }

  /* ---------- 待機時的起火點：紅色閃點 + 紅色煙霧（不畫路徑） ----------
     在**離鏡頭最近的幾條**動線的**起點**裡挑一個當起火位置，每一拍換一個（節拍跟著擺盪走）；
     下一顆會在舊的熄掉前 IDLE_FIRE.overlap 秒就先冒出來，所以交接時**兩處同時在燒**。
     為了並存，起火點是**兩格輪流用**（fire.slots）。路徑本身不顯示，等按了按鈕才跑。 */

  /** 顯示待機起火點。index 沒給就從離鏡頭最近的幾條裡隨機挑；回傳挑到的索引，沒有動線資料回 -1 */
  showIdleFire(name, { index = null } = {}) {
    const set = this._routeSets?.[name];
    if (!set?.entries.length) return -1;
    const auto = index == null;
    const beat0 = this._swingBeat(this.clock.getElapsedTime());
    const i = auto ? this._pickFireStart(set, -1, beat0?.info.pick ?? null)
      : Math.max(0, Math.min(set.entries.length - 1, index));
    if (!set.fire) set.fire = { slots: [this._makeFireSlot(set), this._makeFireSlot(set)], cur: 0, i: -1, on: false, auto: true, next: 0 };
    const t = this.clock.getElapsedTime();
    const f = set.fire;
    for (const s of f.slots) { s.group.visible = false; s.until = 0; }   // 重來一次，兩格都先清掉
    f.cur = 0;
    const s0 = f.slots[0];
    s0.i = i;
    s0.group.position.copy(set.entries[i].pts[0]);
    s0.group.visible = true;
    s0.t0 = t;                        // 煙霧從這一刻重新起算
    s0.until = Infinity;              // 什麼時候收，等下一顆冒出來才決定
    f.i = i;                          // 「最新的那一顆」標在哪一條（idleFireRoute 用）
    f.on = true;                      // 待機起火點整體開著
    f.auto = auto;                    // auto = 到時間就在離鏡頭最近的那幾條裡重挑
    f.next = t + IDLE_FIRE.every;     // 沒在擺盪時的退路
    f.beat = beat0?.id ?? null;       // 目前踩在哪一拍（進場這一拍不再補發起火點）
    const info = beat0?.info ?? SWING_BEATS[0];
    f.info = info;
    for (const s of f.slots) { s.dot.core.material.opacity = 1; }   // 上一輪可能停在淡出中
    this._setSlabGreen(!!beat0 && info.green);
    this.onIdleFire?.(i);             // 第一顆也算「新的起火點」
    // 進場先發一次 beat（first=true）：外面拿去把標語點亮，但按鈕不抽
    this.onSwingBeat?.({ ...info, dur: beat0?.dur ?? IDLE_FIRE.every, first: true });
    return i;
  }

  /** 挑一條動線的起點當起火位置，回傳索引。
      pick = 指定可以用哪幾條（0 起算的索引陣列，見 SWING_BEATS）；沒給就退回
      「離鏡頭最近的 IDLE_FIRE.pool 條裡隨機」。
      cur 有給就把它排除掉（可選的只剩它自己時還是回它 —— 例如點 2 只綁一條）。 */
  _pickFireStart(set, cur = -1, pick = null) {
    const n = set.entries.length;
    if (!n) return -1;
    let pool;
    if (pick?.length) {
      pool = pick.filter((i) => i >= 0 && i < n);
      if (!pool.length) pool = [...Array(n).keys()];         // 指定的都超出範圍就全部都能挑
    } else {
      const near = [];
      for (let i = 0; i < n; i++) {
        set.root.localToWorld(_v8.copy(set.entries[i].pts[0]));
        near.push({ i, d: this.camera.position.distanceToSquared(_v8) });
      }
      near.sort((a, b) => a.d - b.d);
      pool = near.slice(0, Math.min(IDLE_FIRE.pool, n)).map((e) => e.i);
    }
    if (cur >= 0 && pool.length > 1) pool = pool.filter((i) => i !== cur);
    return pool[Math.floor(Math.random() * pool.length)];
  }

  hideIdleFire(name) {
    // 離開待機，樓梯一定要變回白色。**不要只呼叫 _setSlabGreen(false)** ——
    // 它有「狀態沒變就不做事」的早退，而材質是被每幀的 _updateStairGreen 直接寫進去的，
    // 兩者一旦不同步就會留下一座綠樓梯。這裡直接強制重畫。
    this._slabGreen = false;
    this._applyModelLook();
    const f = this._routeSets?.[name]?.fire;
    if (!f) return;
    f.on = false;
    f.beat = null;
    f.info = null;
    for (const s of f.slots) { s.group.visible = false; s.until = 0; s.dot.core.material.opacity = 1; }
  }

  /** 現在踩在時間軸的哪一拍。沒在擺盪回 null。
      id   一路往上加的編號（拿來判斷「換拍了沒」）
      info SWING_BEATS 裡那一筆
      dur  這一拍到下一拍有多久（秒）—— 時間上不等距，標語的漸強要照這個長度
      back 回程走到幾成（0~1，正程時是 0）—— 淡出和綠樓梯都用它 */
  _swingBeat(t) {
    const w = Math.abs(this.controls.autoRotateSpeed) * 0.9;
    if (!this.swing?.on || !(w > 1e-4)) return null;
    const TAU = 2 * Math.PI;
    const th = (t - (this.swing.t0 ?? 0)) * w;
    const cyc = Math.floor(th / TAU);
    const r = th - cyc * TAU;
    let i = 0;
    for (let k = SWING_BEATS.length - 1; k >= 0; k--) if (r >= SWING_BEATS[k].th) { i = k; break; }
    const next = i + 1 < SWING_BEATS.length ? SWING_BEATS[i + 1].th : TAU;
    return {
      id: cyc * SWING_BEATS.length + i,
      info: SWING_BEATS[i],
      dur: (next - SWING_BEATS[i].th) / w,
      back: r >= Math.PI ? (r - Math.PI) / Math.PI : 0,
    };
  }

/** 擺盪時間軸那 6 拍**各**多長（秒），照 SWING_BEATS 的順序。
      給「沒在擺盪的狀態」（通關的綠色介面）拿去複製同一組節奏用 ——
      速度取**這個場景存檔的擺盪速度**，不是當下的鏡頭速度（綠色介面是在自轉，速度不一樣）。 */
  swingBeatSeconds(name = this.sceneName) {
    const sp = Math.abs(this.getSavedView(name)?.speed ?? this.controls.autoRotateSpeed);
    const w = sp * 0.9;                                   // 和 _swingBeat 同一條換算
    if (!(w > 1e-4)) return SWING_BEATS.map(() => IDLE_FIRE.every);
    const TAU = 2 * Math.PI;
    return SWING_BEATS.map((b, i) => {
      const next = i + 1 < SWING_BEATS.length ? SWING_BEATS[i + 1].th : TAU;
      return (next - b.th) / w;
    });
  }

  /** 這一拍多長（秒）。標語的漸強用它，所以漸強會跟著這一段的實際長度走。
      沒在擺盪就回 IDLE_FIRE.every */
  idleFirePeriod() {
    return this._swingBeat(this.clock.getElapsedTime())?.dur ?? IDLE_FIRE.every;
  }

  /** 換一顆新的起火點。回傳挑到的動線索引。
      keepPrev=false ＝**舊的立刻收掉**，不要陪跑 —— 回程淡出的那一顆已經淡到看不見了，
      讓它陪跑的話，新的一拍把淡出係數重設成 1，它會整顆「復活」0.25 秒才消失。 */
  _spawnIdleFire(set, t, pick = null, keepPrev = true) {
    const fire = set.fire;
    const prev = fire.slots[fire.cur];
    if (keepPrev) prev.until = t + IDLE_FIRE.overlap;   // 舊的還要陪跑這麼久
    else { prev.group.visible = false; prev.until = 0; }
    fire.cur = 1 - fire.cur;
    const s = fire.slots[fire.cur];
    const n = this._pickFireStart(set, prev.i, pick);   // 避開還在燒的那一條
    s.i = n;
    fire.i = n;
    s.group.position.copy(set.entries[n].pts[0]);
    s.group.visible = true;
    s.t0 = t;                                    // 煙霧重新起算，不要一亮就是一柱冒好的煙
    s.until = Infinity;                          // 等下一顆冒出來才決定什麼時候收
    this.onIdleFire?.(n);
    return n;
  }

  /** 整座樓梯（連框線）顯示／隱藏 */
  _setStairVisible(on) {
    for (const o of this._stairMeshes ?? []) o.visible = !!on;
  }

  /** 綠色樓梯的發光、「碰到點閃一下」和「消失前閃三下」。
      q = 回程走到幾成（0~1，0 = 剛到點 4，1 = 回到點 1），每幀呼叫。
      閃的時候是**硬跳**（綠 ↔ 回到平常的白），不做內插 —— 跟按鈕的雜訊抽動同一個路數，
      柔和地淡進淡出就變成呼吸燈，不是壞掉的訊號了。 */
  _updateStairGreen(q) {
    const m = this._blueprintMats;
    if (!m?.stair) return;
    const { glow, swell, blip, blinkAt, blinks, duty, dim } = STAIR_GREEN;
    // 外溢強度 b：0 = 乾淨，1 = 糊到最開。一次抖動就是「快速衝出去、慢慢收回來」。
    const pulse = (u) => (u < 0.32 ? u / 0.32 : Math.max(0, 1 - (u - 0.32) / 0.68));
    let b = 0;
    // 這一下是第幾抖（只有末段的連抖要編號）。號碼一變就發一次 onStairBlink，
    // 「展示逃生動線」按鈕靠它跟樓梯同步 —— 所以按鈕在快回到點 1 的時候，
    // 抽動的頻率會完全等於樓梯連抖的頻率。
    let blinkId = null;
    if (q >= blinkAt) {
      // 消失前的連抖（blinks 次）
      const u = (q - blinkAt) / Math.max(1e-4, 1 - blinkAt);
      const c = Math.min(blinks - 1e-6, u * blinks);
      const f = c - Math.floor(c);
      const d = duty[Math.floor(c) % duty.length];
      if (f < d) { b = pulse(f / d); blinkId = Math.floor(c) * 2; }
      else if (f > 0.82 && f < 0.92) {                                     // 收尾再抖一小下
        b = 0.55 * pulse((f - 0.82) / 0.1);
        blinkId = Math.floor(c) * 2 + 1;
      }
    } else {
      // 碰到點（4 / 3 / 2）就抖一下
      for (const q0 of STAIR_BLIPS) {
        if (q >= q0 && q < q0 + blip) { b = pulse((q - q0) / blip); break; }
      }
    }
    if (blinkId !== this._stairBlinkId) {
      this._stairBlinkId = blinkId;
      if (blinkId !== null) this.onStairBlink?.();
    }
    this._setStairVisible(true);
    this._setStairSmear(b);
    const green = css('--exit', '#3dffa0');
    const up = Math.min(1, q / Math.max(1e-4, swell));          // 前 swell 那段把光推上去
    m.stair.color.set(0x000000);                                // diffuse 壓黑：畫面上只剩自發光，不會被打光洗白
    m.stair.emissive.set(green);
    // 外溢的時候本體淡掉一點，看起來才像「訊號散開」而不是「多了幾個影子」
    m.stair.emissiveIntensity = glow * (0.35 + 0.65 * up) * (1 - dim * b);
  }

  /** 樓梯轉綠 —— 點 4 那一段用。實際上色在 _applyModelLook()（只動 stair 材質，樓板不變） */
  _setSlabGreen(on) {
    if (!on) this._stairBlinkId = null;             // 下一輪回程重新從第一抖算起
    if (this._slabGreen === !!on) return;
    this._slabGreen = !!on;
    this._applyModelLook();
  }

  /** 待機起火點現在標在哪一條動線上（沒開回 -1）。回的是**最新的那一顆**——
      交接的那一秒有兩處在燒，按下按鈕要跑新的那一條。看的是 on 不是 visible。 */
  idleFireRoute(name) {
    const f = this._routeSets?.[name]?.fire;
    return f?.on ? f.i : -1;
  }

  /** 一格起火點（紅點 + 一團煙）。兩格輪流用，交接時才能兩處同時燒 */
  _makeFireSlot(set) {
    const g = new THREE.Group();
    const dot = this._makeDot([0, 0, 0], 0xff3b2a, { big: true });   // 起火點：大紅點
    g.add(dot.group);
    const smoke = this._makeSmoke();
    for (const p of smoke.parts) g.add(p.sprite);
    g.visible = false;
    set.root.add(g);
    return { group: g, dot, smoke, i: -1, t0: 0, until: 0 };
  }

  /** 紅色煙霧（卡通版）：一顆一顆的雲朵，**啵一下彈出來**、邊飄邊轉、最後才淡掉。
     顆數少一點、每顆大一點，才有一團一團的卡通感，不是一片糊糊的霧。 */
  _makeSmoke({ count = 9, rise = 7, spread = 2.2, life = 2.6, opacity = 0.92 } = {}) {
    const color = new THREE.Color(css('--red', '#ff4a3d'));
    const parts = [];
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: smokeTexture(), color, transparent: true, opacity: 0,
        depthWrite: false, depthTest: true,
      }));
      sprite.scale.setScalar(1);
      parts.push({
        sprite,
        phase: i / count + Math.random() * 0.02,      // 錯開，才會一顆接一顆冒出來
        dx: Math.cos(a) * (0.3 + Math.random() * 0.7),
        dz: Math.sin(a) * (0.3 + Math.random() * 0.7),
        size: 1.5 + Math.random() * 1.1,
        spin: (Math.random() < 0.5 ? -1 : 1) * (0.5 + Math.random() * 0.8),
        wob: Math.random() * Math.PI * 2,
      });
    }
    return { parts, rise, spread, life, opacity };
  }

  _updateSmoke(sm, t, fade = 1) {
    for (const p of sm.parts) {
      const age = ((t / sm.life) + p.phase) % 1;
      const s = p.sprite;
      s.position.set(
        p.dx * sm.spread * age + Math.sin(t * 0.9 + p.wob) * 0.3 * age,
        sm.rise * age,
        p.dz * sm.spread * age + Math.cos(t * 0.7 + p.wob) * 0.3 * age
      );
      // 大小：**下小上大**。底下剛冒出來的小、越往上越大，
      // 另外前 12% 用回彈曲線「啵」一下彈出來
      const grow = 0.32 + age * 1.9;
      const pop = age < 0.12
        ? (() => { const x = age / 0.12 - 1; return 1 + x * x * x + 1.7 * x * x * (x + 1); })()
        : 1;
      s.scale.setScalar(p.size * grow * Math.max(0.05, pop));
      s.material.rotation = p.spin * age * 1.4;          // 邊飄邊轉
      // 透明度：**下紅上透**。底下濃、越飄越淡，到頂就沒了（開頭很短的淡入避免硬跳出來）
      s.material.opacity = sm.opacity * Math.min(1, age / 0.06) * Math.pow(1 - age, 0.75) * fade;
    }
  }

  /** 收掉這一組動線（通關之後路線消失） */
  stopRoute(name) {
    const set = this._routeSets?.[name];
    if (!set) return;
    set.play = null;
    set.groups.forEach((rg) => { rg.visible = false; });
    if (set.runner) set.runner.group.visible = false;
  }

  /** 在一組路線集裡隨機顯示一條（避開最近兩條），其餘隱藏 */
  /** 自動輪播換下一條（第一頁）。**用洗牌袋，不是每次亂數挑**：
      把所有動線洗成一輪、一條一條發完再洗下一輪，而且下一輪的第一條不會等於上一輪的最後一條。

      這樣有兩個保證：
        1. **永遠不會連兩次同一條**
        2. **每 n 條就一定把每條都跑過一次** —— 純亂數做不到這件事，
           就算避開最近兩條，一個 10 秒時段（5 格）裡照樣可能出現 `0 1 4 3 1` 這種
           同一條跑兩次、另一條完全沒出現的情況。 */
  _pickRouteInSet(set) {
    const n = set.groups.length;
    if (!n) return;
    if (!set.bag?.length) set.bag = this._shuffledBag(n, set.cur);
    const i = set.bag.pop();
    set.cur = i;
    set.groups.forEach((rg, k) => { rg.visible = k === i; });
  }

  /** 0…n-1 洗成一袋（Fisher–Yates）。
      ⚠️ 取的時候是 pop()，所以**陣列最後一個才是下一條** —— 要避開的是它，不是第 0 個。 */
  _shuffledBag(n, avoidNext = -1) {
    const a = [...Array(n).keys()];
    for (let k = n - 1; k > 0; k--) {
      const j = Math.floor(Math.random() * (k + 1));
      [a[k], a[j]] = [a[j], a[k]];
    }
    if (n > 1 && a[n - 1] === avoidNext) [a[n - 1], a[0]] = [a[0], a[n - 1]];
    return a;
  }

  /** 圓點：回傳 {group, core, halo, light}，由呼叫端決定要掛到哪個動畫清單；big=true 加大 */
  _makeDot([x, y, z], color, { big = false } = {}) {
    const g = new THREE.Group();
    g.position.set(x, y, z);
    const coreR = big ? 0.6 : 0.35;
    const haloR = big ? 0.8 : 0.9;
    const core = new THREE.Mesh(
      new THREE.SphereGeometry(coreR, 20, 14),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1 })
    );
    g.add(core);
    const halo = new THREE.Mesh(
      new THREE.SphereGeometry(haloR, 20, 14),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.2, depthWrite: false })
    );
    g.add(halo);
    const light = new THREE.PointLight(color, 14, big ? 14 : 10, 2);
    g.add(light);
    return { group: g, core, halo, light };
  }

  /** 線頭上「正在逃生的人」：白色的逃生標誌小人。
      用 Sprite 而不是平面 —— 鏡頭在動線上會轉來轉去，平面轉到側面就變成一條線了。 */
  _makeRunner() {
    const g = new THREE.Group();
    // 光暈先畫（相加混色、不寫深度），本體再蓋上去
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: runnerGlowTexture(), color: 0xffffff,
      transparent: true, opacity: RUNNER.glowOp, depthWrite: false,
      blending: THREE.AdditiveBlending,        // depthTest 保持預設（吃深度）—— 本體被樓板擋住時，光暈要一起被擋，不然會看到一團沒有人的光
    }));
    glow.scale.setScalar(RUNNER.size * RUNNER.glow);   // 貼圖裡本體縮了 1/glow，這裡放大回來剛好對齊
    glow.renderOrder = 3;
    g.add(glow);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: runnerTexture(), color: 0xffffff,
      transparent: true, depthWrite: false,      // 不寫深度，才不會把後面的動線切掉
    }));
    sprite.scale.setScalar(RUNNER.size);
    sprite.renderOrder = 4;
    g.add(sprite);
    const light = new THREE.PointLight(0xffffff, RUNNER.light, 12, 2);
    g.add(light);
    return { group: g, sprite, glow, light };
  }

  /** 主題（<html data-theme>）換掉之後重新套用場景配色 */
  applyTheme() {
    this.scene.fog.color.set(css('--m-fog', '#031020'));
    this._tintLights();
    if (this._blueprintMats || this._flatMats) this._tintBlueprint();   // 真實模型也跟著換色
    if (!this.placeholder) return;          // 已載入外部模型就不動它
    this.modelRoot.remove(this.placeholder);
    disposeTree(this.placeholder);
    this.placeholder = null;
    this.scenes = null;
    this._addPlaceholder();                 // 材質顏色在建立時就從 CSS 讀，重建即完成換色
  }

  /* ---------- 掛載 / 卸載 ---------- */
  mount(el) {
    if (this._host === el) return;
    this.unmount();
    this._host = el;
    el.appendChild(this.renderer.domElement);
    this._ro.observe(el);
    this.resize();
    this.start();
  }

  unmount() {
    this.stop();
    if (this._host) {
      this._ro.unobserve(this._host);
      if (this.renderer.domElement.parentNode === this._host) {
        this._host.removeChild(this.renderer.domElement);
      }
      this._host = null;
    }
  }

  resize() {
    if (!this._host) return;
    const { clientWidth: w, clientHeight: h } = this._host;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
    this._syncLineRes();
  }

  /** 粗線的寬度是「幾個螢幕像素」，所以材質要知道畫布多大；換視窗大小一定要重設，不然粗細會跑掉 */
  _syncLineRes() {
    if (!this._lineMats?.length) return;
    this.renderer.getSize(_r2);
    for (const m of this._lineMats) m.resolution.copy(_r2);
  }

  start() {
    if (this._raf) return;
    const loop = () => {
      this._raf = requestAnimationFrame(loop);
      const t = this.clock.getElapsedTime();
      const p = 0.75 + Math.sin(t * 4.2) * 0.25;
      for (const f of this.fires ?? []) {
        f.halo.scale.setScalar(p);
        f.halo.material.opacity = 0.1 + p * 0.12;
        f.light.intensity = 18 + p * 14;
      }
      for (const r of this.routes ?? []) r.material.dashOffset = -t * 1.6;
      // 逃生動線（第一頁 flat / 首頁 tower 各一組，獨立輪播；起點圓點閃爍）
      const phase = Math.max(0, Math.min(2, this._routePhase ?? 0));
      const bk = 0.5 + 0.5 * Math.sin(t * Math.PI * 2);   // 一秒閃一次
      for (const set of Object.values(this._routeSets ?? {})) {
        if (set.mode === 'manual') {                      // 首頁：只有按鈕按下去才播，播完停在出口等外面收掉
          const p = set.play;
          if (p) {
            const tau = Math.min(1, (t - p.t0) / p.dur);
            const e = set.entries[p.i];
            // 動線上的點：**照時間等速**跑完整條，不受鏡頭影響
            const k = tau;
            // 鏡頭：在每個關鍵影格停一下再滑到下一個（跑完就交給通關那組鏡頭，不要再搶）
            if (p.keys && !p.done) {
              if (p.cam?.total > 0 && p.sch) {
                this._applyCamAt(p.cam, this._camUAtTime(p.cam, p.sch, t - p.t0));
              } else {
                this._lerpView(...this._keyPair(p.keys, k));
              }
              const bk = p.blend > 0 ? Math.min(1, (t - p.t0) / p.blend) : 1;
              if (bk < 1) {
                // 開頭：從按下按鈕當下的鏡頭，平順接到動線的運鏡上（blend=0 就是直接切）
                const onPath = { pos: this.camera.position.toArray(), target: this.controls.target.toArray() };
                this._lerpView(p.from, onPath, bk * bk * (3 - 2 * bk));
              }
            }
            this._drawRouteAt(e, k, p.whole);
            if (set.runner) set.runner.group.position.copy(e.tip);
            if (tau >= 1 && !p.done) { p.done = true; const cb = p.onDone; p.onDone = null; cb?.(); }
          }
        } else if (set.off) {                             // 前言頁：整組收起來（setRoutesVisible）
          if (set.slot !== -1) { set.slot = -1; set.groups.forEach((gr) => { gr.visible = false; }); }
        } else if (t < set.gate) {                        // 載入後第一秒：全部隱藏
          if (set.slot !== -1) { set.slot = -1; set.groups.forEach((gr) => { gr.visible = false; }); }
        } else {                                          // 之後每 slotSec 秒換一條
          const slotSec = set.slotSec ?? ROUTE_SLOT;
          const slot = Math.floor((t - set.t0) / slotSec);
          // 跟倒數連動的那一組：**這個時段剩下的時間不夠跑完整一格就不要換了**，
          // 讓上一條多留一下就好 —— 五條變四條沒關係，有一條閃過去才難看。
          // ⚠️ 只有「時段還在跑」的時候才限制。倒數停在別的頁面時 _phaseEnd 會留在過去的時間，
          //    不判斷 live 的話結語頁（也用 flat）的動線會**整組停住不換**。
          const live = this._phaseEnd != null && t < this._phaseEnd;
          const fits = !set.phase || !live || t + slotSec <= this._phaseEnd + 1e-3;
          if (slot !== set.slot && fits) { set.slot = slot; this._pickRouteInSet(set); }
        }
        const fire = set.fire;                          // 待機起火點：紅點閃 + 煙霧飄
        if (fire?.on) {
          if (fire.auto) {
            const beat = this._swingBeat(t);
            fire.back = beat?.back ?? 0;
            if (beat) {
              // 踩到時間軸的下一個點了
              if (beat.id !== fire.beat) {
                const wasFading = !!fire.info?.green;  // 上一拍在回程＝那顆已經淡掉了
                fire.beat = beat.id;
                fire.info = beat.info;
                this._setSlabGreen(beat.info.green);   // 點 4 起樓梯轉綠，一路綠到回點 1
                // 只有正程的點 1/2/3 換新的起火點（各自綁定的動線），點 4 之後整個回程都維持那一顆
                if (beat.info.pick) this._spawnIdleFire(set, t, beat.info.pick, !wasFading);
                this.onSwingBeat?.({ ...beat.info, dur: beat.dur, first: false });
              }
            } else if (t > fire.next) {
              // 沒在擺盪：退回固定秒數，只換起火點
              this._spawnIdleFire(set, t);
              fire.next = t + IDLE_FIRE.every;
            }
          }
          // 整個回程（點 4 → 點 1）那顆起火點慢慢淡掉，到點 1 剛好不見，然後新的一顆冒出來
          const q = fire.back ?? 0;
          const fk = fire.info?.green ? Math.max(0, 1 - q) : 1;
          if (fire.info?.green) this._updateStairGreen(q);   // 綠樓梯：發光 + 碰到點閃一下 + 消失前閃三下
          for (const s of fire.slots) {
            if (!s.group.visible) continue;
            if (t > s.until) { s.group.visible = false; continue; }   // 陪跑結束
            s.dot.core.scale.setScalar(0.85 + 0.35 * bk);
            s.dot.core.material.opacity = fk;
            s.dot.halo.scale.setScalar(1.1 + 0.9 * bk);
            s.dot.halo.material.opacity = (0.12 + 0.4 * bk) * fk;
            s.dot.light.intensity = (6 + 30 * bk) * fk;
            this._updateSmoke(s.smoke, t - s.t0, fk);
          }
        }
        for (const b of set.startDots) {                  // 起點閃爍（第一頁跟倒數變色，首頁固定紅）
          if (b.stops) {
            const c = b.stops[phase];
            b.core.material.color.copy(c); b.halo.material.color.copy(c); b.light.color.copy(c);
          }
          const haloBase = (b.stops && phase >= 2) ? 1.3 : 0.7;   // 第一頁紅色階段光暈放大
          const lightMax = (b.stops && phase >= 2) ? 34 : 26;
          b.core.scale.setScalar(0.85 + 0.35 * bk);
          b.halo.scale.setScalar(haloBase + 0.9 * bk);
          b.halo.material.opacity = 0.1 + 0.4 * bk;
          b.light.intensity = 4 + lightMax * bk;
        }
      }
      if (this._fly) {
        // 飛往／飛離某個分鏡：smoothstep，起步和收尾都放慢
        const f = this._fly;
        const raw = Math.min(1, (t - f.t0) / f.dur);
        this._lerpView(f.from, f.to, raw * raw * (3 - 2 * raw));
        if (raw >= 1) { this._fly = null; f.onEnd?.(); }
      } else if (this.swing.on && !this._motionPaused && !this._hold) {
        const w = Math.abs(this.controls.autoRotateSpeed) * 0.9;   // 快慢沿用自動旋轉速度那支
        if (this.swing.a && this.swing.b) {
          // 鎖定兩端：0→1→0 的餘弦，剛好在 A、B 兩端各停一下再折回來
          const k = (1 - Math.cos((t - this.swing.t0) * w)) / 2;
          this._lerpView(this.swing.a, this.swing.b, k, this.swing.dir);
        } else {
          // 沒鎖定：在 center ± amp 之間用正弦來回擺動
          const off = this.camera.position.clone().sub(this.controls.target);
          const sph = new THREE.Spherical().setFromVector3(off);
          sph.theta = this.swing.center + this.swing.amp * Math.sin((t - this.swing.t0) * w);
          this.camera.position.copy(this.controls.target).add(off.setFromSpherical(sph));
        }
      }
      if (this._pivotHelper?.visible) {
        const tg = this.controls.target;
        this._pivotHelper.position.set(tg.x, 0, tg.z);   // 軸心輔助線跟著 target 走
      }
      // 暫停／飛鏡頭／停在分鏡上的期間先把自動旋轉關掉再 update，才不會被轉走；狀態本身不動
      const spin = this.controls.autoRotate;
      if (this._motionPaused || this._hold || this._fly) this.controls.autoRotate = false;
      this.controls.update();
      this.controls.autoRotate = spin;
      this.renderer.render(this.scene, this.camera);
    };
    loop();
  }

  stop() {
    cancelAnimationFrame(this._raf);
    this._raf = 0;
  }

  /* ---------- 載入外部模型 ---------- */
  _loader() {
    if (this._gltf) return this._gltf;
    const draco = new DRACOLoader().setDecoderPath(DRACO_PATH);
    this._gltf = new GLTFLoader().setDRACOLoader(draco);
    return this._gltf;
  }

  /**
   * @param {string} url  .glb / .gltf 網址或 blob URL
   * @param {(pct:number)=>void} [onProgress]
   */
  loadModel(url, onProgress) {
    return new Promise((resolve, reject) => {
      this._loader().load(
        url,
        (gltf) => {
          this.clearModel();
          this.modelRoot.add(gltf.scene);
          this.frameObject(gltf.scene);
          resolve(gltf);
        },
        (e) => onProgress?.(e.total ? (e.loaded / e.total) * 100 : 0),
        reject
      );
    });
  }

  clearModel() {
    if (this.placeholder) {
      this.modelRoot.remove(this.placeholder);
      disposeTree(this.placeholder);
      this.placeholder = null;
      this.scenes = null;
      this.fires = [];
      this.routes = [];
      this._lineMats = [];
      this._stairMeshes = null;   // 換模型就重新認樓梯、重新做殘影
      this._stairGhosts = null;
      this._stairBase = null;
    }
    for (const child of [...this.modelRoot.children]) {
      this.modelRoot.remove(child);
      disposeTree(child);
    }
  }

  /** 依模型尺寸算出一組「框好」的視角描述（不直接動相機，給 setScene 當底用）。
     用外接球 + 取水平/垂直較窄的視角當限制 —— 球體轉到任何角度大小都一樣，
     所以模型不管怎麼旋轉都塞得進畫面，不會「轉一轉就轉出視窗外」。 */
  _frameView(obj) {
    const box = new THREE.Box3().setFromObject(obj);
    if (box.isEmpty()) return null;
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const center = sphere.center;
    const R = sphere.radius || 1;
    const vfov = (this.camera.fov * Math.PI) / 180;
    const aspect = this.camera.aspect || 1;
    const hfov = 2 * Math.atan(aspect * Math.tan(vfov / 2));
    const limit = Math.min(vfov, hfov);                 // 較窄的那個方向才是真正的限制
    const dist = (R / Math.sin(limit / 2)) * 1.4;       // 外接球 + 留白
    const pos = center.clone().add(new THREE.Vector3(0.62, 0.66, 0.82).normalize().multiplyScalar(dist));
    return {
      pos: pos.toArray(),
      target: center.toArray(),                          // 軸心 = 外接球中心
      min: dist * 0.2, max: dist * 4,
      near: dist / 100, far: dist * 12,
      fog: [dist * 1.0, dist * 3.6],
      speed: 0.45, swing: false, swingAmp: 40,
    };
  }

  /** 依模型尺寸自動調整相機距離（整份取代場景時用） */
  frameObject(obj) {
    const v = this._frameView(obj);
    if (v) this._applyView(v);
  }
}

function disposeTree(root) {
  root.traverse?.((o) => {
    o.geometry?.dispose?.();
    const m = o.material;
    if (Array.isArray(m)) m.forEach((x) => x.dispose?.());
    else m?.dispose?.();
  });
}
