/* =========================================================================
   住戶端 Pad
   只做兩件事：連上 /ws，收到狀態就換畫面。**不送任何東西**（除了握手的 hello）。
   ========================================================================= */
import { createSync } from './sync.js';

const $ = (id) => document.getElementById(id);
const els = {
  body: document.body,
  link: $('link'), kicker: $('kicker'), title: $('title'), sub: $('sub'),
  route: $('route'), goal: $('goal'), foot: $('foot'),
};

/* 四個場景各自要顯示什麼。exit 是主展示端算好的建議出口（'A' / 'B'）。
   state 決定配色和動畫（css 的 body[data-state]）：
     safe 藍 / alarm 紅 / guide 琥珀 / clear 綠 */
const VIEW = {
  intro: () => ({
    state: 'safe', kicker: '系統待機中', title: '安全',
    sub: '住戶端連線正常，目前無異常', route: null,
  }),
  golden30: () => ({
    state: 'alarm', kicker: '偵測到火災', title: '請立即疏散',
    sub: '黃金 30 秒，請保持冷靜、循指示離開', route: null,
  }),
  // aiRoute 下面還分三種：還沒開始跑 / 跑動線中 / 已抵達出口。
  // ⚙ 還沒開始跑的時候**不要隨便報一個出口** —— 那時候主展示端還沒挑動線，
  //   報了就是假資訊；實際現場住戶看到錯的出口是會出事的。
  aiRoute: (s) => {
    if (s.phase === 'cleared') return {
      state: 'clear', kicker: 'AI 智慧分流', title: `已抵達 ${s.exit} 出口`,
      sub: '您已離開危險區域', route: s.exit,
    };
    if (s.phase === 'running' && s.exit) return {
      state: 'guide', kicker: 'AI 智慧分流', title: `請前往 ${s.exit} 出口`,
      sub: '已為您避開火源與濃煙，沿指引前進', route: s.exit,
    };
    return {
      state: 'guide', kicker: 'AI 智慧分流', title: '正在規劃路線',
      sub: '即時感知火源位置，馬上為您指定最安全的出口', route: null,
    };
  },
  outro: () => ({
    state: 'clear', kicker: '疏散完成', title: '已離開危險區域',
    sub: '您目前位於安全區域，請留在原地等候通知', route: null,
  }),
};

function render(s) {
  const make = VIEW[s?.scene] ?? VIEW.intro;
  const v = make(s ?? {});
  els.body.dataset.state = v.state;
  els.kicker.textContent = v.kicker;
  els.title.textContent = v.title;
  els.sub.textContent = v.sub;
  els.route.hidden = !v.route;
  if (v.route) els.goal.textContent = `${v.route} 出口`;
}

const sync = createSync({
  role: 'pad',
  onState: render,
  onStatus: (ok) => {
    els.link.dataset.ok = ok ? '1' : '0';
    els.link.querySelector('b').textContent = ok ? '已連線' : '連線中…';
  },
});

render(null);                                   // 還沒收到之前先給待機畫面

// 給現場除錯用：__pad.render({scene:'aiRoute', exit:'A'}) 可以直接假裝收到狀態
Object.assign(window, { __pad: { render, sync } });
