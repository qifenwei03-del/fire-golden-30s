import { Viewer } from './viewer.js';
import { createCountdown } from './countdown.js';
import { createEditor } from './editor.js';
import { createGuideStore } from './guides.js';

/* =========================================================
   頁面路由
   ENTER → 首頁 / 0 → 綠色介面 / 1 → 紅色介面 / ESC → 第一頁
   ========================================================= */
const PAGES = ['first', 'home', 'green', 'red'];

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

  // 正在輸入欄位裡打字時不要切頁（不然打 0 或 1 就跳走了），Esc 只負責離開欄位
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
    if (e.code === 'Escape') { e.target.blur(); e.preventDefault(); }
    return;
  }

  switch (e.code) {
    // 手動切過頁就取消自動進首頁，避免之後按 Esc 回來又被跳走
    case 'Enter': case 'NumpadEnter': welcomeDone = true; goto('home'); break;
    case 'Digit0': case 'Numpad0':    welcomeDone = true; goto('green'); break;
    case 'Digit1': case 'Numpad1':    welcomeDone = true; goto('red'); break;
    case 'Escape':                    welcomeDone = true; goto('first'); break;
    case 'KeyR':                      if (current === 'first') countdown.reset(); break;
    case 'KeyE':                      editors[current]?.toggle(); break;
    default: return;
  }
  e.preventDefault();
});

/* =========================================================
   首頁的住戶登入（目前只做輸入與問候，沒有真的驗證）
   ========================================================= */
const loginForm = document.getElementById('login-form');
const loginName = document.getElementById('login-name');
const loginLead = document.getElementById('login-lead');
const loginSubmit = document.getElementById('login-submit');
let loggedIn = false;

const setLead = (...nodes) => { loginLead.replaceChildren(...nodes); };
const br = () => document.createElement('br');

function resetLogin() {
  loggedIn = false;
  loginForm.classList.remove('is-empty');
  loginName.value = '';
  loginName.hidden = false;
  loginSubmit.textContent = '登入';
  setLead('歡迎使用雲端宅邸管理系統', br(), '請輸入住戶名稱進行登入');
}

loginForm.addEventListener('submit', (e) => {
  e.preventDefault();
  if (loggedIn) { resetLogin(); loginName.focus(); return; }

  const name = loginName.value.trim();
  if (!name) {
    loginForm.classList.remove('is-empty');
    void loginForm.offsetWidth;            // 重新觸發抖動動畫
    loginForm.classList.add('is-empty');
    loginName.focus();
    return;
  }

  loggedIn = true;
  loginForm.classList.remove('is-empty');
  loginName.hidden = true;
  loginSubmit.textContent = '重新輸入';
  // 用節點組字串，名稱不經過 innerHTML
  setLead('歡迎回來，', Object.assign(document.createElement('b'), { textContent: name }),
    br(), '已進入雲端宅邸管理系統');
});

loginName.addEventListener('input', () => loginForm.classList.remove('is-empty'));

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

/* =========================================================
   主色調：blue（預設）/ green，3D 場景會跟著同一組 CSS 變數
   ?theme=green 可直接指定，否則沿用上次選擇
   ========================================================= */
function setTheme(name) {
  document.documentElement.dataset.theme = name;
  viewer.applyTheme();
  return name;
}
setTheme(params.get('theme') ?? localStorage.getItem('theme') ?? 'blue');

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
  __setTheme: (n) => { localStorage.setItem('theme', n); return setTheme(n); },
});
