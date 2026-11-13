// Castle Club — обработчик запросов (Web Request -> Response).
// Один и тот же код работает в Neon Functions, на Render и локально.
(function () {
'use strict';

function createHandler(opts) {
  const CORE = opts.core, store = opts.store, ASSETS = opts.assets || null;
  const SECRET = opts.secret;
  const SETUP_CODE = opts.setupCode || '';
  const fixedPublicUrl = (opts.publicUrl || '').replace(/\/$/, '');
  const appUrlOpt = (opts.appUrl || '').replace(/\/$/, '');
  const appUrl = pub => (appUrlOpt || pub) + '/';
  const enc = new TextEncoder();
  let S = CORE.initialState(), lastSeq = 0, initDone = null;
  const BOT = { token: opts.botToken || '', username: '', hooked: false };
  let lock = Promise.resolve();
  const serial = fn => { const r = lock.then(fn); lock = r.catch(() => {}); return r; };

  /* ---------- крипто (WebCrypto, есть и в Node, и в Neon) ---------- */
  const subtle = globalThis.crypto.subtle;
  const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  async function hmac(key, data) { const k = await subtle.importKey('raw', typeof key === 'string' ? enc.encode(key) : key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']); return subtle.sign('HMAC', k, enc.encode(data)); }
  async function sha256hex(s) { return hex(await subtle.digest('SHA-256', enc.encode(s))); }
  const safeEq = (a, b) => { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; };
  const uuid = () => globalThis.crypto.randomUUID();

  /* ---------- состояние из журнала ---------- */
  async function init() {
    if (!initDone) initDone = (async () => {
      await store.init();
      const t = await store.getKV('bot_token'); if (t && !opts.botToken) BOT.token = t;
      BOT.username = (await store.getKV('bot_username')) || '';
    })().catch(e => { initDone = null; throw e; });
    return initDone;
  }
  async function refresh() {
    const evs = await store.since(lastSeq);
    for (const ev of evs) {
      try { CORE.apply(S, ev); } catch (e) { S.applied[ev.id] = 1; console.error('replay', ev.type, e.message); }
      lastSeq = Math.max(lastSeq, Number(ev.seq));
    }
  }
  function commit(ev) {
    return serial(async () => {
      await refresh();
      if (S.applied[ev.id]) return { dup: true, out: [] };
      const tmp = structuredClone(S);
      const res = CORE.apply(tmp, ev); // бросит Refused, если нельзя
      await store.append(ev);
      await refresh();
      sendOut(res.out);
      if (!opts.waitUntil) await Promise.allSettled(pending.splice(0));
      return res;
    });
  }
  const newEvent = (uid, type, payload, id) => ({ id: id && /^[\w-]{8,64}$/.test(id) ? id : uuid(), ts: Date.now(), uid, type, payload: payload || {} });

  /* ---------- сессии ---------- */
  async function makeToken(uid) { const body = uid + '.' + Date.now(); return body + '.' + b64u(await hmac(SECRET, body)); }
  async function readToken(tok) {
    if (!tok) return null; const i = tok.lastIndexOf('.'); if (i < 0) return null;
    const body = tok.slice(0, i), sig = tok.slice(i + 1);
    if (!safeEq(sig, b64u(await hmac(SECRET, body)))) return null;
    const [uid, ts] = body.split('.');
    if (Date.now() - Number(ts) > 60 * CORE.DAY) return null;
    return CORE.U(S, uid) ? uid : null;
  }

  /* ---------- Telegram ---------- */
  async function checkInitData(initData) {
    if (!BOT.token || !initData) return null;
    const params = new URLSearchParams(initData);
    const hash = params.get('hash'); if (!hash) return null;
    params.delete('hash');
    const dataCheck = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => k + '=' + v).join('\n');
    const key = await hmac('WebAppData', BOT.token);
    if (!safeEq(hex(await hmac(key, dataCheck)), hash)) return null;
    if (Date.now() / 1000 - Number(params.get('auth_date') || 0) > 7 * 86400) return null;
    try { return JSON.parse(params.get('user')); } catch (e) { return null; }
  }
  async function tg(method, body, token) {
    const t = token || BOT.token; if (!t) return null;
    try { const r = await fetch('https://api.telegram.org/bot' + t + '/' + method, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }); return await r.json(); }
    catch (e) { console.error('telegram', method, e.message); return null; }
  }
  const pending = [];
  function sendOut(out) { (out || []).forEach(m => pending.push(tg('sendMessage', { chat_id: m.chat_id, text: m.text }))); if (opts.waitUntil) opts.waitUntil(Promise.allSettled(pending.splice(0))); }
  async function hookPath() { return '/tg/' + (await sha256hex('hook' + SECRET)).slice(0, 24); }
  async function setupBot(publicUrl) {
    if (!BOT.token || !publicUrl) return { ok: false };
    const me = await tg('getMe'); if (!me || !me.ok) return { ok: false, error: 'Telegram не принял токен' };
    BOT.username = me.result.username; await store.setKV('bot_username', BOT.username);
    const r = await tg('setWebhook', { url: publicUrl + await hookPath(), allowed_updates: ['message'] });
    await tg('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Клуб', web_app: { url: appUrl(publicUrl) } } });
    await tg('setMyCommands', { commands: [{ command: 'start', description: 'Открыть Castle Club' }] });
    await tg('setMyDescription', { description: 'Castle Club — покерный клуб (игра не на деньги, 18+). Запись на турниры, таймер, рейтинг.' });
    BOT.hooked = !!(r && r.ok);
    return { ok: BOT.hooked, username: BOT.username };
  }
  async function onUpdate(u, publicUrl) {
    const msg = u.message; if (!msg || !msg.chat) return;
    if (msg.text && msg.text.startsWith('/start')) {
      await tg('sendMessage', { chat_id: msg.chat.id,
        text: '🏰 Castle Club — покерный клуб (игра не на деньги, 18+).\n\nЗдесь можно записаться на турнир, следить за таймером, запросить ребай и посмотреть рейтинг. Нажмите кнопку ниже, чтобы открыть приложение.',
        reply_markup: { inline_keyboard: [[{ text: 'Открыть приложение', web_app: { url: appUrl(publicUrl) } }]] } });
    } else await tg('sendMessage', { chat_id: msg.chat.id, text: 'Всё управление — в приложении: кнопка «Клуб» внизу слева или команда /start.' });
  }

  /* ---------- HTTP ---------- */
  const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type, authorization', 'access-control-max-age': '86400' };
  const J = (code, obj) => new Response(JSON.stringify(obj), { status: code, headers: Object.assign({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, CORS) });
  const attempts = new Map();
  function tooMany(key) { const now = Date.now(); const a = (attempts.get(key) || []).filter(t => now - t < 15 * 60000); a.push(now); attempts.set(key, a); return a.length > 8; }
  const setupPage = () => `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Castle Club — настройка</title>
<style>body{margin:0;background:#0a0a0b;color:#f4efe5;font:16px Inter,system-ui,sans-serif}main{max-width:440px;margin:0 auto;padding:24px 16px}h1{color:#f2d892;font-size:24px}label{display:block;color:#a9a296;font-size:13px;margin:14px 0 6px}input{width:100%;box-sizing:border-box;background:#1c1a1e;border:1px solid #2c2930;border-radius:10px;padding:13px;color:#f4efe5;font-size:16px}button{width:100%;margin-top:18px;padding:14px;border-radius:12px;border:none;background:linear-gradient(180deg,#f2d892,#d8b45f);color:#1a1407;font-weight:700;font-size:16px}#r{margin-top:16px;line-height:1.5}a{color:#f2d892}</style></head>
<body><main><img src="/logo.svg" width="64" height="64" alt=""><h1>Подключение Telegram-бота</h1>
<p style="color:#a9a296">Вставьте токен бота из @BotFather (кнопка Copy) и код настройки. Токен сохранится только на сервере.</p>
<form id="f"><label for="c">Код настройки</label><input id="c" name="code" inputmode="numeric" required>
<label for="t">Токен бота</label><input id="t" name="token" required placeholder="123456789:AA...">
<button>Подключить</button></form><div id="r"></div></main>
<script>document.getElementById('f').onsubmit=async e=>{e.preventDefault();const f=new FormData(e.target);const r=document.getElementById('r');r.textContent='Проверяю…';
try{const x=await fetch('/api/setup',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:f.get('code'),token:f.get('token').trim()})});const j=await x.json();
if(!x.ok)throw new Error(j.error);r.innerHTML='✅ Бот @'+j.username+' подключён.<br><br><a href="https://t.me/'+j.username+'">Открыть бота</a> → «Открыть приложение». Первый, кто зарегистрируется, станет управляющим.';e.target.remove();}catch(err){r.textContent='❌ '+err.message;}};</script></body></html>`;

  return async function handle(request) {
    const url = new URL(request.url);
    const publicUrl = fixedPublicUrl || (opts.publicUrlFrom ? opts.publicUrlFrom(request) : url.origin);
    const p = url.pathname;
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    try {
      if (request.method === 'GET' && ASSETS && ASSETS[p === '/' ? '/index.html' : p]) {
        const a = ASSETS[p === '/' ? '/index.html' : p];
        return new Response(a.body, { headers: { 'content-type': a.type, 'cache-control': a.type.startsWith('text/html') ? 'no-cache' : 'public, max-age=300' } });
      }
      await init();
      if (p === '/health') { await refresh(); return J(200, { ok: true, users: S.users.length, events: lastSeq, bot: BOT.username || null }); }
      if (p === '/setup' && request.method === 'GET') return new Response(setupPage(), { headers: { 'content-type': 'text/html; charset=utf-8' } });
      if (p === '/api/setup' && request.method === 'POST') {
        const b = await request.json().catch(() => ({}));
        if (tooMany('setup')) return J(429, { error: 'Слишком много попыток, подождите 15 минут' });
        if (!SETUP_CODE || !safeEq(String(b.code || ''), SETUP_CODE)) return J(403, { error: 'Неверный код настройки' });
        const tok = String(b.token || '').trim();
        if (!/^\d+:[\w-]{30,}$/.test(tok)) return J(400, { error: 'Это не похоже на токен бота' });
        const me = await tg('getMe', {}, tok); if (!me || !me.ok) return J(400, { error: 'Telegram не принял этот токен' });
        BOT.token = tok; await store.setKV('bot_token', tok);
        const r = await setupBot(publicUrl);
        if (!r.ok) return J(500, { error: 'Не удалось подключить вебхук' });
        return J(200, { ok: true, username: r.username });
      }
      if (p === '/api/config') return J(200, { bot: BOT.username });
      if (BOT.token && !BOT.hooked && opts.autoHook !== false) { BOT.hooked = true; setupBot(publicUrl).catch(() => { BOT.hooked = false; }); }

      if (request.method === 'POST' && p === await hookPath()) {
        const u = await request.json().catch(() => ({}));
        const job = onUpdate(u, publicUrl).catch(e => console.error(e));
        if (opts.waitUntil) opts.waitUntil(job); else await job;
        return J(200, { ok: true });
      }
      if (request.method === 'POST' && p === '/api/auth/telegram') {
        const b = await request.json().catch(() => ({}));
        const tu = await checkInitData(b.initData);
        if (!tu) return J(401, { error: 'Не удалось проверить вход через Telegram' });
        const uid = 'g' + tu.id;
        await refresh();
        if (!CORE.U(S, uid)) await commit(newEvent(null, 'user_new', { uid, tg_id: tu.id, nick: tu.username || tu.first_name, name: [tu.first_name, tu.last_name].filter(Boolean).join(' ') }, 'u-' + uid));
        return J(200, { token: await makeToken(uid) });
      }
      if (request.method === 'POST' && p === '/api/auth/code') {
        const b = await request.json().catch(() => ({}));
        const phone = String(b.phone || '').replace(/\D/g, '').slice(-10), code = String(b.code || '').trim();
        if (tooMany('c' + phone)) return J(429, { error: 'Слишком много попыток, подождите 15 минут' });
        await refresh();
        const u = S.users.find(x => x.phone && x.phone.replace(/\D/g, '').slice(-10) === phone && S.codes[x.id] && S.codes[x.id].code === code && S.codes[x.id].exp > Date.now());
        if (!u) return J(401, { error: 'Неверный телефон или код. Код выдаёт менеджер клуба.' });
        await commit(newEvent(null, 'code_login', { uid: u.id }));
        return J(200, { token: await makeToken(u.id) });
      }
      if (p.startsWith('/api/')) {
        await refresh();
        const uid = await readToken((request.headers.get('authorization') || '').replace(/^Bearer /, ''));
        if (!uid) return J(401, { error: 'Нужно войти заново', relogin: true });
        if (request.method === 'GET' && p === '/api/state') return J(200, CORE.view(S, uid, Date.now()));
        if (request.method === 'POST' && p === '/api/action') {
          const b = await request.json().catch(() => ({}));
          const payload = b.payload || {};
          if (['user_new', 'code_login'].includes(b.type)) return J(400, { error: 'Недопустимое действие' });
          if (b.type === 'login_code') payload.code = String(100000 + (globalThis.crypto.getRandomValues(new Uint32Array(1))[0] % 900000));
          try {
            const r = await commit(newEvent(uid, b.type, payload, b.id));
            return J(200, { ok: true, extra: r.extra || null, dup: !!r.dup, state: CORE.view(S, uid, Date.now()) });
          } catch (e) {
            if (e instanceof CORE.Refused) return J(422, { error: e.message });
            throw e;
          }
        }
      }
      return J(404, { error: 'Не найдено' });
    } catch (e) {
      console.error(e);
      return J(500, { error: 'Ошибка сервера. Попробуйте ещё раз.' });
    }
  };
}
if (typeof module !== 'undefined') module.exports = { createHandler };
globalThis.CASTLE = Object.assign(globalThis.CASTLE || {}, { createHandler });
})();
