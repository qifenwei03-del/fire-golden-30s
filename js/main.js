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
const ROUTE_SPEED = 6.4 / 1.5;              // 點每秒走幾個模型單位（越小走越慢）。原本 6.4，整體放慢成 1.5 倍時間
const CAM_HOLD = 0.25;                      // 鏡頭在每個關鍵影格停幾秒（0 = 不停，一路滑過去）
const ROUTE_SECONDS = [3, 12];              // 每條的秒數上下限
const ROUTE_RUN = 5;                        // 量不到長度時的後備秒數
const SHOT_FLY = 0;                         // 狀態切換不用鏡頭飛過去銜接（改用黑幕），0 = 直接就定位
const EXIT_HOLD = 500;                      // 小人跑到出口之後停幾毫秒才切通關（讓人看清楚他到了）
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

/* 倒數：總長和分幾段。第一頁的逃生動線輪播要知道「一段有多長」，
   才能判斷這一段還放不放得下完整的一條（見 viewer.setRoutePhase）。 */
const COUNT_SECONDS = 30;
const countPhaseEls = [...document.querySelectorAll('#phases .phase')];
const PHASE_SECONDS = COUNT_SECONDS / Math.max(1, countPhaseEls.length);

const stage = document.getElementById('stage-first');
const homeStage = document.getElementById('stage-home');
const viewer = new Viewer();
const countdown = createCountdown({
  ticksEl: document.getElementById('ring-ticks'),
  headEl: document.getElementById('ring-head'),
  numEl: document.getElementById('count-num'),
  phaseEls: countPhaseEls,
  stageEl: document.querySelector('.timer'),
  duration: COUNT_SECONDS,
  onPhase: (idx) => {
    // 第二個參數是「這一段有多長」，動線輪播用它決定還放不放得下完整的一條
    viewer.setRoutePhase(idx, PHASE_SECONDS);    // 逃生起點圓點顏色跟著倒數時段（藍→黃→紅）
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
      setFireTag(k === 'clear');            // 編輯模式切到通關，狀態面板也要跟著變
      // 編動線＝紅色介面（照那條動線標 A／B），通關＝兩個都暢通，其餘回預設
      setExitTags(route ? Number(k.slice(5)) - 1 : -1, k === 'clear');
      // 待機才有起火點（紅點 + 煙），編動線或通關時收掉，畫面才跟實際跑起來一樣
      if (k === 'idle') { startIdleFx(); viewer.showIdleFire('tower'); }   // 先重設再觸發，第一個詞才會亮
      else { viewer.hideIdleFire('tower'); stopIdleFx(); }
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
  if (id !== 'home') { resetRouteDemo(); stopIdleFx(); }    // 離開首頁：收掉動線、關掉通關訊息、主色回原本的
  if (id === 'home') { startIdleFx(); showIdleFire(); }     // 進首頁：待機的起火點 + 標語換色 + 按鈕抽動
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
    // B = 回到藍色介面：不在首頁就先進首頁，已經在首頁就把紅／綠收掉回到待機
    case 'KeyB':                      welcomeDone = true;
                                      if (current !== 'home') goto('home'); else resetRouteDemo();
                                      break;
    case 'KeyR':                      if (current === 'first') countdown.reset(); break;
    case 'KeyE':                      editors[current]?.toggle(); break;
    default: return;
  }
  e.preventDefault();
});

/* =========================================================
   首頁的逃生動線示範（取代原本的住戶登入面板）
   ---------------------------------------------------------
   兩顆按鈕跑的流程一樣，差別只在**挑哪一條**：
     展示逃生動線 → **重複「目前這一條」**（待機時＝正在冒煙的那一條；通關後＝剛剛跑過的那一條）
     切換逃生動線 → **隨機挑別條**，避開「目前這一條」
   流程本身：
     介面轉紅 → 點**等速**從紅色起點畫到綠色出口（秒數 = 路徑長度 ÷ ROUTE_SPEED）
       （設過運鏡的話，鏡頭會在每個關鍵影格停一下再滑到下一個，不強求和點對齊）
     → 抵達出口：3D 黑一下 → 介面轉綠、整棟變白、鏡頭就定位、路線收掉、跳出「恭喜通關」
   離開首頁會回到原本的藍色。
   ========================================================= */
