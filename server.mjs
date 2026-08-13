// 極簡靜態伺服器（ES Module 需要 http:// 才能載入）
// 用法：node server.mjs [port]
import { createServer } from 'node:http';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

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

createServer(async (req, res) => {
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
}).listen(PORT, () => console.log(`serving ${ROOT} → http://localhost:${PORT}`));
