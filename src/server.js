'use strict';

/**
 * Local development server (NOT used on Vercel).
 *
 * Vercel ships its own runtime for `api/*`, which provides `req.query`,
 * `req.body` and the `res.status().json()` helpers. Plain Node `http` gives
 * none of those, so this file adapts the shared `handle()` to raw Node.
 *
 * Uses MemoryStore unless UPSTASH_REDIS_REST_* / KV_REST_API_* are set, in
 * which case it talks to the same Redis the deployment would.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { handle } = require('./app');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const API_ROUTES = {
  '/api/state': 'state',
  '/api/maxbet': 'maxbet',
  '/api/players': 'players',
  '/api/bet': 'bet',
  '/api/rotate': 'rotate',
  '/api/verify': 'verify',
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1e6) reject(new Error('body too large'));
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const filePath = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!filePath.startsWith(PUBLIC_DIR)) { // path traversal guard
    res.writeHead(403); return res.end('forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const routeName = API_ROUTES[url.pathname];

  try {
    if (routeName) {
      // Vercel parses the body for us; here we do it ourselves.
      const body = req.method === 'POST' ? await readBody(req) : {};
      const query = Object.fromEntries(url.searchParams.entries());
      const out = await handle(routeName, { query, body });
      res.writeHead(out.status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(out.json));
    }
    if (req.method === 'GET') return serveStatic(res, url.pathname);
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: `no route for ${req.method} ${url.pathname}` }));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: e.message }));
  }
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    const usingRedis = Boolean(
      (process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL)
      && (process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN),
    );
    console.log(`provably-fair dice (play money) listening on ${HOST}:${PORT}`);
    console.log(`storage: ${usingRedis ? 'Upstash Redis' : 'in-memory (resets on restart)'}`);
    if (HOST !== '127.0.0.1' && HOST !== 'localhost') {
      console.log('WARNING: bound to a non-loopback address — anyone who can route');
      console.log('         here can use it. It is play money, but there is no auth.');
    }
  });
}

module.exports = { server };