const routeClear = document.getElementById('route-clear');
/* 右上狀態面板「火源位置」那一列：待機／跑動線時是紅色的「已辨識」，
   通關之後換成綠色的「已遠離火源」。其他三列不動。 */
let exitTimer = null;                       // 「站在出口停一下」的計時器（見 EXIT_HOLD）
const fireTag = document.getElementById('status-fire');
const FIRE_TAG = { on: ['已辨識', 'is-alert'], clear: ['已遠離火源', 'is-ok'] };
function setFireTag(cleared) {
  if (!fireTag) return;
  const [text, cls] = cleared ? FIRE_TAG.clear : FIRE_TAG.on;
  fireTag.textContent = text;
  fireTag.classList.toggle('is-ok', cls === 'is-ok');
  fireTag.classList.toggle('is-alert', cls === 'is-alert');
}
/* 「A出口」「B出口」那兩列：**跑動線 1／2／3 的時候翻成「A 暢通、B 壅塞」**
   （那三條走的是 A 出口，面板要指向該往哪邊跑）；動線 4／5 和待機都維持
   index.html 裡的預設「A 壅塞、B 暢通」。**通關（綠）兩個都翻成暢通**（人已經出來了，
   綠色介面上不留紅字），回到待機（藍）才重設 —— 見 setExitTags 的呼叫點。 */
const exitTags = [document.getElementById('status-exit-a'), document.getElementById('status-exit-b')];
const EXIT_TAG = { ok: ['暢通', 'is-ok'], jam: ['壅塞', 'is-alert'] };
const EXIT_A_ROUTES = [0, 1, 2];            // 0 起算，也就是動線 1／2／3
function setExitTags(route = -1, cleared = false) {
  const viaA = EXIT_A_ROUTES.includes(route);
  const pair = cleared ? [EXIT_TAG.ok, EXIT_TAG.ok]                   // 通關：兩個都暢通
    : viaA ? [EXIT_TAG.ok, EXIT_TAG.jam] : [EXIT_TAG.jam, EXIT_TAG.ok];
  exitTags.forEach((el, i) => {
    if (!el) return;
    const [text, cls] = pair[i];
    el.textContent = text;
    el.classList.toggle('is-ok', cls === 'is-ok');
    el.classList.toggle('is-alert', cls === 'is-alert');
  });
}

const routePlayBtn = document.getElementById('route-play');   // 展示：重複目前這一條
const routeNextBtn = document.getElementById('route-next');   // 切換：隨機挑別條

/* 「展示逃生動線」的雜訊抽動：**不是固定週期的循環，而是每次起火點換位置就抽一次**。
   viewer 換完新的起火點會呼叫 onIdleFire，這裡再把 .is-glitch 掛上去跑一次 one-shot 動畫。 */
/* 擺盪時間軸走到一個點（1/2/3）就會進來一次。
     word  = 標語要亮第幾個字（反轉那一段沿用點 3 的字，所以綠字會撐到轉回點 1）
     fwd   = 是不是正轉那三個點
     first = 剛進待機的那一次（按鈕不抽，但標語要亮） */
viewer.onSwingBeat = ({ word, first }) => {
  syncTaglineStep();
  if (!first) glitchPlayBtn();     // 正轉反轉都抽，只有進場那一次不抽
  showTaglineWord(word - 1);
};

/* 回程末段樓梯連抖的時候，「展示逃生動線」跟著抖 —— **頻率完全照樓梯**
   （樓梯抖一下就發一次 onStairBlink，每一抖的收尾小抖也算）。
   這一條走 glitchBtn 而不是 glitchPlayBtn：不吃 skipGlitch 也不用等頁面淡入，
   都走到回程末段了，頁面早就看得見。 */
