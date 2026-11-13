'use strict';
// Обычный Node-сервер (локально, Render, сервер в клубе). В Neon Functions используется neon-entry.mjs.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const CORE = require('./core');
const { createHandler } = require('./app-handler');
const { createStore } = require('./store');

const PORT = process.env.PORT || 3000;
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.SESSION_SECRET) console.warn('SESSION_SECRET не задан — после перезапуска всем придётся войти заново');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
const assets = {};
for (const f of fs.readdirSync(path.join(__dirname, 'public'))) assets['/' + f] = { type: MIME[path.extname(f)] || 'application/octet-stream', body: fs.readFileSync(path.join(__dirname, 'public', f)) };
assets['/core.js'] = { type: MIME['.js'], body: fs.readFileSync(path.join(__dirname, 'core.js')) };

const handle = createHandler({
  core: CORE, store: createStore(), assets, secret: SECRET,
  setupCode: process.env.SETUP_CODE || '', botToken: process.env.BOT_TOKEN || '',
  publicUrl: process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || ''
});

http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const request = new Request('http://' + (req.headers.host || 'localhost') + req.url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body });
  const r = await handle(request);
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
}).listen(PORT, () => console.log('Castle Club слушает порт ' + PORT));
