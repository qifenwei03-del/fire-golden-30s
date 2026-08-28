import { Viewer } from './viewer.js';
import { createCountdown } from './countdown.js';
import { createEditor } from './editor.js';
import { createGuideStore } from './guides.js';

/* =========================================================
   頁面路由
   ENTER → 首頁 / ESC → 第一頁
   （原本按 0 / 1 的綠色、紅色空白頁已經拿掉）
   ========================================================= */
const PAGES = ['first', 'home'];

/* 首頁逃生動線示範的節奏常數（editors 也用得到，所以放最上面） */
/* 動線的節奏：**動線上的點照路徑長度等速跑**（秒數 = 長度 ÷ ROUTE_SPEED）。
   鏡頭不跟著點跑，而是「在每個關鍵影格停 CAM_HOLD 秒、中間再滑過去」，
   所以鏡頭和點不會完全對齊 —— 這是刻意的。 */
const ROUTE_SPEED = 6.4;                    // 點每秒走幾個模型單位（越小走越慢）
const CAM_HOLD = 0.25;                      // 鏡頭在每個關鍵影格停幾秒（0 = 不停，一路滑過去）
const ROUTE_SECONDS = [3, 12];              // 每條的秒數上下限
const ROUTE_RUN = 5;                        // 量不到長度時的後備秒數
const SHOT_FLY = 0;                         // 狀態切換不用鏡頭飛過去銜接（改用黑幕），0 = 直接就定位
/* 通關（綠）預設的運鏡：自己慢慢轉。編輯模式把「通關（綠）」存過之後就以存的為準 */
const GREEN_MOTION = { autoRotate: true, speed: 0.3, swing: false };

/* 歡迎流程：開機停在「火災黃金30秒」，倒數跑完一輪自動進首頁。
   只會自動跳這一次，之後手動切頁就不再干涉。 */
const WELCOME_FROM = 'first';
const WELCOME_TO = 'home';
let welcomeDone = false;
const pageEls = new Map(
  PAGES.map((id) => [id, document.querySelector(`.page[data-page="${id}"]`)])
);

const stage = document.getElementById('stage-first');
const homeStage = document.getElementById('stage-home');
const viewer = new Viewer();
const countdown = createCountdown({
  ticksEl: document.getElementById('ring-ticks'),
  headEl: document.getElementById('ring-head'),
  numEl: document.getElementById('count-num'),
  phaseEls: [...document.querySelectorAll('#phases .phase')],
  stageEl: document.querySelector('.timer'),
  duration: 30,
  onPhase: (idx) => {
    viewer.setRoutePhase(idx);                   // 逃生起點圓點顏色跟著倒數時段（藍→黃→紅）
    const first = pageEls.get('first');          // 第一頁標題「30」與「每一秒都很關鍵」也跟著時段換色
    if (first) { if (idx < 0) delete first.dataset.stage; else first.dataset.stage = String(idx); }
  },
  onEnd: () => {
    // 編輯版面時不要把人踢走
    if (welcomeDone || current !== WELCOME_FROM || editors[current]?.isEditing()) return;
    welcomeDone = true;
    goto(WELCOME_TO);
  },
});

/* 參考線是跨頁共用的一份，每一頁都看得到全部的線（顏色依拉出來的那一頁區分） */
const guideStore = createGuideStore({
  url: './layout-guides.json',
  storageKey: 'fire30.guides',
});

/* 每一頁一個編輯器實例，物件版面各自存檔，參考線共用 */
const editors = {
  first: createEditor({
    root: document.querySelector('.page--main'),
    pageId: 'first',
    guideStore,
    viewer,
    sceneName: 'flat',
    storageKey: 'fire30.layout',
    layoutUrl: './layout.json',
  }),
  home: createEditor({
    root: document.querySelector('.page--home'),
    pageId: 'home',
    guideStore,
    viewer,
    sceneName: 'tower',
    // 首頁的三個狀態各有自己的視角與運鏡，用工具列的「狀態」下拉切換要編輯哪一個：
    //   待機（藍）＝沒在跑動線時；動線1~5（紅）＝跑該條動線時，用時間軸排運鏡；通關（綠）＝抵達出口後
    shotKeys: [
      ['idle', '待機（藍）'],
      ['route1', '動線1'], ['route2', '動線2'], ['route3', '動線3'],
      ['route4', '動線4'], ['route5', '動線5'],
      ['clear', '通關（綠）'],
    ],
    shotSeconds: (i) => routeSeconds(viewer.routeLengths('tower')[i]),
    // 編輯器切到哪個狀態，畫面就跟著變成那個狀態的配色與外觀（不然會在藍色底下調綠色的構圖）
    onState: (k) => {
      const route = /^route\d+$/.test(k);
      viewer.setAllWhite(k === 'clear');
      // 待機才有起火點（紅點 + 煙），編動線或通關時收掉，畫面才跟實際跑起來一樣
      if (k === 'idle') viewer.showIdleFire('tower');
      else viewer.hideIdleFire('tower');
      setTheme(k === 'clear' ? 'green' : route ? 'red' : baseTheme);
    },
    storageKey: 'fire30.layout.home',
    layoutUrl: './layout-home.json',
  }),
};
const closeEditors = (except) => {
  for (const [id, ed] of Object.entries(editors)) if (id !== except) ed.toggle(false);
};

