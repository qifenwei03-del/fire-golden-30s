const NS = 'http://www.w3.org/2000/svg';

/**
 * 圓形 30 秒倒數面板。
 * 依剩餘秒數點亮外圈刻度，並同步高亮右側 0-10 / 10-20 / 20-30 階段卡。
 */
export function createCountdown({
  ticksEl,
  headEl,
  numEl,
  phaseEls = [],
  stageEl = null,      // 會被寫上 data-stage，讓整組圓盤跟著時段換色
  urgentAt = 5,        // 剩幾秒開始加 .is-urgent（數字閃爍）
  onEnd = null,        // 倒數歸零時呼叫一次（每一輪只呼叫一次）
  onPhase = null,      // 階段變化時呼叫（0=0-10s / 1=10-20s / 2=20-30s / -1=未開始）
  duration = 30,
  ticks = 60,
  loop = true,
  loopDelay = 1.2,
} = {}) {
  const CX = 200, CY = 200, R_IN = 146, R_OUT = 176;

  // 產生刻度（自正上方順時針）
  const lines = [];
  for (let i = 0; i < ticks; i++) {
    const a = (-90 + (360 / ticks) * i) * (Math.PI / 180);
    const l = document.createElementNS(NS, 'line');
    l.setAttribute('x1', (CX + Math.cos(a) * R_IN).toFixed(2));
    l.setAttribute('y1', (CY + Math.sin(a) * R_IN).toFixed(2));
    l.setAttribute('x2', (CX + Math.cos(a) * R_OUT).toFixed(2));
    l.setAttribute('y2', (CY + Math.sin(a) * R_OUT).toFixed(2));
    ticksEl.appendChild(l);
    lines.push(l);
  }

  let startedAt = 0;
  let raf = 0;
  let paused = true;
  // NaN 保證第一次一定會重畫（-1 是 idx 的合法值，不能拿來當髒標記）
  let litCache = NaN;
  let phaseCache = NaN;
  let numCache = NaN;
  let urgentCache = NaN;
  let ended = false;          // 這一輪的 onEnd 有沒有叫過

  function paint(remaining) {
    const lit = Math.min(ticks, Math.ceil((remaining / duration) * ticks));
    if (lit !== litCache) {
      for (let i = 0; i < ticks; i++) lines[i].classList.toggle('on', i < lit);
      const a = (-90 + (360 / ticks) * (lit - 0.5)) * (Math.PI / 180);
      headEl.setAttribute('cx', (CX + Math.cos(a) * ((R_IN + R_OUT) / 2)).toFixed(2));
      headEl.setAttribute('cy', (CY + Math.sin(a) * ((R_IN + R_OUT) / 2)).toFixed(2));
      headEl.style.opacity = lit > 0 ? '1' : '0';
      litCache = lit;
    }

    const shown = Math.max(0, Math.ceil(remaining));
    if (shown !== numCache) {
      numEl.textContent = String(shown);
      numCache = shown;
    }

    // 最後 5 秒讓數字閃爍
    const urgent = remaining <= urgentAt;
    if (stageEl && urgent !== urgentCache) {
      stageEl.classList.toggle('is-urgent', urgent);
      urgentCache = urgent;
    }

    // 已經過秒數 → 對應階段
    const elapsed = duration - remaining;
    const idx = remaining >= duration ? -1
      : Math.min(phaseEls.length - 1, Math.floor(elapsed / (duration / phaseEls.length)));
    if (idx !== phaseCache) {
      phaseEls.forEach((el, i) => el.classList.toggle('is-on', i === idx));
      if (stageEl) {
        if (idx < 0) delete stageEl.dataset.stage;
        else stageEl.dataset.stage = String(idx);
      }
      phaseCache = idx;
      onPhase?.(idx);           // 通知外部（例如 3D 逃生點）目前在哪個時段
    }
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    if (paused) return;
    const elapsed = (now - startedAt) / 1000;
    const remaining = duration - elapsed;
    if (remaining > 0) { paint(remaining); return; }
    paint(0);                                   // 歸零後停留 loopDelay 秒再重跑
    if (!ended) { ended = true; onEnd?.(); }
    if (loop && elapsed >= duration + loopDelay) reset();
  }

  function reset() {
    startedAt = performance.now();
    litCache = phaseCache = numCache = urgentCache = NaN;
    ended = false;
    paint(duration);
  }

  function start() {
    if (!raf) raf = requestAnimationFrame(frame);
    if (paused) {
      paused = false;
      reset();
    }
  }

  function pause() { paused = true; }

  function stop() {
    cancelAnimationFrame(raf);
    raf = 0;
    paused = true;
  }

  paint(duration);
  return { start, pause, stop, reset };
}