viewer.onStairBlink = () => {
  if (current !== 'home' || routeState !== 'idle') return;
  glitchBtn(routePlayBtn);
};

/* .page 的淡入是 .42s（css/style.css 的 .page transition），這裡要跟它對得上 */
const PAGE_FADE = 420;
let glitchWait = null;
let skipGlitch = false;      // 剛進待機的第一拍不抽（一進場就閃太吵），第二拍才開始

/** 讓一顆按鈕抽一次（0.5 秒的 one-shot）。顏色不用給 ——
    動畫吃的 --gl 就是 --brand-hi，主題轉綠它自己就變綠。
    ⚠️ 先移除 class、強制重排再加回去，同一個 class 直接再 add 是不會重播動畫的。 */
function glitchBtn(el) {
  if (!el) return;
  el.classList.remove('is-glitch');
  void el.offsetWidth;
  el.classList.add('is-glitch');
}

function glitchPlayBtn(force = false) {
  if (!routePlayBtn || current !== 'home' || routeState !== 'idle') return;
  clearTimeout(glitchWait);
  if (skipGlitch) { skipGlitch = false; return; }   // 進場的那一顆起火點只放火、不抽按鈕
  // ⚠️ 剛切進首頁的那一下，整頁還在淡入（opacity 0），這時候抽動根本看不到 ——
  //    所以第一次要等頁面現身再抽。只延後一次（force），不要用「等到看得見為止」的迴圈：
  //    有些情況（預覽窗格不合成、prefers-reduced-motion）opacity 永遠讀不到 1，會無限重試。
  const page = pageEls.get('home');
  if (!force && page && parseFloat(getComputedStyle(page).opacity) < 0.9) {
    glitchWait = setTimeout(() => glitchPlayBtn(true), PAGE_FADE);
    return;
  }
  glitchBtn(routePlayBtn);
}

/* 通關（綠）之後換「切換逃生動線」抽 —— **節奏照抄待機那條擺盪時間軸**
   （viewer.swingBeatSeconds 回的就是那 6 拍各多長：長短長長短長，不是等距的），
   顏色換成 --exit。綠色介面的鏡頭在自轉、沒有 onSwingBeat 可以掛，所以這裡自己走計時器。
   **進場那一拍不抽**（先等一拍再開始），跟藍色的 skipGlitch 一致。 */
let greenTimer = null;

function startGreenFx() {
  stopGreenFx();
  if (!routeNextBtn) return;
  const durs = viewer.swingBeatSeconds('tower');
  let step = 0;
  const tick = () => {
    if (current !== 'home' || routeState !== 'cleared') return stopGreenFx();
    glitchBtn(routeNextBtn);
    greenTimer = setTimeout(tick, durs[++step % durs.length] * 1000);
  };
  greenTimer = setTimeout(tick, durs[0] * 1000);
}

function stopGreenFx() {
  clearTimeout(greenTimer);
  greenTimer = null;
  routeNextBtn?.classList.remove('is-glitch');
}

// 抽完就把 class 拿掉，下一次才能再觸發。routeBlink 掛在 ::after 上，事件照樣冒泡到按鈕。
for (const btn of [routePlayBtn, routeNextBtn]) {
  btn?.addEventListener('animationend', (e) => {
    if (e.animationName === 'routeBlink') btn.classList.remove('is-glitch');
  });
}
let routeState = 'idle';                    // idle | running | cleared
let lastRoute = -1;                         // 上一次跑的是哪一條（通關之後「展示」要重複的就是它）

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

