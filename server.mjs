// 極簡靜態伺服器（ES Module 需要 http:// 才能載入）+ 一個同樣極簡的 WebSocket 轉播站
// 用法：node server.mjs [port]
import { createServer } from 'node:http';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { networkInterfaces } from 'node:os';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.argv[2] ?? process.env.PORT ?? 5280);
const MAX_BODY = 512 * 1024;
// 每頁一個版面檔：layout.json（第一頁）、layout-home.json（首頁）
const LAYOUT_RE = /^\/layout(-[a-z0-9]+)?\.json$/;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.hdr': 'image/vnd.radiance',
  '.ktx2': 'image/ktx2',
  '.woff2': 'font/woff2',
};

const server = createServer(async (req, res) => {
  const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);

  // 編輯模式的版面存檔：寫進專案裡的 layout*.json，不依賴瀏覽器的 localStorage
  if (LAYOUT_RE.test(url) && req.method !== 'GET') {
    const LAYOUT = join(ROOT, url.slice(1));
    if (req.method === 'DELETE') {
      await rm(LAYOUT, { force: true });
      res.writeHead(204).end();
      return;
    }
    if (req.method === 'PUT' || req.method === 'POST') {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > MAX_BODY) { res.writeHead(413).end('too large'); req.destroy(); return; }
      }
      try {
        JSON.parse(body);                        // 擋掉壞資料，免得寫壞檔案
        await writeFile(LAYOUT, body, 'utf8');
        res.writeHead(204).end();
      } catch {
        res.writeHead(400).end('bad json');
      }
      return;
    }
    res.writeHead(405).end('method not allowed');
    return;
  }

  const rel = normalize(url === '/' ? '/index.html' : url).replace(/^([/\\])+/, '');
  const file = join(ROOT, rel);

  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Robots-Tag': 'noindex, nofollow',   // 擋搜尋引擎索引（連非 HTML 檔一起擋）
    }).end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
  }
});

/* =========================================================================
   WebSocket 轉播站（/ws）
   主展示網站（index.html）把「目前場景 + 動線」丟上來，Pad（pad.html）收到就同步。

   為什麼是手刻不是裝 ws / socket.io：這個專案從頭到尾**零套件**（three.js 走 importmap CDN），
   現場是一台筆電開熱點跑 node server.mjs 就要能動，不能假設有 npm install 過。
   訊息只有幾十 bytes 的 JSON，用得到的功能就是「單一文字訊框 + ping/pong + close」，
   手刻大約一百行就夠穩。

   ⚠️ 這裡只實作**未分片**的文字訊框（FIN=1）。瀏覽器對這種小訊息不會分片，
      但如果之後要傳大東西（例如整份版面 JSON），要補上分片的組裝。
   ⚠️ client → server 的訊框**一定有遮罩**（RFC 6455 規定），所以解碼一定要 unmask；
      server → client 則**一定不能**加遮罩。
   ========================================================================= */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const clients = new Set();

// 目前狀態。新連上來的人會先收到這一份，所以 Pad 晚開、重整、斷線重連都能立刻對上。
let state = { scene: 'intro', phase: 'idle', route: -1, exit: null, ts: Date.now() };

/** 把字串包成一個未遮罩的文字訊框 */
function wsFrame(str) {
  const p = Buffer.from(str, 'utf8');
  let head;
  if (p.length < 126) {
    head = Buffer.from([0x81, p.length]);
  } else if (p.length < 65536) {
    head = Buffer.alloc(4); head[0] = 0x81; head[1] = 126; head.writeUInt16BE(p.length, 2);
  } else {
    head = Buffer.alloc(10); head[0] = 0x81; head[1] = 127; head.writeBigUInt64BE(BigInt(p.length), 2);
  }
  return Buffer.concat([head, p]);
}

const wsSend = (c, obj) => { try { c.socket.write(wsFrame(JSON.stringify(obj))); } catch { /* 對面斷了 */ } };
const wsPing = (c) => { try { c.socket.write(Buffer.from([0x89, 0])); } catch { /* 對面斷了 */ } };

function broadcast(obj, except) {
  for (const c of clients) if (c !== except) wsSend(c, obj);
}

server.on('upgrade', (req, socket) => {
  const { pathname, searchParams } = new URL(req.url, 'http://x');
  const key = req.headers['sec-websocket-key'];
  if (pathname !== '/ws' || !key) { socket.destroy(); return; }

  const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  socket.setNoDelay(true);

  const c = { socket, role: searchParams.get('role') ?? '?', alive: true };
  clients.add(c);
  console.log(`[ws] + ${c.role} 連上（目前 ${clients.size} 台）`);
  wsSend(c, state);                                  // 一連上就先給目前狀態

  let buf = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    // 一次可能收到好幾個訊框，也可能只收到半個 —— 收到完整的才處理，剩下的留著等下一批
    for (;;) {
      if (buf.length < 2) return;
      const op = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      const mask = masked ? buf.subarray(off, off + 4) : null;
      if (masked) off += 4;
      if (buf.length < off + len) return;             // 還沒收完

      const payload = Buffer.from(buf.subarray(off, off + len));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      buf = buf.subarray(off + len);

      if (op === 0x8) { socket.end(); return; }       // close
      if (op === 0x9) { socket.write(Buffer.from([0x8a, 0])); continue; }   // ping → pong
      if (op === 0xa) { c.alive = true; continue; }   // pong
      if (op !== 0x1) continue;                       // 只收文字

      let msg; try { msg = JSON.parse(payload.toString('utf8')); } catch { continue; }
      if (!msg || typeof msg !== 'object') continue;
      if (msg.type === 'hello') { wsSend(c, state); continue; }

      // 主展示端送來的狀態：存下來 + 轉給其他人
      state = { ...state, ...msg, ts: Date.now() };
      broadcast(state, c);
    }
  });

  const bye = () => {
    if (!clients.delete(c)) return;
    console.log(`[ws] − ${c.role} 離線（剩下 ${clients.size} 台）`);
  };
  socket.on('close', bye);
  socket.on('error', bye);
});

// 心跳：25 秒 ping 一次，連兩次沒回應就當它死了
setInterval(() => {
  for (const c of clients) {
    if (!c.alive) { c.socket.destroy(); clients.delete(c); continue; }
    c.alive = false;
    wsPing(c);
  }
}, 25000).unref();

/** 列出這台機器在區域網路上的 IP，方便 Pad 直接輸入 */
function lanURLs() {
  const out = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const n of list ?? []) {
      if (n.family === 'IPv4' && !n.internal) out.push(`http://${n.address}:${PORT}`);
    }
  }
  return out;
}

server.listen(PORT, () => {
  console.log(`serving ${ROOT} → http://localhost:${PORT}`);
  const urls = lanURLs();
  if (urls.length) {
    console.log('\n同一個 Wi-Fi 下，Pad 開這個網址：');
    for (const u of urls) console.log(`  ${u}/pad.html`);
    console.log('主展示端就開：');
    for (const u of urls) console.log(`  ${u}/`);
  }
  console.log('');
});