const params = new URLSearchParams(location.search);
let current = null;

function goto(id) {
  if (!pageEls.has(id) || id === current) return;
  current = id;
  for (const [key, el] of pageEls) el.classList.toggle('is-active', key === id);

  closeEditors(id);                // 換頁就關掉其他頁的編輯模式
  if (id !== 'home') resetRouteDemo();   // 離開首頁：收掉動線、關掉通關訊息、主色回原本的
  if (id === 'home') showIdleFire();     // 進首頁：待機的起火點
  if (id === 'first') countdown.start();
  else countdown.pause();

  // 同一顆 renderer 搬到當前頁的 3D 容器，其餘頁面就卸下來
  // 兩頁的佔位模型不同：第一頁是單層平面圖，首頁是三層大樓
  const host = { first: stage, home: homeStage }[id];
  if (host) {
    viewer.setScene(id === 'home' ? 'tower' : 'flat');
    viewer.mount(host);
  } else {
    viewer.unmount();
  }
}

addEventListener('keydown', (e) => {
  if (e.repeat) return;

  // 正在輸入欄位裡打字時不要切頁（工具列有數字輸入框），Esc 只負責離開欄位
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
    if (e.code === 'Escape') { e.target.blur(); e.preventDefault(); }
    return;
  }

  switch (e.code) {
    // 手動切過頁就取消自動進首頁，避免之後按 Esc 回來又被跳走
    case 'Enter': case 'NumpadEnter': welcomeDone = true; goto('home'); break;
    case 'Escape':                    welcomeDone = true; goto('first'); break;
    case 'KeyR':                      if (current === 'first') countdown.reset(); break;
    case 'KeyE':                      editors[current]?.toggle(); break;
    default: return;
  }
  e.preventDefault();
});

/* =========================================================
   首頁的逃生動線示範（取代原本的住戶登入面板）
   ---------------------------------------------------------
   按「展示逃生動線」或「切換逃生動線」都是同一套流程：
     介面轉紅 → 隨機挑一條動線，點**等速**從紅色起點畫到綠色出口（秒數 = 路徑長度 ÷ ROUTE_SPEED）
       （設過運鏡的話，鏡頭會在每個關鍵影格停一下再滑到下一個，不強求和點對齊）
     → 抵達出口：3D 黑一下 → 介面轉綠、整棟變白、鏡頭就定位、路線收掉、跳出「恭喜通關」
   再按任何一顆就換一條重跑（避開剛剛那條）；離開首頁會回到原本的藍色。
   ========================================================= */
const routeClear = document.getElementById('route-clear');
const routeBtns = [document.getElementById('route-play'), document.getElementById('route-next')];
let routeState = 'idle';                    // idle | running | cleared

const showClear = (on) => routeClear?.classList.toggle('is-on', on);

/* 黑幕：切狀態時先黑掉，趁看不見把鏡頭放到定位、配色換好，再亮起來。
   FADE_OUT 要和 css `.blackout` 的 transition 對得上。 */
const FADE_OUT = 220, FADE_HOLD = 60;
const blackoutEl = document.getElementById('blackout');
let fadeTimer = 0;

function blackout(swap) {
  clearTimeout(fadeTimer);
  if (!blackoutEl) { swap(); return; }
  blackoutEl.classList.add('is-on');
  fadeTimer = setTimeout(() => {
    swap();                                    // 這時候畫面全黑，換什麼都看不到
    fadeTimer = setTimeout(() => blackoutEl.classList.remove('is-on'), FADE_HOLD);
  }, FADE_OUT);
}

