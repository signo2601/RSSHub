// Local development server for Gruzzolo.
//   node dev/server.mjs            → http://localhost:8787
//   PORT=9000 node dev/server.mjs  → another port
//   HOST=0.0.0.0 node dev/server.mjs → reachable from the iPhone on the same Wi-Fi (plain http:
//                                    the offline service worker only starts on https or localhost)
//
// Serves the static app from the gruzzolo/ folder and answers /api/* with the same
// Cloudflare Pages Function used in production (functions/api/[[path]].js), reloaded
// automatically when the file changes. The API is read-only market data: nothing is stored here.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const FUNCTION_FILE = path.join(ROOT, 'functions', 'api', '[[path]].js');
const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || '127.0.0.1';
const MAX_BODY = 1024 * 1024; // the API takes no uploads: bodies are only read to answer 404/405

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.csv': 'text/csv; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

// Behind an HTTPS proxy (corporate network, sandbox) Node's fetch only uses it when
// NODE_USE_ENV_PROXY=1 is set at startup: restart once as a child process with it.
const proxied = process.env.HTTPS_PROXY || process.env.https_proxy;
if (proxied && !process.env.NODE_USE_ENV_PROXY && !process.env.GRUZZOLO_DEV_CHILD) {
  const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    env: { ...process.env, NODE_USE_ENV_PROXY: '1', GRUZZOLO_DEV_CHILD: '1' },
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
  });
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => child.kill(sig));
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
} else {
  // A child started above exits together with its parent
  if (process.send) process.on('disconnect', () => process.exit(0));
  start();
}

/* ---------- API: load the Pages Function, reload when it changes ---------- */
let fnModule = null;
let fnStamp = 0;
async function loadFunction() {
  const { mtimeMs } = await stat(FUNCTION_FILE);
  if (!fnModule || mtimeMs !== fnStamp) {
    fnModule = await import(pathToFileURL(FUNCTION_FILE).href + '?v=' + mtimeMs);
    fnStamp = mtimeMs;
  }
  return fnModule;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const HOP_HEADERS = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'expect', 'proxy-connection', 'http2-settings', 'te', 'trailer']);

async function handleApi(req, res, url) {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined || HOP_HEADERS.has(k) || k.startsWith(':')) continue;
    headers.set(k, Array.isArray(v) ? v.join(', ') : v);
  }
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  const body = hasBody ? await readBody(req) : undefined;
  if (body) headers.set('content-length', String(body.length));
  const request = new Request(url.href, { method: req.method, headers, body: body && body.length ? body : hasBody ? '' : undefined });
  const { onRequest } = await loadFunction();
  const pending = [];
  const response = await onRequest({
    request,
    env: {},
    params: { path: url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean) },
    waitUntil: (p) => pending.push(Promise.resolve(p).catch(() => {})),
    next: async () => new Response('Not found', { status: 404 }),
  });
  const out = {};
  response.headers.forEach((v, k) => {
    out[k] = v;
  });
  const buf = req.method === 'HEAD' || !response.body ? Buffer.alloc(0) : Buffer.from(await response.arrayBuffer());
  if (req.method !== 'HEAD') out['content-length'] = String(buf.length);
  res.writeHead(response.status, out);
  res.end(buf);
}

/* ---------- Static files ---------- */
async function handleStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'GET, HEAD' });
    res.end('Metodo non consentito');
    return;
  }
  let rel;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch {
    rel = url.pathname;
  }
  if (rel.endsWith('/')) rel += 'index.html';
  let file = path.resolve(ROOT, '.' + rel);
  const inside = file === ROOT || file.startsWith(ROOT + path.sep);
  // Never serve dotfiles (.git, .env) or anything outside the project folder
  const hidden = path.relative(ROOT, file).split(path.sep).some((p) => p.startsWith('.'));
  let info = null;
  if (inside && !hidden) {
    try {
      info = await stat(file);
      if (info.isDirectory()) {
        file = path.join(file, 'index.html');
        info = await stat(file);
      }
    } catch {
      info = null;
    }
  }
  if (!info || !info.isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : `Non trovato: ${url.pathname}`);
    return;
  }
  const data = await readFile(file);
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': data.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(req.method === 'HEAD' ? undefined : data);
}

function start() {
  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    let url;
    try {
      url = new URL(req.url || '/', `http://${req.headers.host || `localhost:${PORT}`}`);
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) await handleApi(req, res, url);
      else await handleStatic(req, res, url);
    } catch (e) {
      const status = e && e.status ? e.status : 500;
      if (!res.headersSent) {
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ error: status === 413 ? 'Dati troppo grandi' : 'Errore del server di sviluppo' }));
      } else res.destroy();
      console.error(`[dev] ${req.method} ${req.url} → ${e && e.stack ? e.stack : e}`);
    }
    if (process.env.LOG && url && url.pathname.startsWith('/api')) console.log(`[api] ${req.method} ${url.pathname}${url.search} ${res.statusCode} ${Date.now() - started}ms`);
  });
  server.keepAliveTimeout = 5000;
  server.on('error', (e) => {
    console.error(e.code === 'EADDRINUSE' ? `[dev] La porta ${PORT} è già in uso: chiudi l'altro server o usa PORT=xxxx.` : `[dev] ${e.message}`);
    process.exit(1);
  });
  server.listen(PORT, HOST, () => {
    const shown = HOST === '0.0.0.0' || HOST === '::' ? 'localhost' : HOST;
    console.log(`Gruzzolo dev server: http://${shown}:${PORT}/`);
    console.log(`  API prezzi: http://${shown}:${PORT}/api/health`);
    if (HOST === '127.0.0.1') console.log('  Per provarlo dall\'iPhone sulla stessa rete Wi-Fi: HOST=0.0.0.0 node dev/server.mjs');
  });
  const stop = () => {
    server.close();
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
