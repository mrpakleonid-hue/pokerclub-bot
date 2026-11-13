'use strict';
// Castle Club — сервер: веб-приложение, API, Telegram-бот. Зависимость одна: pg (если задан DATABASE_URL).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const CORE = require('./core');
const store = require('./store');

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const PUBLIC_URL = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
const SECRET = process.env.SESSION_SECRET || crypto.createHash('sha256').update('castle-dev-' + BOT_TOKEN).digest('hex');
const HOOK_PATH = '/tg/' + crypto.createHash('sha256').update('hook' + SECRET).digest('hex').slice(0, 24);

let S = CORE.initialState();
let BOT_USERNAME = process.env.BOT_USERNAME || '';
let ready = false;
let queue = Promise.resolve(); // события применяются строго по одному

/* ---------- сессии ---------- */
const sign = s => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');
const makeToken = uid => { const body = uid + '.' + Date.now(); return body + '.' + sign(body); };
function readToken(tok) {
  if (!tok) return null; const i = tok.lastIndexOf('.'); if (i < 0) return null;
  const body = tok.slice(0, i), sig = tok.slice(i + 1);
  const exp = sign(body);
  if (sig.length !== exp.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(exp))) return null;
  const [uid, ts] = body.split('.');
  if (Date.now() - Number(ts) > 60 * CORE.DAY) return null;
  return CORE.U(S, uid) ? uid : null;
}

/* ---------- проверка данных Telegram Mini App ---------- */
function checkInitData(initData) {
  if (!BOT_TOKEN || !initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash'); if (!hash) return null;
  params.delete('hash');
  const dataCheck = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => k + '=' + v).join('\n');
  const key = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const calc = crypto.createHmac('sha256', key).update(dataCheck).digest('hex');
  if (calc.length !== hash.length || !crypto.timingSafeEqual(Buffer.from(calc), Buffer.from(hash))) return null;
  if (Date.now() / 1000 - Number(params.get('auth_date') || 0) > 7 * 86400) return null;
  try { return JSON.parse(params.get('user')); } catch (e) { return null; }
}

/* ---------- Telegram ---------- */
async function tg(method, body) {
  if (!BOT_TOKEN) return null;
  try {
    const r = await fetch('https://api.telegram.org/bot' + BOT_TOKEN + '/' + method, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
    return await r.json();
  } catch (e) { console.error('telegram', method, e.message); return null; }
}
function sendOut(out) { (out || []).forEach(m => tg('sendMessage', { chat_id: m.chat_id, text: m.text })); }

async function onUpdate(u) {
  const msg = u.message; if (!msg || !msg.chat) return;
  if (msg.text && msg.text.startsWith('/start')) {
    await tg('sendMessage', {
      chat_id: msg.chat.id,
      text: '🏰 Castle Club — покерный клуб (игра не на деньги, 18+).\n\nЗдесь можно записаться на турнир, следить за таймером, запросить ребай и посмотреть рейтинг. Нажмите кнопку ниже, чтобы открыть приложение.',
      reply_markup: PUBLIC_URL ? { inline_keyboard: [[{ text: 'Открыть приложение', web_app: { url: PUBLIC_URL + '/' } }]] } : undefined
    });
  } else {
    await tg('sendMessage', { chat_id: msg.chat.id, text: 'Всё управление — в приложении: кнопка «Клуб» внизу слева или команда /start.' });
  }
}
async function setupBot() {
  if (!BOT_TOKEN || !PUBLIC_URL) { console.log('Бот не настроен: нет BOT_TOKEN или PUBLIC_URL'); return; }
  const me = await tg('getMe'); if (me && me.ok) BOT_USERNAME = me.result.username;
  const r = await tg('setWebhook', { url: PUBLIC_URL + HOOK_PATH, allowed_updates: ['message'] });
  console.log('setWebhook', r && r.ok);
  await tg('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Клуб', web_app: { url: PUBLIC_URL + '/' } } });
  await tg('setMyCommands', { commands: [{ command: 'start', description: 'Открыть Castle Club' }] });
}

/* ---------- события ---------- */
function commit(ev) {
  const run = queue.then(async () => {
    if (S.applied[ev.id]) return { dup: true };
    const tmp = structuredClone(S);
    const res = CORE.apply(tmp, ev); // бросит Refused, если нельзя
    await store.append(ev);
    S = tmp;
    sendOut(res.out);
    return res;
  });
  queue = run.catch(() => {});
  return run;
}
const newEvent = (uid, type, payload, id) => ({ id: id && /^[\w-]{8,64}$/.test(id) ? id : crypto.randomUUID(), ts: Date.now(), uid, type, payload: payload || {} });

