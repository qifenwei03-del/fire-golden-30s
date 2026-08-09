/* =========================================================
   跨頁共用的參考線
   ---------------------------------------------------------
   每條線記下是「從哪一頁拉出來的」（p），編輯任何一頁都看得到全部的線，
   顏色依來源頁區分（顏色定義在 css/editor.css 的 .eo-gl[data-page=...]）。
   座標 v 的單位是 rem，相對覆蓋層左上角。
   ========================================================= */

export function createGuideStore({
  url = './layout-guides.json',
  storageKey = 'fire30.guides',
} = {}) {
  let x = [];   // [{ p:'first', v:26.25 }] 垂直線
  let y = [];   // 水平線

  const dump = () => ({ x: x.map((g) => ({ ...g })), y: y.map((g) => ({ ...g })) });

  const sane = (list) =>
    (Array.isArray(list) ? list : [])
      .filter((g) => g && Number.isFinite(g.v))
      .map((g) => ({ p: typeof g.p === 'string' ? g.p : 'first', v: g.v }));

  function apply(data) {
    x = sane(data?.x);
    y = sane(data?.y);
  }

  async function load() {
    let data = null;
    try {
      const r = await fetch(url, { cache: 'no-store' });
      if (r.ok) data = await r.json();
    } catch { /* 沒有檔案或不是用 server.mjs 開的 */ }
    if (!data) {
      try { data = JSON.parse(localStorage.getItem(storageKey) ?? 'null'); } catch { /* 壞掉就當沒存過 */ }
    }
    if (!data) return false;
    apply(data);
    return true;
  }

  let timer = 0;
  let warned = false;
  function save() {
    const json = JSON.stringify(dump());
    try { localStorage.setItem(storageKey, json); } catch { /* 無痕模式可能寫不進去 */ }
    clearTimeout(timer);
    timer = setTimeout(() => {
      fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: json,
      }).then((r) => {
        if (!r.ok) throw new Error(r.status);
      }).catch((err) => {
        if (warned) return;
        warned = true;
        console.warn(`[guides] 參考線寫不進 ${url}（${err}），只會存在這個瀏覽器裡。`);
      });
    }, 400);
  }

  return {
    get x() { return x; },
    get y() { return y; },
    list: (axis) => (axis === 'v' ? x : y),
    add(axis, page, v) {
      const arr = axis === 'v' ? x : y;
      arr.push({ p: page, v });
      return arr.length - 1;
    },
    move(axis, i, v) { const g = (axis === 'v' ? x : y)[i]; if (g) g.v = v; },
    remove(axis, i) { (axis === 'v' ? x : y).splice(i, 1); },
    clear() {
      if (!x.length && !y.length) return false;
      x = []; y = [];
      clearTimeout(timer);
      try { localStorage.removeItem(storageKey); } catch { /* 同上 */ }
      fetch(url, { method: 'DELETE' }).catch(() => {});
      return true;
    },
    dump, apply, load, save,
  };
}