/* 待機（藍）時的動態效果，統一由 startIdleFx / stopIdleFx 開關：
     1. 右上標語三個詞依序亮起（點1 紅 → 點2 黃 → 點3 綠，反轉維持綠到轉回點 1）
     2. 「展示逃生動線」按鈕的雜訊抽動（正轉反轉經過 1/2/3 都抽）
   **都掛在「擺盪的時間軸」上**（viewer.onSwingBeat），不是各自的計時器 ——
   所以畫面上四件事（鏡頭擺到哪、起火點、標語換色、按鈕抽動）是同一個節拍。
   亮起的那個詞會在**這一顆起火點的壽命內**把飽和度從 --lit 慢慢拉滿（CSS 的 taglineRamp）。
   **只有待機會跑** —— 跑動線（紅）和通關（綠）都停掉，維持原本的樣子。 */
const taglineEl = document.querySelector('.home__tagline');
const taglineWords = [...document.querySelectorAll('.home__tagline b')];
let taglineAt = -1;

// 漸強的長度＝起火點多久換一次。節拍是跟著擺盪算的、速度可能被編輯模式改掉，
// 所以每一拍都重讀一次（見 onIdleFire）。
const syncTaglineStep = () => taglineEl?.style.setProperty('--tag-step', `${viewer.idleFirePeriod().toFixed(2)}s`);
syncTaglineStep();

const paintTagline = (i) => taglineWords.forEach((w, k) => w.classList.toggle('is-on', k === i));

/** 指定亮第幾個詞（由擺盪時間軸驅動）。
    **同一個字不要重畫** —— 反轉那一段還是點 3 的字，重畫會把飽和度的漸強打回原點。 */
function showTaglineWord(i) {
  if (current !== 'home' || routeState !== 'idle' || !taglineWords.length) return;
  if (i === taglineAt) return;
  taglineAt = i;
  paintTagline(i);
}

function startIdleFx() {
  if (current !== 'home') return;
  pageEls.get('home')?.classList.add('is-idle');
  taglineAt = -1;              // 下一顆起火點出現時就從第一個詞開始
  skipGlitch = true;           // 但按鈕的抽動要等到第二顆才開始（標語照樣亮）
}

function stopIdleFx() {
  pageEls.get('home')?.classList.remove('is-idle');
  clearTimeout(glitchWait);                        // 還在等頁面淡入就切走了，那一次不要補抽
  routePlayBtn?.classList.remove('is-glitch');     // 抽到一半切走就直接收掉
  taglineAt = -1;
  paintTagline(-1);                         // -1 = 都不亮，三個詞回到藍色
}

