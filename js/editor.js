/* =========================================================
   版面編輯器
   ---------------------------------------------------------
   ‧ 按 E 進入／離開編輯模式
   ‧ 每個 [data-obj] 都會蓋一個操作框，可拖曳移動
   ‧ 四角 = 等比縮放整個物件（文字一起放大）
     四邊 = 只改框的寬 / 高（內容重排）；按住 Alt 拖四角 = 自由改框
   ‧ 座標一律以 rem 儲存，所以改完仍會跟著視窗等比縮放
   ========================================================= */

const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/* 工具列的對齊／分布按鈕：[代號, 提示, SVG 內容] */
const ALIGN_BTNS = [
  ['left', '靠左對齊', '<rect x="1" y="1" width="1.6" height="14" rx=".6"/><rect x="4" y="3" width="10" height="3.6" rx=".8"/><rect x="4" y="9.4" width="6.5" height="3.6" rx=".8"/>'],
  ['centerX', '水平置中對齊', '<rect x="7.2" y="1" width="1.6" height="14" rx=".6"/><rect x="3" y="3" width="10" height="3.6" rx=".8"/><rect x="4.75" y="9.4" width="6.5" height="3.6" rx=".8"/>'],
  ['right', '靠右對齊', '<rect x="13.4" y="1" width="1.6" height="14" rx=".6"/><rect x="2" y="3" width="10" height="3.6" rx=".8"/><rect x="5.5" y="9.4" width="6.5" height="3.6" rx=".8"/>'],
  ['top', '靠上對齊', '<rect x="1" y="1" width="14" height="1.6" rx=".6"/><rect x="3" y="4" width="3.6" height="10" rx=".8"/><rect x="9.4" y="4" width="3.6" height="6.5" rx=".8"/>'],
  ['centerY', '垂直置中對齊', '<rect x="1" y="7.2" width="14" height="1.6" rx=".6"/><rect x="3" y="3" width="3.6" height="10" rx=".8"/><rect x="9.4" y="4.75" width="3.6" height="6.5" rx=".8"/>'],
  ['bottom', '靠下對齊', '<rect x="1" y="13.4" width="14" height="1.6" rx=".6"/><rect x="3" y="2" width="3.6" height="10" rx=".8"/><rect x="9.4" y="5.5" width="3.6" height="6.5" rx=".8"/>'],
];
const DIST_BTNS = [
  ['distX', '水平均分（左右間距相等，需選 3 個以上）', '<rect x="1" y="2" width="2.6" height="12" rx=".8"/><rect x="6.7" y="2" width="2.6" height="12" rx=".8"/><rect x="12.4" y="2" width="2.6" height="12" rx=".8"/>'],
  ['distY', '垂直均分（上下間距相等，需選 3 個以上）', '<rect x="2" y="1" width="12" height="2.6" rx=".8"/><rect x="2" y="6.7" width="12" height="2.6" rx=".8"/><rect x="2" y="12.4" width="12" height="2.6" rx=".8"/>'],
];
const PAGE_BTNS = [
  ['pageX', '整組移到畫面水平正中', '<rect x="7.2" y="0" width="1.6" height="16" rx=".6" opacity=".45"/><rect x="3.2" y="4.6" width="9.6" height="6.8" rx=".9"/>'],
  ['pageY', '整組移到畫面垂直正中', '<rect x="0" y="7.2" width="16" height="1.6" rx=".6" opacity=".45"/><rect x="4.6" y="3.2" width="6.8" height="9.6" rx=".9"/>'],
];
const SNAP = 6;      // 對齊吸附距離（px）
const MIN = 16;      // 最小框（px）
const SCALE_RANGE = [0.2, 6];

const remPx = () => parseFloat(getComputedStyle(document.documentElement).fontSize);
const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