/* ---------- HTTP ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };
function send(res, code, obj) { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); }
function body(req) {
  return new Promise((ok, bad) => { let d = ''; req.on('data', c => { d += c; if (d.length > 1e6) req.destroy(); }); req.on('end', () => { try { ok(d ? JSON.parse(d) : {}); } catch (e) { bad(e); } }); });
}
function serveStatic(req, res) {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/') p = '/index.html';
  if (p === '/core.js') { res.writeHead(200, { 'content-type': MIME['.js'] }); return fs.createReadStream(path.join(__dirname, 'core.js')).pipe(res); }
  const f = path.join(__dirname, 'public', path.normalize(p).replace(/^(\.\.[\/\\])+/, ''));
  if (!f.startsWith(path.join(__dirname, 'public'))) { res.writeHead(404); return res.end(); }
  fs.stat(f, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('Не найдено'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': p === '/index.html' ? 'no-cache' : 'public, max-age=3600' });
    fs.createReadStream(f).pipe(res);
  });
}
const attempts = new Map(); // защита от перебора кодов
function tooMany(key) { const now = Date.now(); const a = (attempts.get(key) || []).filter(t => now - t < 15 * 60000); a.push(now); attempts.set(key, a); return a.length > 8; }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/api/config') return send(res, 200, { bot: BOT_USERNAME });
    if (url.pathname === '/health') return send(res, 200, { ok: true, ready, users: S.users.length });
    if (!ready && url.pathname.startsWith('/api')) return send(res, 503, { error: 'Сервер запускается, попробуйте через минуту' });

    if (req.method === 'POST' && url.pathname === HOOK_PATH) { const u = await body(req); send(res, 200, { ok: true }); onUpdate(u).catch(e => console.error(e)); return; }

    if (req.method === 'POST' && url.pathname === '/api/auth/telegram') {
      const b = await body(req); const tu = checkInitData(b.initData);
      if (!tu) return send(res, 401, { error: 'Не удалось проверить вход через Telegram' });
      const uid = 'g' + tu.id;
      if (!CORE.U(S, uid)) await commit(newEvent(null, 'user_new', { uid, tg_id: tu.id, nick: tu.username || tu.first_name, name: [tu.first_name, tu.last_name].filter(Boolean).join(' ') }));
      return send(res, 200, { token: makeToken(uid) });
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/code') {
      const b = await body(req);
      const phone = String(b.phone || '').replace(/\D/g, '').slice(-10), code = String(b.code || '').trim();
      if (tooMany(phone || req.socket.remoteAddress)) return send(res, 429, { error: 'Слишком много попыток, подождите 15 минут' });
      const u = S.users.find(x => x.phone && x.phone.replace(/\D/g, '').slice(-10) === phone && S.codes[x.id] && S.codes[x.id].code === code && S.codes[x.id].exp > Date.now());
      if (!u) return send(res, 401, { error: 'Неверный телефон или код. Код выдаёт менеджер клуба.' });
      await commit(newEvent(null, 'code_login', { uid: u.id }));
      return send(res, 200, { token: makeToken(u.id) });
    }

    if (url.pathname.startsWith('/api/')) {
      const uid = readToken((req.headers.authorization || '').replace(/^Bearer /, ''));
      if (!uid) return send(res, 401, { error: 'Нужно войти заново', relogin: true });
      if (req.method === 'GET' && url.pathname === '/api/state') return send(res, 200, CORE.view(S, uid, Date.now()));
      if (req.method === 'POST' && url.pathname === '/api/action') {
        const b = await body(req);
        const payload = b.payload || {};
        if (b.type === 'login_code') payload.code = String(crypto.randomInt(100000, 999999));
        if (['user_new', 'code_login'].includes(b.type)) return send(res, 400, { error: 'Недопустимое действие' });
        try {
          const r = await commit(newEvent(uid, b.type, payload, b.id));
          return send(res, 200, { ok: true, extra: r.extra || null, dup: !!r.dup, state: CORE.view(S, uid, Date.now()) });
        } catch (e) {
          if (e instanceof CORE.Refused) return send(res, 422, { error: e.message });
          throw e;
        }
      }
    }
    if (req.method === 'GET') return serveStatic(req, res);
    send(res, 404, { error: 'Не найдено' });
  } catch (e) {
    console.error(e);
    send(res, 500, { error: 'Ошибка сервера. Попробуйте ещё раз.' });
  }
});

(async () => {
  await store.init();
  const evs = await store.all();
  for (const ev of evs) { try { CORE.apply(S, ev); } catch (e) { console.error('replay', ev.type, e.message); S.applied[ev.id] = 1; } }
  ready = true;
  console.log('Журнал загружен: событий ' + evs.length + ', пользователей ' + S.users.length);
  server.listen(PORT, () => console.log('Castle Club слушает порт ' + PORT));
  setupBot();
})().catch(e => { console.error(e); process.exit(1); });