/** repeat=true（展示）：重複「目前這一條」；repeat=false（切換）：隨機挑別條、避開目前這一條 */
function playRouteDemo(repeat) {
  // 模型還沒載完就還沒有動線資料，直接不理會（別讓介面先變紅又變回來）
  if (!viewer.routeCount('tower')) {
    console.warn('[route] 首頁的逃生動線還沒載入完，稍等一下再按');
    return;
  }
  // 「目前這一條」：待機時＝正在冒煙的那一條（看到哪裡起火就從哪裡逃）；
  // 跑完／通關之後＝上一次跑的那一條。兩顆按鈕都以它為基準，一個重複、一個避開。
  const cur = routeState === 'idle' ? viewer.idleFireRoute('tower') : lastRoute;
  clearTimeout(exitTimer);                  // 上一輪還停在出口的話，別讓它等一下又跳通關
  blackout(() => {
    showClear(false);
    viewer.hideIdleFire('tower');           // 開始跑就把待機的起火點收掉
    stopIdleFx();                             // 待機的動態效果只在藍色介面跑，紅／綠停掉
    stopGreenFx();                            // 上一輪通關的綠色抽動也收掉
    viewer.setAllWhite(false);                // 回到玻璃牆
    setFireTag(false);                        // 回到紅色的「已辨識」
    setTheme('red');                          // 跑動線的這幾秒：整個介面轉紅
    routeState = 'running';
    lastRoute = viewer.playRoute('tower', {
      duration: (i, len) => routeSeconds(len),  // 點等速：秒數只看路徑長度
      index: (repeat && cur >= 0) ? cur : null, // 展示＝重複目前這一條；切換＝交給下面隨機挑
      avoidCurrent: !repeat,                    // 切換時避開上一次播的那一條
      avoid: repeat ? -1 : cur,                 // 切換時也避開「目前這一條」（待機正在冒煙的那條）
      shot: (i) => `route${i + 1}`,           // 這條動線的運鏡（編輯模式的時間軸上設的）
      shotBlend: SHOT_FLY,
      camHold: CAM_HOLD,                      // 鏡頭在每個關鍵影格停一下再轉
      onDone: () => {
        routeState = 'cleared';
        // 抵達出口先停 EXIT_HOLD 毫秒 —— 這段期間動線畫著、小人站在綠色出口上不動，
        // 讓人看清楚他到了，再黑掉切通關。中途按按鈕或離開首頁要把這個計時器取消掉。
        clearTimeout(exitTimer);
        exitTimer = setTimeout(() => {
          blackout(() => {                    // 動線 → 通關：黑掉再換，不要用鏡頭轉過去銜接
            viewer.stopRoute('tower');        // 抵達出口 → 路線消失
            viewer.setAllWhite(true);         // 整棟建物變白
            // 通關（綠）：照這個狀態存的鏡頭／運鏡走；沒設過就用 GREEN_MOTION（原地慢慢轉）
            viewer.enterState('clear', SHOT_FLY, { defaultMotion: GREEN_MOTION });
            setTheme('green');                // 介面轉綠
            setFireTag(true);                 // 「已辨識」→ 綠色的「已遠離火源」
            setExitTags(lastRoute, true);     // A／B 出口都變成綠色的「暢通」
            showClear(true);                  // 恭喜通關
            startGreenFx();                   // 換「切換逃生動線」抽，同樣的節奏、綠色
          });
        }, EXIT_HOLD);
      },
    });
    setExitTags(lastRoute);                   // playRoute 是同步回傳索引的，挑完就能更新面板
  });
}

/** 回到還沒開始的狀態（離開首頁時） */
function resetRouteDemo() {
  if (routeState === 'idle') return;
  routeState = 'idle';
  clearTimeout(exitTimer);                  // 離開首頁時，還沒跳的通關就不要跳了
  viewer.stopRoute('tower');
  viewer.setAllWhite(false);                // 建物變回玻璃牆
  viewer.releaseShot(SHOT_FLY);             // 鏡頭飛回原本的視角，擺動接手
  showClear(false);
  stopGreenFx();                            // 綠色介面的抽動只在通關那段跑
  setFireTag(false);
  setExitTags(-1);                          // A／B 出口回到預設的「A 壅塞、B 暢通」
  setTheme(baseTheme);
  startIdleFx();                            // 回到待機（先重設，下一行的起火點會順便帶起標語和按鈕）
  showIdleFire();                           // 重抽一個起火點
}

routePlayBtn?.addEventListener('click', () => playRouteDemo(true));    // 展示：重複
routeNextBtn?.addEventListener('click', () => playRouteDemo(false));   // 切換：換一條

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

/* 啟動：**歡迎頁一律是「火災黃金30秒」**（沒帶 ?page= 就進 first，本來就是這樣）。
   ?page= 仍然可以指定進入哪一頁（截圖／測試用），但**只在開這一次有效** ——
   套用完就把它從網址上拿掉，所以重新整理、或把網址傳給別人打開，都會回到黃金30秒，
   不會有人卡在首頁當歡迎頁。 */
const startPage = params.get('page');
goto(PAGES.includes(startPage) ? startPage : 'first');
if (params.has('page')) {
  params.delete('page');                       // 只拿掉 page，其他參數（theme / edit / layout…）留著
  const q = params.toString();
  history.replaceState(null, '', location.pathname + (q ? `?${q}` : '') + location.hash);
}

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