export function createEditor({
  root,
  pageId = 'first',              // 這一頁的代號，新拉出來的參考線會記上，用來決定顏色
  guideStore,                    // 跨頁共用的參考線（js/guides.js），沒給就每頁自己一份
  viewer = null,                 // 給了就能在編輯模式裡調整並記住 3D 視角
  sceneName = 'flat',            // 這一頁用的 3D 場景代號
  storageKey = 'fire30.layout',
  layoutUrl = './layout.json',   // 開發伺服器支援 PUT／DELETE；純靜態主機會失敗，退回 localStorage
} = {}) {
  const objs = [...root.querySelectorAll('[data-obj]')];
  if (!objs.length) return null;

  /** 幾何模型，單位 rem；scale 無單位 */
  const G = new Map();      // el -> {x,y,w,h,s,hidden}
  let base = null;          // 原始版面，供「重設」使用
  let frozen = false;
  let editing = false;
  let dirty = false;        // 使用者動過版面沒？沒動過的話視窗一改變就重量

  let layer = null, bar = null, fields = null, snapLine = null, toast = null, guideBox = null;
  const boxes = new Map();  // el -> .eo-box
  const sel = new Set();
  const undoStack = [];

  // 參考線是跨頁共用的，每一頁都看得到全部的線
  const guides = guideStore ?? createLocalGuides();
  const RULER = () => remPx() * 0.9;   // 尺規寬度，和 css 的 .9rem 一致

  /* ---------------------------------------------------------
     凍結：把所有物件從流式版面轉成絕對定位
     --------------------------------------------------------- */
  function freeze() {
    if (frozen) return;
    root.classList.add('eo-measuring');
    const rects = objs.map((el) => el.getBoundingClientRect());
    root.classList.add('is-edited');
    const R = remPx();

    objs.forEach((el, i) => {
      const r = rects[i];
      // 這個尺寸下沒被排版的物件（例如直式版面會把 .stage 設成 display:none）
      // 不要凍結，否則會被存成 0×0，之後永遠叫不回來
      if (r.width <= 0 || r.height <= 0) return;

      el.style.position = 'absolute';
      el.style.transformOrigin = '0 0';

      const p = el.offsetParent ?? root;
      const pr = p.getBoundingClientRect();
      const cs = getComputedStyle(p);
      G.set(el, {
        x: (r.left - pr.left - parseFloat(cs.borderLeftWidth)) / R,
        y: (r.top - pr.top - parseFloat(cs.borderTopWidth)) / R,
        // 補半像素：量到的寬高是小數，四捨五入後可能比實際內容窄一點點，
        // 收縮寬度的文字就會被擠到換行
        w: (r.width + 0.5) / R,
        h: (r.height + 0.5) / R,
        s: 1,
        hidden: false,
      });
      write(el);
    });

    root.classList.remove('eo-measuring');
    base = dump();
    frozen = true;
  }

  /** 還原成原本的流式版面（只在使用者還沒編輯過時用） */
  function unfreeze() {
    if (!frozen) return;
    for (const el of objs) {
      for (const p of ['position', 'left', 'top', 'width', 'height', 'transform', 'transformOrigin']) {
        el.style[p] = '';
      }
      el.classList.remove('eo-hidden');
    }
    root.classList.remove('is-edited');
    G.clear();
    frozen = false;
    base = null;
  }

  function write(el) {
    const g = G.get(el);
    if (!g) return;                       // 沒被凍結的物件不動它
    el.style.left = `${round(g.x, 3)}rem`;
    el.style.top = `${round(g.y, 3)}rem`;
    el.style.width = `${round(g.w, 3)}rem`;
    el.style.height = `${round(g.h, 3)}rem`;
    el.style.transform = g.s === 1 ? '' : `scale(${round(g.s, 4)})`;
    el.classList.toggle('eo-hidden', !!g.hidden);
  }

  /* ---------------------------------------------------------
     存 / 讀
     --------------------------------------------------------- */
  const dump = () => ({
    objects: Object.fromEntries(
      objs.filter((el) => G.has(el)).map((el) => [el.dataset.obj, { ...G.get(el) }])
    ),
    view: viewer?.getSavedView(sceneName) ?? null,   // 固定的 3D 視角
  });

  function load(data) {
    if (!data) return false;
    const objects = data.objects ?? data;      // 舊版存檔沒有 objects 這層
    let hit = 0;
    for (const el of objs) {
      const g = objects[el.dataset.obj];
      if (!g) continue;
      if (!G.has(el)) continue;                // 這個尺寸下沒排版到的物件跳過
      if (!(g.w > 0) || !(g.h > 0)) continue;  // 擋掉舊存檔裡的 0×0
      G.set(el, { x: 0, y: 0, w: 1, h: 1, s: 1, hidden: false, ...g });
      write(el);
      hit++;
    }
    if (data.view && viewer) viewer.applyView(sceneName, data.view);
    return hit > 0;
  }

  /* ---------- 存檔：localStorage（即時）+ layout.json（跨瀏覽器、跨機器） ---------- */
  let fileTimer = 0;
  let fileWarned = false;

  function save() {
    const json = JSON.stringify(dump());
    try { localStorage.setItem(storageKey, json); } catch { /* 無痕模式可能寫不進去 */ }

    // 寫檔用防抖，方向鍵微調時才不會每按一下就送一次
    clearTimeout(fileTimer);
    fileTimer = setTimeout(() => {
      fetch(layoutUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: json,
      }).then((r) => {
        if (!r.ok) throw new Error(r.status);
      }).catch((err) => {
        if (fileWarned) return;
        fileWarned = true;
        console.warn(`[editor] 版面寫不進 ${layoutUrl}（${err}），只會存在這個瀏覽器裡。` +
          '用 server.mjs 開才有檔案存檔。');
      });
    }, 400);
  }

  async function restore() {
    let data = null;
    // 檔案優先：換瀏覽器或換電腦也讀得到
    try {
      const r = await fetch(layoutUrl, { cache: 'no-store' });
      if (r.ok) data = await r.json();
    } catch { /* 沒有檔案或不是用 server.mjs 開的 */ }
    if (!data) {
      try { data = JSON.parse(localStorage.getItem(storageKey) ?? 'null'); } catch { /* 壞掉就當沒存過 */ }
    }
    if (!data) return false;
    freeze();
    dirty = true;               // 有存檔代表使用者調過，之後不再自動重量
    const ok = load(data);

    // 防呆：存檔是在別的視窗尺寸／狀態下存的話，套用後物件會整片跑到畫面外。
    // 與其讓使用者看到壞掉的版面又不知道怎麼救，不如直接丟掉回到自動排版。
    if (!looksSane()) {
      unfreeze();
      dirty = false;
      clearTimeout(fileTimer);
      try { localStorage.removeItem(storageKey); } catch { /* 無痕模式 */ }
      fetch(layoutUrl, { method: 'DELETE' }).catch(() => {});
      console.warn(`[editor] ${layoutUrl} 的版面和目前視窗對不起來，已忽略並回到自動排版`);
      return false;
    }

    migrateGuides(data);
    return ok;
  }

  /** 還原後有多少物件真的落在畫面裡；太少就代表這份存檔不能用 */
  function looksSane() {
    const r = root.getBoundingClientRect();
    const hits = objs.filter((el) => G.has(el)).map((el) => {
      const b = el.getBoundingClientRect();
      return b.right > r.left && b.left < r.right && b.bottom > r.top && b.top < r.bottom;
    });
    if (!hits.length) return true;
    return hits.filter(Boolean).length / hits.length >= 0.7;
  }

  /** 舊版存檔把參考線放在各頁的版面檔裡（只有數字、沒有來源頁），搬進共用的 store */
  function migrateGuides(data) {
    const xs = (data?.guides?.x ?? []).filter(Number.isFinite);
    const ys = (data?.guides?.y ?? []).filter(Number.isFinite);
    if (!xs.length && !ys.length) return;
    for (const v of xs) guides.add('v', pageId, v);
    for (const v of ys) guides.add('h', pageId, v);
    guides.save();
    save();                     // 版面檔重存一次，順便把舊的 guides 欄位去掉
    renderGuides();
    console.info(`[editor] 已把 ${xs.length + ys.length} 條舊參考線搬到共用清單（來源頁 ${pageId}）`);
  }

  function pushUndo() {
    dirty = true;
    undoStack.push(JSON.stringify({ o: dump(), g: guides.dump() }));
    if (undoStack.length > 60) undoStack.shift();
  }

  function undo() {
    const prev = undoStack.pop();
    if (!prev) return say('沒有可復原的步驟');
    const snap = JSON.parse(prev);
    load(snap.o);
    guides.apply(snap.g);
    save(); guides.save();
    sync(); renderGuides(); syncBar();
    say('已復原');
  }

  /* ---------------------------------------------------------
     覆蓋層
     --------------------------------------------------------- */
  function buildLayer() {
    layer = document.createElement('div');
    layer.className = 'eo-layer';

    // 吸附時閃現的對齊提示線
    snapLine = {
      v: Object.assign(document.createElement('div'), { className: 'eo-guide eo-guide--v' }),
      h: Object.assign(document.createElement('div'), { className: 'eo-guide eo-guide--h' }),
    };
    layer.append(snapLine.v, snapLine.h);

    // 使用者參考線 + 左／上兩條尺規（從尺規往內拖就拉出一條線）
    guideBox = document.createElement('div');
    guideBox.className = 'eo-guides';
    layer.appendChild(guideBox);

    for (const axis of ['h', 'v']) {
      const ruler = document.createElement('div');
      ruler.className = `eo-ruler eo-ruler--${axis}`;
      ruler.title = axis === 'h' ? '往下拖：新增水平參考線' : '往右拖：新增垂直參考線';
      ruler.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const lr = layer.getBoundingClientRect();
        const R = remPx();
        const at = axis === 'h' ? e.clientY - lr.top : e.clientX - lr.left;
        const i = guides.add(axis === 'h' ? 'h' : 'v', pageId, at / R);
        renderGuides();
        startGuideDrag(e, axis, i, guideBox.querySelector(`[data-axis="${axis}"][data-i="${i}"]`));
      });
      layer.appendChild(ruler);
    }

    for (const el of objs) {
      if (!G.has(el)) continue;              // 這個尺寸下沒排版到的物件不給操作框
      const box = document.createElement('div');
      box.className = 'eo-box';
      box.dataset.label = el.dataset.label ?? el.dataset.obj;
      for (const h of HANDLES) {
        const k = document.createElement('i');
        k.className = 'eo-h';
        k.dataset.h = h;
        box.appendChild(k);
      }
      box.addEventListener('pointerdown', (e) => onDown(e, el, box));
      box.addEventListener('dblclick', () => resetOne(el));
      layer.appendChild(box);
      boxes.set(el, box);
    }

    layer.addEventListener('pointerdown', (e) => { if (e.target === layer) select(null); });
    root.appendChild(layer);
    sync();
    renderGuides();      // 存檔裡的參考線要在覆蓋層建好之後才畫得出來
  }

  /** 依物件實際位置更新操作框 */
  function sync() {
    if (!layer) return;
    const lr = layer.getBoundingClientRect();
    for (const [el, box] of boxes) {
      const r = el.getBoundingClientRect();
      box.style.left = `${r.left - lr.left}px`;
      box.style.top = `${r.top - lr.top}px`;
      box.style.width = `${r.width}px`;
      box.style.height = `${r.height}px`;
      box.classList.toggle('is-sel', sel.has(el));
    }
  }

  /* ---------------------------------------------------------
     參考線
     --------------------------------------------------------- */
  function renderGuides() {
    if (!guideBox) return;
    guideBox.replaceChildren();
    const R = remPx();
    const mk = (axis) => (g0, i) => {
      const g = document.createElement('div');
      g.className = `eo-gl eo-gl--${axis}`;
      g.dataset.axis = axis;
      g.dataset.i = i;
      g.dataset.page = g0.p;            // 顏色依來源頁，見 editor.css
      g.style[axis === 'v' ? 'left' : 'top'] = `${g0.v * R}px`;
      const tag = document.createElement('span');
      tag.className = 'eo-gl__tag';
      tag.textContent = Math.round(g0.v * R);
      g.appendChild(tag);
      g.addEventListener('pointerdown', (e) => startGuideDrag(e, axis, i, g));
      g.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        pushUndo();
        guides.remove(axis, i);
        renderGuides(); guides.save();
      });
      guideBox.appendChild(g);
    };
    guides.x.forEach(mk('v'));
    guides.y.forEach(mk('h'));
  }

  function startGuideDrag(e, axis, i, el) {
    e.preventDefault();
    e.stopPropagation();
    pushUndo();
    const lr = layer.getBoundingClientRect();
    const R = remPx();
    const tag = el.querySelector('.eo-gl__tag');
    el.classList.add('is-drag');

    const at = (ev) => (axis === 'v' ? ev.clientX - lr.left : ev.clientY - lr.top);

    const move = (ev) => {
      const px = snapGuide(axis, at(ev));
      guides.move(axis, i, px / R);
      el.style[axis === 'v' ? 'left' : 'top'] = `${px}px`;
      tag.textContent = Math.round(px);
      el.classList.toggle('is-kill', at(ev) < RULER());
    };
    const up = (ev) => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      if (at(ev) < RULER()) guides.remove(axis, i);   // 拖回尺規＝刪除
      renderGuides(); guides.save();
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  }

  /** 可吸附的座標：其他物件的邊 / 中線、版面邊與中線、（可選）已有的參考線 */
  function candidates(withGuides) {
    const lr = layer.getBoundingClientRect();
    const xs = [0, lr.width / 2, lr.width];
    const ys = [0, lr.height / 2, lr.height];
    for (const n of objs) {
      if (sel.has(n) || !G.has(n)) continue;
      const r = n.getBoundingClientRect();
      xs.push(r.left - lr.left, (r.left + r.right) / 2 - lr.left, r.right - lr.left);
      ys.push(r.top - lr.top, (r.top + r.bottom) / 2 - lr.top, r.bottom - lr.top);
    }
    if (withGuides) {
      const R = remPx();
      for (const g of guides.x) xs.push(g.v * R);
      for (const g of guides.y) ys.push(g.v * R);
    }
    return { xs, ys };
  }

  function snapGuide(axis, px) {
    const list = candidates(false)[axis === 'v' ? 'xs' : 'ys'];
    let best = px, bd = SNAP;
    for (const t of list) { const d = Math.abs(px - t); if (d < bd) { bd = d; best = t; } }
    return Math.round(best);
  }

  function clearGuides() {
    pushUndo();
    if (!guides.clear()) return say('目前沒有參考線');
    renderGuides();
    say('參考線已清除（所有頁）');
  }

  /* ---------------------------------------------------------
     選取
     --------------------------------------------------------- */
  function select(el, add = false) {
    if (!add) sel.clear();
    if (el) {
      if (add && sel.has(el)) sel.delete(el);
      else sel.add(el);
    }
    sync(); syncBar();
  }

  /* ---------------------------------------------------------
     拖曳 / 縮放
     --------------------------------------------------------- */
  function onDown(e, el, box) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();

    const handle = e.target.dataset?.h;
    if (!sel.has(el)) select(el, e.shiftKey);
    else if (e.shiftKey) { select(el, true); return; }

    pushUndo();
    try { box.setPointerCapture(e.pointerId); } catch { /* 沒有實體指標時略過 */ }

    const R = remPx();
    const startX = e.clientX, startY = e.clientY;
    const start = new Map([...sel].map((n) => [n, { ...G.get(n) }]));
    const corner = handle && handle.length === 2;
    const free = e.altKey;
    const targets = handle ? [el] : [...sel];

    // 起始的視覺位置（相對覆蓋層），吸附計算用，不依賴各物件的 offsetParent
    const lr0 = layer.getBoundingClientRect();
    const r0 = el.getBoundingClientRect();
    const box0 = { x: r0.left - lr0.left, y: r0.top - lr0.top, w: r0.width, h: r0.height };

    const move = (ev) => {
      const dx = (ev.clientX - startX) / R;
      const dy = (ev.clientY - startY) / R;

      if (!handle) {
        const snapped = applySnap(box0, dx, dy, R, ev.shiftKey);
        for (const n of targets) {
          const s0 = start.get(n);
          G.set(n, { ...s0, x: s0.x + snapped.dx, y: s0.y + snapped.dy });
          write(n);
        }
      } else {
        resize(el, start.get(el), handle, corner, free, dx, dy);
        write(el);
      }
      sync(); syncBar();
    };

    const up = () => {
      try { box.releasePointerCapture(e.pointerId); } catch { /* 同上 */ }
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      hideSnapLine();
      save();
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  }

  function resize(el, s0, handle, corner, free, dx, dy) {
    const g = { ...s0 };
    const W = s0.w * s0.s, H = s0.h * s0.s;   // 視覺尺寸

    if (corner && !free) {
      // 四角：等比縮放，固定對角
      const nw = handle.includes('w') ? W - dx : W + dx;
      const nh = handle.includes('n') ? H - dy : H + dy;
      let f = (nw + nh) / (W + H);
      g.s = Math.min(SCALE_RANGE[1], Math.max(SCALE_RANGE[0], s0.s * f));
      f = g.s / s0.s;
      if (handle.includes('w')) g.x = s0.x + (W - W * f);
      if (handle.includes('n')) g.y = s0.y + (H - H * f);
    } else {
      // 四邊（或 Alt + 四角）：只改框大小
      const min = MIN / remPx();
      if (handle.includes('e')) g.w = Math.max(min, s0.w + dx / s0.s);
      if (handle.includes('w')) {
        g.w = Math.max(min, s0.w - dx / s0.s);
        g.x = s0.x + (s0.w - g.w) * s0.s;
      }
      if (handle.includes('s')) g.h = Math.max(min, s0.h + dy / s0.s);
      if (handle.includes('n')) {
        g.h = Math.max(min, s0.h - dy / s0.s);
        g.y = s0.y + (s0.h - g.h) * s0.s;
      }
    }
    G.set(el, g);
  }

  /* ---------------------------------------------------------
     對齊吸附（其他物件的邊 / 中線 + 版面中線）
     --------------------------------------------------------- */
  function applySnap(box0, dx, dy, R, off) {
    if (off) { hideSnapLine(); return { dx, dy }; }     // 按住 Shift 關閉吸附
    const { xs, ys } = candidates(true);                // 含使用者參考線
    const { w: W, h: H } = box0;
    const x0 = box0.x + dx * R, y0 = box0.y + dy * R;
    const cand = (v, list) => {
      let best = null, bd = SNAP;
      for (const t of list) { const d = Math.abs(v - t); if (d < bd) { bd = d; best = t; } }
      return best;
    };

    let gxHit = null, gyHit = null, ax = dx, ay = dy;
    for (const edge of [x0, x0 + W / 2, x0 + W]) {
      const t = cand(edge, xs);
      if (t !== null) { ax = dx + (t - edge) / R; gxHit = t; break; }
    }
    for (const edge of [y0, y0 + H / 2, y0 + H]) {
      const t = cand(edge, ys);
      if (t !== null) { ay = dy + (t - edge) / R; gyHit = t; break; }
    }

    snapLine.v.style.display = gxHit === null ? 'none' : 'block';
    snapLine.h.style.display = gyHit === null ? 'none' : 'block';
    if (gxHit !== null) snapLine.v.style.left = `${gxHit}px`;
    if (gyHit !== null) snapLine.h.style.top = `${gyHit}px`;
    return { dx: ax, dy: ay };
  }

  const hideSnapLine = () => {
    if (!snapLine) return;
    snapLine.v.style.display = snapLine.h.style.display = 'none';
  };

  /* ---------------------------------------------------------
     工具列
     --------------------------------------------------------- */
  function buildBar() {
    const ico = ([a, tip, svg]) =>
      `<button class="eo-bar__ico" data-a="${a}" title="${tip}" aria-label="${tip}">` +
      `<svg viewBox="0 0 16 16">${svg}</svg></button>`;

    bar = document.createElement('div');
    bar.className = 'eo-bar';
    bar.innerHTML = `
      <span class="eo-bar__tag" title="四角=等比縮放 · 四邊=改框 · 從左／上尺規拖出參考線（雙擊或拖回尺規刪除）· 方向鍵微調 · Ctrl+Z 復原">編輯中</span>
      <span class="eo-bar__name" data-f="name">未選取</span>
      <span class="eo-bar__sep"></span>
      <label>X<input data-f="x" type="number" step="1" disabled></label>
      <label>Y<input data-f="y" type="number" step="1" disabled></label>
      <label>寬<input data-f="w" type="number" step="1" disabled></label>
      <label>高<input data-f="h" type="number" step="1" disabled></label>
      <label>縮放<input data-f="s" type="number" step="0.05" disabled></label>
      <span class="eo-bar__sep"></span>
      <span class="eo-bar__group">${ALIGN_BTNS.map(ico).join('')}</span>
      <span class="eo-bar__group">${DIST_BTNS.map(ico).join('')}</span>
      <span class="eo-bar__group">${PAGE_BTNS.map(ico).join('')}</span>
      <span class="eo-bar__sep"></span>
      ${viewer ? `<button data-a="viewEdit" title="開啟後：左鍵拖曳轉角度、右鍵拖曳平移、滾輪縮放；放開就記住">調整模型</button>
      <button data-a="viewPivot" title="開啟後拖曳畫面平移「旋轉軸心」（黃色軸線），放開就記住">調整軸心</button>
      <button data-a="viewSpin" title="模型要不要自己慢慢轉整圈">自動旋轉</button>
      <button data-a="viewSwing" title="開啟後模型在目前角度 ± 擺幅之間來回擺動，不轉整圈">來回擺動</button>
      <label class="eo-bar__speed" title="自動旋轉速度（往左為反向、中間為停）；擺動時是快慢">速度<input data-f="spin" type="range" min="-2" max="2" step="0.05" style="width:70px;vertical-align:middle" disabled></label>
      <label class="eo-bar__speed" title="來回擺動的幅度（左右各幾度）">擺幅<input data-f="swingAmp" type="range" min="5" max="90" step="1" style="width:70px;vertical-align:middle" disabled></label>
      <button data-a="viewReset" title="視角回到預設">重設視角</button>
      <span class="eo-bar__sep"></span>` : ''}
      <button data-a="hide">隱藏</button>
      <button data-a="clearGuides">清除參考線</button>
      <button data-a="copy">複製 JSON</button>
      <button data-a="reset" class="is-warn">全部重設</button>
      <button data-a="exit">離開 (E)</button>`;

    fields = Object.fromEntries(
      [...bar.querySelectorAll('[data-f]')].map((n) => [n.dataset.f, n])
    );

    for (const k of ['x', 'y', 'w', 'h', 's']) {
      fields[k].addEventListener('change', () => {
        const el = [...sel][0];
        if (!el) return;
        pushUndo();
        const g = { ...G.get(el) };
        const R = remPx();
        const v = parseFloat(fields[k].value);
        if (Number.isNaN(v)) return syncBar();
        g[k] = k === 's' ? Math.min(SCALE_RANGE[1], Math.max(SCALE_RANGE[0], v)) : v / R;
        G.set(el, g);
        write(el); save(); sync(); syncBar();
      });
    }

    // 旋轉速度滑桿：拖動即時套用，放開才存檔（避免每格都寫一次檔）
    if (viewer && fields.spin) {
      fields.spin.disabled = false;
      fields.spin.addEventListener('input', () => viewer.setAutoRotateSpeed(parseFloat(fields.spin.value)));
      fields.spin.addEventListener('change', () => {
        rememberView();
        say(`旋轉速度 ${(+fields.spin.value).toFixed(2)}`);
      });
    }

    // 擺幅滑桿
    if (viewer && fields.swingAmp) {
      fields.swingAmp.disabled = false;
      fields.swingAmp.addEventListener('input', () => viewer.setSwingAmp(parseFloat(fields.swingAmp.value)));
      fields.swingAmp.addEventListener('change', () => {
        rememberView();
        say(`擺幅 ±${Math.round(fields.swingAmp.value)}°`);
      });
    }

    bar.addEventListener('click', (e) => {
      const btn = e.target.closest?.('[data-a]');
      const a = btn?.dataset.a;
      if (!a) return;
      const actions = {
        hide: toggleHidden,
        clearGuides,
        copy: copyJSON,
        reset: resetAll,
        exit: () => toggle(false),
        distX: () => distribute('x'),
        distY: () => distribute('y'),
        pageX: () => centerOnPage('x'),
        pageY: () => centerOnPage('y'),
        viewEdit: () => setModelEdit(!modelEdit),
        viewPivot: () => setPivotEdit(!pivotEdit),
        viewSpin: () => {
          if (!viewer) return;
          const v = viewer.getView();
          viewer.setAutoRotate(!v.autoRotate);
          rememberView();
          say(v.autoRotate ? '自動旋轉：關' : '自動旋轉：開');
        },
        viewSwing: () => {
          if (!viewer) return;
          const v = viewer.getView();
          viewer.setSwing(!v.swing);
          rememberView();
          say(v.swing ? '來回擺動：關' : `來回擺動：開（±${Math.round(v.swingAmp)}°）`);
        },
        viewReset: () => {
          if (!viewer) return;
          pushUndo();
          viewer.clearView(sceneName);
          save(); syncBar();
          say('視角已回到預設');
        },
      };
      if (actions[a]) actions[a]();
      else if (ALIGN_BTNS.some(([k]) => k === a)) align(a);
    });

    // 掛在 #app 內（而不是 body）：被 #app 的 overflow:hidden 收住，
    // 不會有機會撐出視窗捲軸而改變 vw/vh → rem
    const host = root.parentElement ?? root;
    host.appendChild(bar);

    toast = document.createElement('div');
    toast.className = 'eo-toast';
    host.appendChild(toast);
  }

  function syncBar() {
    if (!bar) return;
    const one = sel.size === 1 ? [...sel][0] : null;
    const R = remPx();
    fields.name.textContent =
      sel.size === 0 ? '未選取' : sel.size > 1 ? `已選 ${sel.size} 個` : (one.dataset.label ?? one.dataset.obj);

    for (const k of ['x', 'y', 'w', 'h', 's']) {
      fields[k].disabled = !one;
      if (!one) { fields[k].value = ''; continue; }
      const g = G.get(one);
      fields[k].value = k === 's' ? round(g.s, 3) : Math.round(g[k] * R);
    }
    bar.querySelector('[data-a="hide"]').textContent =
      one && G.get(one).hidden ? '顯示' : '隱藏';

    // 對齊／整組置中至少要選 1 個，均分要 3 個
    const need1 = [...ALIGN_BTNS, ...PAGE_BTNS].map(([k]) => k);
    for (const [k] of [...ALIGN_BTNS, ...DIST_BTNS, ...PAGE_BTNS]) {
      const btn = bar.querySelector(`[data-a="${k}"]`);
      if (btn) {
        btn.disabled = modelEdit || pivotEdit || sel.size < (need1.includes(k) ? 1 : 3);
      }
    }

    if (viewer) {
      const v = viewer.getView();
      bar.querySelector('[data-a="viewEdit"]')?.classList.toggle('is-on', modelEdit);
      bar.querySelector('[data-a="viewPivot"]')?.classList.toggle('is-on', pivotEdit);
      bar.querySelector('[data-a="viewSpin"]')?.classList.toggle('is-on', v.autoRotate);
      bar.querySelector('[data-a="viewSwing"]')?.classList.toggle('is-on', v.swing);
      // 不要在使用者正拖滑桿時覆蓋它的值
      if (fields.spin && document.activeElement !== fields.spin) fields.spin.value = v.speed ?? 0.45;
      if (fields.swingAmp && document.activeElement !== fields.swingAmp) fields.swingAmp.value = v.swingAmp ?? 40;
      const rst = bar.querySelector('[data-a="viewReset"]');
      if (rst) rst.disabled = !viewer.getSavedView(sceneName);
    }
  }

  let toastTimer = 0;
  function say(msg) {
    if (!toast) return;
    const el = toast;                 // 抓住當下這個元素：1.6 秒後 toast 可能已經被清成 null
    el.textContent = msg;
    el.classList.add('is-show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('is-show'), 1600);
  }

  /* ---------------------------------------------------------
     3D 視角
     --------------------------------------------------------- */
  let modelEdit = false;
  let pivotEdit = false;

  /** 讓覆蓋層放行滑鼠、事件進得到 canvas，並依模式切換 orbit（轉角度）/ pivot（移軸心） */
  function applyViewInteraction() {
    const on = modelEdit || pivotEdit;
    layer?.classList.toggle('is-pass', on);
    root.classList.toggle('is-model-edit', on);
    viewer?.setInteractionMode(pivotEdit ? 'pivot' : 'orbit');
    viewer?.showPivot(on);      // 編輯視角時都顯示軸心線（右鍵平移會移動它）
  }

  /** 調整模型：拖曳轉角度、滾輪縮放 */
  function setModelEdit(on) {
    if (!viewer) return;
    modelEdit = on;
    if (on) { pivotEdit = false; select(null); say('左鍵拖曳轉角度、右鍵拖曳平移、滾輪縮放，放開就記住'); }
    else say('回到物件編輯');
    applyViewInteraction();
    syncBar();
  }

  /** 調整軸心：拖曳平移黃色軸線＝移動自動旋轉的中心 */
  function setPivotEdit(on) {
    if (!viewer) return;
    pivotEdit = on;
    if (on) { modelEdit = false; select(null); say('拖曳畫面平移黃色軸線＝移動旋轉軸心，放開就記住'); }
    else say('回到物件編輯');
    applyViewInteraction();
    syncBar();
  }

  /** 把目前的視角記成固定視角並存檔 */
  function rememberView() {
    if (!viewer) return;
    viewer.saveView(sceneName);
    dirty = true;
    save(); syncBar();
  }

  if (viewer) {
    viewer.onViewEnd(() => { if (editing && (modelEdit || pivotEdit)) rememberView(); });
  }

  /* ---------------------------------------------------------
     對齊 / 均分（單位都用 rem，和 G 裡存的一致）
     --------------------------------------------------------- */
  /** 物件的視覺外框：x/y 就是 style 的 left/top，寬高要乘上縮放 */
  const boxOf = (el) => {
    const g = G.get(el);
    return { x: g.x, y: g.y, w: g.w * g.s, h: g.h * g.s };
  };

  const pageBox = () => {
    const R = remPx();
    const lr = layer.getBoundingClientRect();
    return { x: 0, y: 0, w: lr.width / R, h: lr.height / R };
  };

  /** 選 2 個以上＝以選取範圍為基準；只選 1 個＝以整個版面為基準 */
  function refBox(list) {
    if (list.length < 2) return pageBox();
    const bs = list.map(boxOf);
    const x1 = Math.min(...bs.map((b) => b.x));
    const y1 = Math.min(...bs.map((b) => b.y));
    const x2 = Math.max(...bs.map((b) => b.x + b.w));
    const y2 = Math.max(...bs.map((b) => b.y + b.h));
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  }

  const put = (el, key, v) => {
    const g = { ...G.get(el) };
    g[key] = v;
    G.set(el, g);
    write(el);
  };

  function align(mode) {
    const list = [...sel];
    if (!list.length) return say('先選取物件');
    pushUndo();
    const box = refBox(list);
    for (const el of list) {
      const b = boxOf(el);
      switch (mode) {
        case 'left':    put(el, 'x', box.x); break;
        case 'centerX': put(el, 'x', box.x + (box.w - b.w) / 2); break;
        case 'right':   put(el, 'x', box.x + box.w - b.w); break;
        case 'top':     put(el, 'y', box.y); break;
        case 'centerY': put(el, 'y', box.y + (box.h - b.h) / 2); break;
        case 'bottom':  put(el, 'y', box.y + box.h - b.h); break;
        default:
      }
    }
    save(); sync(); syncBar();
    say(list.length === 1 ? '已對齊到版面' : `已對齊 ${list.length} 個物件`);
  }

  /** 間距相等地攤開：頭尾不動，中間重新排 */
  function distribute(axis) {
    const list = [...sel];
    if (list.length < 3) return say('平均分布需要選 3 個以上');
    pushUndo();
    const key = axis === 'x' ? 'x' : 'y';
    const size = axis === 'x' ? 'w' : 'h';
    const items = list
      .map((el) => ({ el, b: boxOf(el) }))
      .sort((a, z) => a.b[key] - z.b[key]);

    const first = items[0].b;
    const last = items[items.length - 1].b;
    const span = last[key] + last[size] - first[key];
    const used = items.reduce((s, it) => s + it.b[size], 0);
    const gap = (span - used) / (items.length - 1);

    let cur = first[key];
    for (const it of items) {
      put(it.el, key, cur);
      cur += it.b[size] + gap;
    }
    save(); sync(); syncBar();
    say(`已均分 ${items.length} 個物件（間距 ${Math.round(gap * remPx())}px）`);
  }

  /** 整組搬到畫面正中，選取範圍內的相對位置不變 */
  function centerOnPage(axis) {
    const list = [...sel];
    if (!list.length) return say('先選取物件');
    pushUndo();
    const key = axis === 'x' ? 'x' : 'y';
    const size = axis === 'x' ? 'w' : 'h';
    const box = refBox(list.length === 1 ? [...list, ...list] : list);   // 單選時也用自己的框
    const page = pageBox();
    const delta = (page[size] - box[size]) / 2 - box[key];
    for (const el of list) put(el, key, boxOf(el)[key] + delta);
    save(); sync(); syncBar();
    say(axis === 'x' ? '已整組水平置中' : '已整組垂直置中');
  }

  /* ---------------------------------------------------------
     指令
     --------------------------------------------------------- */
  function nudge(dxPx, dyPx) {
    if (!sel.size) return;
    pushUndo();
    const R = remPx();
    for (const el of sel) {
      const g = { ...G.get(el) };
      g.x += dxPx / R;
      g.y += dyPx / R;
      G.set(el, g);
      write(el);
    }
    save(); sync(); syncBar();
  }

  function scaleBy(f) {
    if (!sel.size) return;
    pushUndo();
    for (const el of sel) {
      const g = { ...G.get(el) };
      g.s = Math.min(SCALE_RANGE[1], Math.max(SCALE_RANGE[0], g.s * f));
      G.set(el, g);
      write(el);
    }
    save(); sync(); syncBar();
  }

  function toggleHidden() {
    if (!sel.size) return say('先選一個物件');
    pushUndo();
    for (const el of sel) {
      const g = { ...G.get(el) };
      g.hidden = !g.hidden;
      G.set(el, g);
      write(el);
    }
    save(); sync(); syncBar();
  }

  function resetOne(el) {
    if (!base?.[el.dataset.obj]) return;
    pushUndo();
    G.set(el, { ...base[el.dataset.obj] });
    write(el); save(); sync(); syncBar();
    say('已還原這個物件');
  }

  function resetAll() {
    if (!base) return;
    pushUndo();
    load(base);
    save(); sync(); syncBar();
    say('版面已全部重設');
  }

  async function copyJSON() {
    const json = JSON.stringify(dump(), null, 2);
    try {
      await navigator.clipboard.writeText(json);
      say('已複製到剪貼簿');
    } catch {
      console.log(json);
      say('無法存取剪貼簿，已印在 console');
    }
  }

  /* ---------------------------------------------------------
     鍵盤（capture 階段攔截，避免和頁面切換衝突）
     --------------------------------------------------------- */
  function onKey(e) {
    if (!editing) return;
    if (e.target instanceof HTMLInputElement) {
      if (e.code === 'Escape') e.target.blur();
      return;
    }
    const step = e.shiftKey ? 10 : 1;
    const handled = () => { e.preventDefault(); e.stopPropagation(); };

    switch (e.code) {
      case 'ArrowLeft':  nudge(-step, 0); return handled();
      case 'ArrowRight': nudge(step, 0); return handled();
      case 'ArrowUp':    nudge(0, -step); return handled();
      case 'ArrowDown':  nudge(0, step); return handled();
      case 'BracketLeft':  scaleBy(0.98); return handled();
      case 'BracketRight': scaleBy(1.02); return handled();
      case 'Delete': case 'Backspace': toggleHidden(); return handled();
      case 'KeyZ': if (e.ctrlKey || e.metaKey) { undo(); return handled(); } return;
      case 'KeyA': if (e.ctrlKey || e.metaKey) { objs.forEach((n) => sel.add(n)); sync(); syncBar(); return handled(); } return;
      case 'Escape':
        if (sel.size) select(null);
        else toggle(false);
        return handled();
      default:
    }
  }

  /* ---------------------------------------------------------
     開關
     --------------------------------------------------------- */
  function toggle(on = !editing) {
    if (on === editing) return;
    editing = on;
    if (on) {
      freeze();
      root.classList.add('is-editing');
      buildLayer();
      buildBar();
      syncBar();
      say('編輯模式：拖曳移動，四角等比縮放');
    } else {
      modelEdit = false;
      pivotEdit = false;
      viewer?.setInteractionMode('kiosk');   // 離開編輯就鎖回展示狀態：只能轉、不能平移
      viewer?.showPivot(false);
      root.classList.remove('is-editing', 'is-model-edit');
      clearTimeout(toastTimer);
      layer?.remove(); bar?.remove(); toast?.remove();
      layer = bar = toast = snapLine = guideBox = null;
      boxes.clear(); sel.clear();
      if (dirty) save();          // 沒動過就不要留下存檔，維持自動排版
    }
  }

  addEventListener('keydown', onKey, true);

  // 視窗尺寸變了：還沒編輯過就整個重量一次，避免凍結在舊尺寸上
  let resizeTimer = 0;
  addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (frozen && !dirty) { unfreeze(); freeze(); }
      sync(); renderGuides();
    }, 80);
    sync();
  });

  return {
    toggle,
    restore,
    isEditing: () => editing,
    /** select('hero') 取代選取；select('act2', true) 加選 */
    select: (key, add = false) => {
      const el = objs.find((n) => n.dataset.obj === key);
      if (el) select(el, add);
      return !!el;
    },
    get: dump,
    set: (data) => { freeze(); dirty = true; load(data); save(); sync(); },
    reset: () => {
      resetAll();
      clearTimeout(fileTimer);
      localStorage.removeItem(storageKey);
      fetch(layoutUrl, { method: 'DELETE' }).catch(() => {});
      dirty = false;              // 回到「跟著視窗自動排版」的狀態
    },
  };
}

/** 沒有傳共用 store 時的替代品：只活在記憶體裡，不跨頁也不存檔 */
function createLocalGuides() {
  let x = [], y = [];
  return {
    get x() { return x; }, get y() { return y; },
    add(axis, p, v) { const a = axis === 'v' ? x : y; a.push({ p, v }); return a.length - 1; },
    move(axis, i, v) { const g = (axis === 'v' ? x : y)[i]; if (g) g.v = v; },
    remove(axis, i) { (axis === 'v' ? x : y).splice(i, 1); },
    clear() { if (!x.length && !y.length) return false; x = []; y = []; return true; },
    dump: () => ({ x: x.map((g) => ({ ...g })), y: y.map((g) => ({ ...g })) }),
    apply(d) { x = d?.x ?? []; y = d?.y ?? []; },
    save() {},
  };
}
