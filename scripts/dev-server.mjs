#!/usr/bin/env node
/**
 * Development server for running LEDGER X in a desktop browser.
 * Serves dist/ and exposes a local-only SQLite bridge (/__sqlite) backed by
 * node:sqlite, so the real app runs against genuine on-disk SQLite files in
 * ./.data. Binds to 127.0.0.1 only. Never used in production builds.
 *
 *   node --experimental-sqlite scripts/dev-server.mjs [--port 5173] [--data .data]
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createNodeDriverFactory } from '../src/storage/adapters/nodeDriver.js';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const arg = (name, def) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : def; };
const port = Number(arg('--port', 5173));
const dataDir = path.resolve(root, arg('--data', '.data'));
const dist = path.join(root, 'dist');
const factory = createNodeDriverFactory(dataDir);
const dbs = new Map();

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.wasm': 'application/wasm', '.woff': 'font/woff', '.map': 'application/json' };

async function bridge(body) {
  const { db, op, sql, params = [] } = body;
  if (!/^[a-z0-9_]{1,64}$/.test(db || '')) throw new Error('bad db name');
  if (op === 'remove') { const d = dbs.get(db); if (d) { await d.close(); dbs.delete(db); } await factory.remove(db); return null; }
  if (!dbs.has(db)) dbs.set(db, await factory(db));
  const d = dbs.get(db);
  switch (op) {
    case 'open': return null;
    case 'run': return d.run(sql, params);
    case 'all': return d.all(sql, params);
    case 'exec': return d.exec(sql);
    case 'close': return null; // keep connection; page reloads reopen
    default: throw new Error('bad op');
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url === '/__sqlite/ping') { res.writeHead(200).end('ok'); return; }
    if (req.url === '/__sqlite' && req.method === 'POST') {
      let raw = '';
      for await (const c of req) raw += c;
      try {
        const result = await bridge(JSON.parse(raw));
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ result }));
      } catch (e) {
        res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: String(e.message || e) }));
      }
      return;
    }
    const url = new URL(req.url, 'http://x');
    let file = path.join(dist, decodeURIComponent(url.pathname));
    if (!file.startsWith(dist)) { res.writeHead(403).end(); return; }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!fs.existsSync(file)) file = path.join(dist, 'index.html');
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    res.writeHead(500).end(String(e));
  }
});
server.listen(port, '127.0.0.1', () => console.log(`LEDGER X dev server → http://127.0.0.1:${port}  (SQLite files in ${dataDir})`));
