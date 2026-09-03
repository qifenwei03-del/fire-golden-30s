/* =========================================================================
   兩台裝置的即時同步（主展示端 ⇄ Pad）
   走 WebSocket，接到 server.mjs 的 /ws。**不用 localStorage** ——
   localStorage 只在同一台瀏覽器裡有效，跨裝置根本傳不過去。

   用法：
     const sync = createSync({ role:'display', onState(s){...}, onStatus(ok){...} });
     sync.send({ scene:'golden30', route:2, exit:'A' });

   ⚠️ 斷線會**自己重連**（1.5 秒一次），現場網路抖一下不用重整頁面。
   ⚠️ 一連上 server 就會把「目前狀態」推過來，所以 Pad 晚開機、重整、
      或中途斷線重連，都會立刻對上主展示端的畫面，不需要主控端再按一次。

   要連到哪一台：
     預設是**誰送出這個頁面就連回誰**（一台筆電跑 server.mjs、兩邊都連它，最單純）。
     主展示端和 Pad 拆成兩個站、各自部署的時候，Pad 那邊要指定主機：
       http://<pad 的網址>/?server=192.168.0.12:5280
     ⚠️ 指定過的位址**不會記起來**，現場請把帶參數的網址直接加成平板的書籤。
        故意不用 localStorage 存 —— 記住一個舊的 IP 比每次貼網址更難查。
   ========================================================================= */
export function createSync({ role = 'pad', onState = null, onStatus = null } = {}) {
  // ?server=host:port 可以指定主機；沒帶就連回送出這個頁面的那一台
  const host = new URLSearchParams(location.search).get('server') || location.host;
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${host}/ws?role=${role}`;
  let ws = null;
  let retry = null;
  let last = null;                       // 最後送出去的狀態，重連之後補送

  function open() {
    clearTimeout(retry);
    try { ws = new WebSocket(url); } catch { schedule(); return; }

    ws.onopen = () => {
      onStatus?.(true);
      // 主控端重連之後把最後的狀態補送一次，免得 server 記的是舊的
      if (role === 'display' && last) send(last);
      else ws.send(JSON.stringify({ type: 'hello' }));
    };
    ws.onmessage = (e) => {
      let s; try { s = JSON.parse(e.data); } catch { return; }
      if (s && typeof s === 'object' && !s.type) onState?.(s);
    };
    ws.onclose = () => { onStatus?.(false); schedule(); };
    ws.onerror = () => { try { ws.close(); } catch { /* 已經關了 */ } };
  }

  function schedule() {
    clearTimeout(retry);
    retry = setTimeout(open, 1500);
  }

  function send(obj) {
    last = { ...obj };
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
    // 沒連上就只記著，onopen 會補送
  }

  open();
  return { send, isOpen: () => ws?.readyState === WebSocket.OPEN };
}