/** 這一條動線要跑幾秒＝路徑長度 ÷ 速度（夾在上下限之間），這樣點才會等速 */
function routeSeconds(len) {
  const s = len > 0 ? len / ROUTE_SPEED : ROUTE_RUN;
  return Math.min(ROUTE_SECONDS[1], Math.max(ROUTE_SECONDS[0], s));
}

/** 待機（藍）時在隨機一條動線的起點放紅色閃點 + 紅色煙霧（不畫路徑）。
    每次回到待機都重抽一條，按下按鈕就跑那一條 —— 看到哪裡起火就從哪裡逃。 */
function showIdleFire() {
  if (routeState !== 'idle' || current !== 'home') return;
  viewer.showIdleFire('tower');
}

function playRouteDemo() {
  // 模型還沒載完就還沒有動線資料，直接不理會（別讓介面先變紅又變回來）
  if (!viewer.routeCount('tower')) {
    console.warn('[route] 首頁的逃生動線還沒載入完，稍等一下再按');
    return;
  }
  const fromIdle = routeState === 'idle' ? viewer.idleFireRoute('tower') : -1;
  blackout(() => {
    showClear(false);
    viewer.hideIdleFire('tower');           // 開始跑就把待機的起火點收掉
    viewer.setAllWhite(false);                // 回到玻璃牆
    setTheme('red');                          // 跑動線的這幾秒：整個介面轉紅
    routeState = 'running';
    viewer.playRoute('tower', {
      duration: (i, len) => routeSeconds(len),  // 點等速：秒數只看路徑長度
      index: fromIdle >= 0 ? fromIdle : null,   // 從待機按下去＝跑「正在冒煙」那一條
      avoidCurrent: true,                     // 每次換一條（只有一條動線時就重播那條）
      shot: (i) => `route${i + 1}`,           // 這條動線的運鏡（編輯模式的時間軸上設的）
      shotBlend: SHOT_FLY,
      camHold: CAM_HOLD,                      // 鏡頭在每個關鍵影格停一下再轉
      onDone: () => {
        routeState = 'cleared';
        blackout(() => {                      // 動線 → 通關：黑掉再換，不要用鏡頭轉過去銜接
          viewer.stopRoute('tower');          // 抵達出口 → 路線消失
          viewer.setAllWhite(true);           // 整棟建物變白
          // 通關（綠）：照這個狀態存的鏡頭／運鏡走；沒設過就用 GREEN_MOTION（原地慢慢轉）
          viewer.enterState('clear', SHOT_FLY, { defaultMotion: GREEN_MOTION });
          setTheme('green');                  // 介面轉綠
          showClear(true);                    // 恭喜通關
        });
      },
    });
  });
}

/** 回到還沒開始的狀態（離開首頁時） */
function resetRouteDemo() {
  if (routeState === 'idle') return;
  routeState = 'idle';
  viewer.stopRoute('tower');
  viewer.setAllWhite(false);                // 建物變回玻璃牆
  viewer.releaseShot(SHOT_FLY);             // 鏡頭飛回原本的視角，擺動接手
  showClear(false);
  setTheme(baseTheme);
  showIdleFire();                           // 重抽一個起火點
}

for (const btn of routeBtns) btn?.addEventListener('click', playRouteDemo);

/* 點擊圓盤重新倒數 */
document.querySelector('.timer__ring')?.addEventListener('click', () => countdown.reset());

/* =========================================================
   模型載入：?model=<url> 或把 .glb / .gltf 拖進舞台
   ========================================================= */
const hintEl = document.getElementById('stage-hint');
const loadingEl = document.getElementById('stage-loading');
const progressEl = document.getElementById('stage-progress');

function setLoading(on, pct = 0) {
  loadingEl.hidden = !on;
  hintEl.style.opacity = on ? '0' : '';
  if (on) progressEl.textContent = `${Math.round(pct)}%`;
}

async function load(url, revoke) {
  setLoading(true);
  try {
    await viewer.loadModel(url, (pct) => setLoading(true, pct));
    hintEl.style.opacity = '0';
  } catch (err) {
    console.error('[viewer] 模型載入失敗', err);
    hintEl.textContent = '模型載入失敗，請確認檔案格式（.glb / .gltf）';
    hintEl.style.opacity = '';
  } finally {
    setLoading(false);
    if (revoke) URL.revokeObjectURL(url);
  }
}

const modelParam = new URLSearchParams(location.search).get('model');
if (modelParam) load(modelParam);

['dragenter', 'dragover'].forEach((t) =>
  stage.addEventListener(t, (e) => { e.preventDefault(); stage.classList.add('is-drop'); })
);
['dragleave', 'drop'].forEach((t) =>
  stage.addEventListener(t, () => stage.classList.remove('is-drop'))
);
stage.addEventListener('drop', (e) => {
  e.preventDefault();
  const file = [...(e.dataTransfer?.files ?? [])].find((f) => /\.(glb|gltf)$/i.test(f.name));
  if (file) load(URL.createObjectURL(file), true);
});

/* 首頁的真實建築模型（BIM 匯出，離線壓縮成透視感牆面 + 白色樓板的 .glb）：
   只換首頁的三層佔位大樓，第一頁的平面圖不動。載入失敗就退回佔位大樓。?home-model=off 可跳過。 */
const homeLoadingEl = document.getElementById('home-loading');
const homeProgressEl = document.getElementById('home-progress');

if (params.get('home-model') !== 'off') {
  if (homeLoadingEl) homeLoadingEl.hidden = false;
  viewer
    .loadHomeModel('./models/tower.glb', (pct) => {
      if (homeProgressEl) homeProgressEl.textContent = `${Math.round(pct)}%`;
    })
    .then(() => { if (homeLoadingEl) homeLoadingEl.hidden = true; showIdleFire(); })
    .catch((err) => {
      console.error('[viewer] 首頁模型載入失敗，退回佔位大樓', err);
      if (homeLoadingEl) homeLoadingEl.hidden = true;
    });
}

/* 第一頁的單層真實模型：套用「佔位模型那套」簡單材質（實心深色牆 + 每個轉角都有線）。
   載入失敗退回佔位平面圖。?flat-model=off 可跳過。 */
if (params.get('flat-model') !== 'off') {
  setLoading(true);
  viewer
    .loadFlatModel('./models/flat.glb', (pct) => setLoading(true, pct))
    .then(() => { setLoading(false); hintEl.style.opacity = '0'; })
    .catch((err) => {
      console.error('[viewer] 第一頁模型載入失敗，退回佔位平面圖', err);
      setLoading(false);
    });
}

/* =========================================================
   主色調：blue（預設）/ green / red，3D 場景會跟著同一組 CSS 變數
   ?theme=green 可直接指定，否則沿用上次選擇
   baseTheme = 使用者選的那一個；首頁跑動線時會暫時切成 red / green，離開首頁再切回來
   ========================================================= */
function setTheme(name) {
  document.documentElement.dataset.theme = name;
  viewer.applyTheme();
  return name;
}
let baseTheme = setTheme(params.get('theme') ?? localStorage.getItem('theme') ?? 'blue');

/* 啟動（?page=home|green|red 可指定進入哪一頁，方便截圖／測試） */
const startPage = params.get('page');
goto(PAGES.includes(startPage) ? startPage : 'first');

/* 套用上次編輯過的版面（等字體載完、版面穩定後再量，位置才準；?layout=off 可跳過） */
// 用 setTimeout 而不是 rAF：分頁在背景時 rAF 不會觸發，會把整條啟動鏈卡住
// 蓋著的深藍畫面撤掉。不管載入成不成功都要跑到，所以另外設一道保險
const booted = () => document.documentElement.classList.remove('is-booting');
const bootFallback = setTimeout(booted, 4000);

document.fonts.ready.then(() => new Promise((r) => setTimeout(r, 60))).then(async () => {
  try {
    if (params.get('layout') !== 'off') {
      await guideStore.load();
      await Promise.all(Object.values(editors).map((ed) => ed.restore()));
    }
    // ?edit=1 直接進編輯模式；?edit=<物件代號> 再順便選取該物件
    const edit = params.get('edit');
    const ed = editors[current];
    if (edit && ed) {
      ed.toggle(true);
      if (edit !== '1') ed.select(edit);
    }
  } finally {
    clearTimeout(bootFallback);
    booted();
  }
});

/* 方便在 console 直接操作：__viewer.loadModel('./models/x.glb') */
Object.assign(window, {
  __viewer: viewer,
  __countdown: countdown,
  __goto: goto,
  __editors: editors,
  __editor: editors.first,
  __setTheme: (n) => { localStorage.setItem('theme', n); baseTheme = n; return setTheme(n); },
});
