'use strict';
/* Castle Club — клиент. Один и тот же код работает в Telegram и в обычном браузере. */
const C = window.CORE;
const MIN = C.MIN, DAY = C.DAY;
const TGW = window.Telegram && window.Telegram.WebApp;
const IN_TG = !!(TGW && TGW.initData);
let BOT = '';
const API = (window.CC_API || '').replace(/\/$/, '');

let S = null, TOKEN = null, offset = 0;
const UI = { tab: {}, tid: null, ptid: null, table: 'all', sheet: null, full: null, loginErr: '' };
let pending = [];
try { TOKEN = localStorage.getItem('cc-token'); pending = JSON.parse(localStorage.getItem('cc-pending') || '[]'); } catch (e) {}
const savePending = () => { try { localStorage.setItem('cc-pending', JSON.stringify(pending)); } catch (e) {} };
const now = () => Date.now() + offset;
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12));

/* ---------- помощники поверх общей логики ---------- */
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const { fmt, rub, opName, ROLE_TITLES, PERMS, TEMPLATES, lvNo, lastPlay, POINTS } = C;
const meId = () => S.me.id;
const U = id => C.U(S, id);
const nick = id => C.nick(S, id);
const T = id => C.T(S, id);
const can = p => C.can(S, meId(), p);
const opsOf = (tid, pid) => C.opsOf(S, tid, pid);
const issued = (tid, pid) => C.issued(S, tid, pid);
const paid = (tid, pid) => C.paid(S, tid, pid);
const due = (tid, pid) => C.due(S, tid, pid);
const regOf = (tid, pid) => C.regOf(S, tid, pid);
const regsOf = tid => C.regsOf(S, tid);
const blocked = pid => C.blocked(S, pid);
const rating = () => C.rating(S);
const myRating = pid => rating().find(r => r.pid === pid);
const clockView = t => C.clockView(t, now());
const bonusBal = pid => S.bonus.filter(b => b.pid === pid).reduce((a, b) => a + b.amount, 0);
const playerDebts = pid => S.debts.filter(d => d.pid === pid && d.status !== 'closed');
const debtLeft = d => due(d.tid, d.pid);
const isStaff = () => S.me.role !== 'player';
const live = () => S.tournaments.find(t => t.stage === 'reg' || t.stage === 'closed');
const fmtDate = ts => new Date(ts).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
const hhmm = ts => new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
const isoDay = d => { const x = new Date(d); return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); };
function dayLabel(date) {
  if (!date) return '';
  const today = isoDay(now()), tomorrow = isoDay(now() + DAY);
  if (date === today) return 'Сегодня'; if (date === tomorrow) return 'Завтра';
  return new Date(date + 'T12:00').toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'short' });
}
const ruToIso = v => { const m = String(v || '').trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/); return m ? m[3] + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0') : String(v || ''); };
document.addEventListener('input', e => { const el = e.target; if (!el.dataset || el.dataset.mask !== 'date') return; const d = el.value.replace(/\D/g, '').slice(0, 8); el.value = d.length > 4 ? d.slice(0, 2) + '.' + d.slice(2, 4) + '.' + d.slice(4) : d.length > 2 ? d.slice(0, 2) + '.' + d.slice(2) : d; });
const dateRu = d => d ? d.split('-').reverse().join('.') : '';
const mmss = ms => { const s = Math.ceil(ms / 1000); return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); };
const blinds = L => L.brk ? 'Перерыв' : fmt(L.sb) + ' / ' + fmt(L.bb) + ' · анте ' + fmt(L.ante);
const brkText = v => v.L.brk ? 'Дальше: ' + blinds(v.next || v.L) : (v.hasBreak ? 'До перерыва ' + mmss(v.toBreak) : (v.isLast ? 'Последний уровень структуры' : 'Перерывов больше нет'));
const stageName = t => ({ plan: 'Запись открыта', reg: 'Идёт · регистрация открыта', closed: 'Идёт · регистрация закрыта', finished: 'Завершён' }[t.stage]);
const sortedT = () => S.tournaments.slice().sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));

/* ---------- сеть ---------- */
class NetErr extends Error {}
async function api(path, opts) {
  let r;
  try {
    r = await fetch(API + path, { method: opts && opts.body ? 'POST' : 'GET', headers: Object.assign({ 'content-type': 'application/json' }, TOKEN ? { authorization: 'Bearer ' + TOKEN } : {}), body: opts && opts.body ? JSON.stringify(opts.body) : undefined });
  } catch (e) { throw new NetErr('Нет связи с сервером'); }
  let j = {}; try { j = await r.json(); } catch (e) {}
  if (r.status === 401 && j.relogin) { logout(); throw new Error(j.error); }
  if (r.status >= 500 && r.status !== 503) throw new NetErr(j.error || 'Сервер недоступен');
  if (r.status === 503) throw new NetErr(j.error || 'Сервер запускается');
  if (!r.ok) throw new Error(j.error || 'Ошибка');
  return j;
}
function setState(v) { S = v; offset = v.now - Date.now(); }
async function load(quiet) {
  try { setState(await api('/api/state')); if (!quiet || canRerender()) render(); else tick(); }
  catch (e) { if (!quiet) { if (e instanceof NetErr) renderOffline(e.message); else render(); } }
}
async function act(type, payload, opts) {
  const ev = { id: uuid(), type, payload: payload || {} };
  try {
    const r = await api('/api/action', { body: ev });
    setState(r.state);
    if (!opts || !opts.keepSheet) UI.sheet = null;
    render();
    if (opts && opts.ok) toast(opts.ok);
    return r;
  } catch (e) {
    if (e instanceof NetErr && opts && opts.queue) {
      pending.push(ev); savePending(); UI.sheet = null; render();
      toast('Нет связи — сохранено на телефоне, отправим автоматически');
      return { queued: true };
    }
    toast(e.message);
    return null;
  }
}
let flushing = false;
async function flush() {
  if (flushing || !pending.length || !TOKEN) return;
  flushing = true;
  try {
    while (pending.length) {
      const ev = pending[0];
      try { const r = await api('/api/action', { body: ev }); setState(r.state); pending.shift(); savePending(); }
      catch (e) { if (e instanceof NetErr) break; toast('Не принято сервером: ' + e.message); pending.shift(); savePending(); }
    }
  } finally { flushing = false; if (S) { canRerender() ? render() : tick(); } }
}
function logout() { TOKEN = null; S = null; try { localStorage.removeItem('cc-token'); } catch (e) {} }
function canRerender() {
  const a = document.activeElement;
  return !UI.sheet && !(a && /INPUT|SELECT|TEXTAREA/.test(a.tagName));
}

/* ---------- общие блоки ---------- */
function clockCard(t, controls) {
  const v = clockView(t);
  return `<div class="card gold">
    <div class="between"><span class="live">${t.stage === 'reg' || t.stage === 'closed' ? '● ИДЁТ СЕЙЧАС' : ''}</span>
      <button class="btn ghost sm" data-act="full" data-tid="${t.id}">На весь экран</button></div>
    <div class="clock" style="margin-top:6px">
      <div><div class="lbl">Сейчас</div>
        <div style="font-size:20px;font-weight:700" data-clk="lvl" data-tid="${t.id}">${v.L.brk ? 'Перерыв' : 'Уровень ' + v.no}</div>
        <div class="mut small" data-clk="bl" data-tid="${t.id}">${blinds(v.L)}</div>
        <div class="mut small" data-clk="brk" data-tid="${t.id}">${brkText(v)}</div></div>
      <div class="tm ${v.running ? '' : 'paused'}" data-clk="tm" data-tid="${t.id}">${mmss(v.rem)}</div>
    </div>
    ${controls ? `<div class="row" style="margin-top:12px;gap:8px">
      <button class="btn dark sm" data-act="do" data-type="clk_prev" data-tid="${t.id}">◀ Уровень</button>
      <button class="btn sm" style="flex:1" data-act="do" data-type="clk_toggle" data-tid="${t.id}">${v.running ? 'Пауза' : 'Запустить'}</button>
      <button class="btn dark sm" data-act="do" data-type="clk_next" data-tid="${t.id}">Уровень ▶</button></div>
    <div class="row" style="margin-top:8px;gap:8px">
      <button class="btn dark sm" data-act="do" data-type="clk_add" data-m="-1" data-tid="${t.id}">−1 мин</button>
      <button class="btn dark sm" data-act="do" data-type="clk_add" data-m="1" data-tid="${t.id}">+1 мин</button>
      <button class="btn ghost sm" style="flex:1" data-act="sheet" data-k="struct" data-tk="t" data-sid="${t.id}">Структура уровней</button></div>
    ${v.isLast ? `<div class="lock" style="border-color:#7a3134;color:var(--red)">Идёт последний уровень структуры. Добавьте уровни в «Структуре».</div>` : ''}` : ''}
  </div>`;
}
function tChips(sel, act, filter) {
  const list = sortedT().filter(filter || (() => true));
  if (!list.length) return '';
  return `<div class="who" style="padding:0 0 10px">${list.map(t =>
    `<button class="chip ${t.id === sel ? 'on' : ''}" data-act="${act}" data-tid="${t.id}">${esc(t.title)} · ${dayLabel(t.date)}</button>`).join('')}</div>`;
}
function stChip(o) {
  if (o.status === 'requested') return '<span class="st req">Запрошен</span>';
  if (o.status === 'issued') return '<span class="st ok">Выдан</span>';
  if (o.status === 'rejected') return '<span class="st no">Отклонён</span>';
  return '<span class="st no">Отменён</span>';
}
const avatar = id => `<div class="av">${esc((nick(id)[0] || '?').toUpperCase())}</div>`;
function header(sub) {
  const unread = S.notes.filter(n => !n.read).length;
  return `<div class="brand"><img src="logo.svg" alt="Castle Club">
    <div><div class="t">CASTLE CLUB</div><div class="s">${sub}</div></div>
    <button class="bell" data-act="sheet" data-k="notes" aria-label="Уведомления">🔔${unread ? `<span class="badge">${unread}</span>` : ''}</button></div>
    ${pending.length ? `<div class="lock" style="border-color:#6b4a18;color:var(--amber);margin:-4px 0 12px">Не отправлено действий: ${pending.length}. Отправим, как только появится связь.</div>` : ''}`;
}

/* ---------- вход ---------- */
function loginView() {
  return `<main><div class="brand"><img src="logo.svg" alt="Castle Club"><div><div class="t">CASTLE CLUB</div><div class="s">Покерный клуб · игра не на деньги · 18+</div></div></div>
  ${BOT ? `<div class="card gold"><b>Удобнее всего — через Telegram</b><div class="small mut" style="margin-top:6px">Откройте бота и нажмите «Открыть приложение». Вход произойдёт автоматически.</div>
    <a class="btn wide" style="display:block;text-align:center;text-decoration:none;margin-top:12px" href="https://t.me/${BOT}">Открыть @${BOT}</a></div>` : ''}
  <form class="card" data-form="codeLogin"><b>Нет Telegram? Вход по коду</b>
    <div class="small mut" style="margin-top:4px">Код на 24 часа выдаёт менеджер клуба.</div>
    <label class="f" for="lp">Телефон</label><input id="lp" type="tel" name="phone" placeholder="+7 ..." required autocomplete="tel">
    <label class="f" for="lc">Код</label><input id="lc" type="text" name="code" inputmode="numeric" maxlength="6" required>
    ${UI.loginErr ? `<div class="lock" style="color:var(--red)">${esc(UI.loginErr)}</div>` : ''}
    <button class="btn wide" style="margin-top:12px">Войти</button></form></main>`;
}
function onboarding() {
  const me = S.me;
  return `<main>${header('Регистрация')}
  <div class="card gold"><h2 class="big">Добро пожаловать</h2><div class="small mut" style="margin-top:6px">Пара полей — и можно записываться на игры.</div></div>
  <form class="card" data-form="profile">
    <label class="f" for="ob-name">Имя</label><input id="ob-name" type="text" name="name" value="${esc(me.name || '')}" required>
    <label class="f" for="ob-nick">Ник в клубе</label><input id="ob-nick" type="text" name="nick" value="${esc(me.nick || '')}" required>
    <label class="f" for="ob-phone">Телефон</label>
    <div class="row"><input id="ob-phone" type="tel" name="phone" placeholder="+7 ..." value="${esc(me.phone || '')}" required>${IN_TG && TGW.requestContact ? '<button type="button" class="btn dark sm" data-act="sharePhone">Поделиться</button>' : ''}</div>
    <label class="f" for="ob-dob">Дата рождения</label><input id="ob-dob" type="text" name="dob" inputmode="numeric" placeholder="ДД.ММ.ГГГГ" maxlength="10" data-mask="date" value="${esc(dateRu(me.dob || ''))}" required>
    <div class="small mut" style="margin-top:4px">Клуб принимает игроков с 18 лет. Изменить дату потом можно только через управляющего.</div>
    <label class="row small" style="margin-top:12px;gap:10px"><input id="ob-pd" type="checkbox" name="pd" required style="width:22px;height:22px;accent-color:var(--gold)"> Согласен(на) на обработку персональных данных и с правилами клуба</label>
    <button class="btn wide" style="margin-top:14px">Зарегистрироваться</button>
    ${S.me.role === 'owner' ? '<div class="lock">Вы первый пользователь — вам автоматически выдана роль управляющего.</div>' : ''}
  </form></main>`;
}

/* ---------- игрок ---------- */
function playerView() {
  const tab = UI.tab.p || 'home';
  const body = tab === 'home' ? pHome() : tab === 'game' ? pGame() : pProfile();
  const nav = `<nav class="nav">${[['home', 'Главная'], ['game', 'Игра'], ['profile', 'Профиль']].map(([k, l]) =>
    `<button class="${tab === k ? 'on' : ''}" data-act="ptab" data-k="${k}">${l}</button>`).join('')}</nav>`;
  return `<main>${header('Покер не на деньги · 18+')}${body}</main>${nav}`;
}
function debtBanner(pid) {
  const ds = playerDebts(pid); if (!ds.length) return '';
  const sum = ds.reduce((a, d) => a + debtLeft(d), 0); const open = ds.some(d => d.status === 'open');
  return `<div class="card warn"><div class="between"><b>Долг клубу: <span class="due">${rub(sum)}</span></b>${open ? '<span class="st debt">Не согласован</span>' : '<span class="st appr">Перенос согласован</span>'}</div>
    <div class="small mut" style="margin-top:6px">${open ? 'Запись на новые игры закрыта, пока долг не оплачен или управляющий не согласует перенос.' : 'Срок оплаты: ' + esc(dateRu((ds.find(d => d.until) || {}).until)) + '. Оплатите менеджеру.'}</div></div>`;
}
function pHome() {
  const me = S.me; const r = myRating(me.id);
  const lt = live(); const next = sortedT().filter(t => t.stage === 'plan');
  const top = rating().slice(0, 5);
  return `<div style="margin-bottom:12px"><div class="mut small">Добрый вечер,</div><h2 style="font-size:22px">${esc(me.name || me.nick)}</h2></div>
  ${debtBanner(me.id)}
  <div class="grid3" style="margin-bottom:12px">
    <div class="stat"><b>${r ? '#' + r.place : '—'}</b><span>место</span></div>
    <div class="stat"><b>${r ? fmt(r.pts) : 0}</b><span>очки</span></div>
    <div class="stat"><b style="color:var(--gold2)">${fmt(bonusBal(me.id))}</b><span>бонусы</span></div></div>
  ${lt ? `<div class="card gold" data-act="openGame" data-tid="${lt.id}" style="cursor:pointer">
     <div class="between"><span class="live">● ИДЁТ СЕЙЧАС</span><span class="small mut">${regsOf(lt.id).length} записано</span></div>
     <div class="between" style="margin-top:6px"><div><div class="big">${esc(lt.title)}</div><div class="small mut" data-clk="bl" data-tid="${lt.id}">${blinds(clockView(lt).L)}</div></div>
       <div class="big" style="font-size:30px" data-clk="tm" data-tid="${lt.id}">${mmss(clockView(lt).rem)}</div></div>
     <div class="small" style="margin-top:8px;color:var(--gold2)">${regOf(lt.id, me.id) ? (regOf(lt.id, me.id).status === 'arrived' ? 'Вы в игре' + (regOf(lt.id, me.id).table ? ' · стол ' + esc(regOf(lt.id, me.id).table) : '') : 'Вы записаны') : 'Поздняя регистрация до ' + lt.lateReg} →</div></div>` : ''}
  <div class="sec"><span>Расписание</span></div>
  <div class="card list sched">${next.map(t => `<div class="it" data-act="openGame" data-tid="${t.id}">
     <div style="width:78px" class="small mut">${dayLabel(t.date)}<br><b style="color:var(--text);font-size:15px">${t.time}</b></div>
     <div class="grow"><div class="nick">${esc(t.title)}</div><div class="small mut">Вход ${rub(t.entry)} · стек ${fmt(t.stack)}</div></div>
     ${regOf(t.id, me.id) ? '<span class="st ok">Записан</span>' : '<span class="mut">›</span>'}</div>`).join('') || '<div class="empty">Скоро здесь появятся игры</div>'}</div>
  <div class="sec"><span>Рейтинг</span></div>
  <div class="card list">${top.map(x => `<div class="it"><b style="width:26px;color:var(--gold2)">${String(x.place).padStart(2, '0')}</b><div class="grow">${esc(nick(x.pid))}${x.pid === me.id ? ' <span class="tag">вы</span>' : ''}</div><b>${fmt(x.pts)}</b></div>`).join('') || '<div class="empty">Рейтинг появится после первой игры</div>'}</div>`;
}
function pGame() {
  const me = S.me;
  const t = T(UI.ptid) || live() || sortedT().find(x => x.stage === 'plan');
  if (!t) return '<div class="empty">Пока нет игр в расписании</div>';
  const reg = regOf(t.id, me.id); const running = t.stage === 'reg' || t.stage === 'closed';
  const my = opsOf(t.id, me.id).filter(o => o.status !== 'cancelled');
  const d = due(t.id, me.id);
  const addons = my.filter(o => o.type === 'addon' && o.status !== 'rejected').length;
  let action = '';
  if (t.stage === 'finished') action = '<div class="empty">Турнир завершён</div>';
  else if (!reg) action = t.stage === 'closed' ? '<div class="lock">Регистрация закрыта</div>' : `<button class="btn wide" data-act="do" data-type="reg" data-tid="${t.id}" data-ok="Вы записаны">Записаться</button>${blocked(me.id) ? '<div class="lock">Есть несогласованный долг — запись будет отклонена</div>' : ''}`;
  else if (reg.status === 'registered') action = `<div class="card"><b>Вы записаны</b><div class="small mut" style="margin-top:4px">${running ? 'Подойдите к менеджеру — он отметит приход и выдаст стек.' : 'Мы пришлём напоминание в Telegram.'}</div>
     <button class="btn red sm" style="margin-top:10px" data-act="do" data-type="unreg" data-tid="${t.id}" data-ok="Запись отменена">Отменить запись</button></div>`;
  else if (t.stage === 'reg') action = `<div class="grid2">
     <button class="btn" data-act="sheet" data-k="req" data-type="rebuy" data-tid="${t.id}">Запросить ребай</button>
     <button class="btn ghost" data-act="sheet" data-k="req" data-type="addon" data-tid="${t.id}" ${addons >= t.addonMax ? 'disabled' : ''}>Запросить аддон</button></div>
     <div class="small mut" style="margin-top:8px">Дилер выдаст фишки и отметит выдачу. Оплатить можно дилеру за столом или в кассе до ${t.lateReg}.</div>`;
  else action = '<div class="lock">Регистрация и аддон закрыты — ребаи больше не выдаются</div>';
  const L = t.levels; const from = running ? clockView(t).lvl : 0;
  return `${tChips(t.id, 'openGame', x => x.stage !== 'finished')}
  <div class="lbl" style="color:${running ? 'var(--red)' : 'var(--mut)'}">${stageName(t)}</div>
  <h2 class="big" style="font-size:28px;margin:4px 0 2px">${esc(t.title)}</h2>
  <div class="mut small" style="margin-bottom:12px">${dayLabel(t.date)} · старт ${t.time}${reg && reg.table ? ' · стол ' + esc(reg.table) + (reg.box ? ', бокс ' + esc(reg.box) : '') : ''}</div>
  ${running ? clockCard(t, false) : ''}
  <div class="grid2" style="margin-bottom:12px">
    <div class="stat"><span>Вход</span><b>${rub(t.entry)}</b><span>${fmt(t.stack)} фишек${S.me.first ? ' · первый — бесплатно' : ''}</span></div>
    <div class="stat"><span>Поздняя рег.</span><b>до ${t.lateReg}</b></div>
    <div class="stat"><span>Ребай</span><b>${rub(t.rebuy)}</b><span>${fmt(t.rebuyChips)} фишек · до ×${t.maxMult}</span></div>
    <div class="stat"><span>Аддон</span><b>${rub(t.addon)}</b><span>${fmt(t.addonChips)} фишек · до ${t.addonMax} за игру</span></div></div>
  ${action}
  ${reg && reg.status === 'arrived' ? `<div class="sec"><span>Мои операции</span>${d ? `<span class="due">К оплате ${rub(d)}</span>` : '<span class="st paid">Всё оплачено</span>'}</div>
  <div class="card list">${my.map(o => `<div class="it"><div class="grow"><div class="nick">${opName(o)}</div><div class="small mut">${hhmm(o.ts)} · ${fmt(o.chips)} фишек${o.note ? ' · ' + esc(o.note) : ''}</div></div><b>${rub(o.amount)}</b> ${stChip(o)}</div>`).join('') || '<div class="empty">Пока нет операций</div>'}</div>` : ''}
  <div class="sec"><span>Структура · ${esc(t.structTitle || '')}</span></div>
  <div class="card list">${L.slice(from, from + 6).map((l, j) => `<div class="it" style="${running && j === 0 ? 'color:var(--gold2)' : ''}"><b style="width:52px">${l.brk ? 'Пер.' : 'Ур. ' + lvNo(L, from + j)}</b><div class="grow">${l.brk ? 'Перерыв' : fmt(l.sb) + ' / ' + fmt(l.bb) + ' · анте ' + fmt(l.ante)}</div><span class="small mut">${l.dur} мин</span></div>`).join('')}</div>
  <div class="sec"><span>Участники · ${regsOf(t.id).length}</span></div>
  <div class="card"><div class="pl">${regsOf(t.id).map(r => `<span class="tag">${esc(nick(r.pid))}</span>`).join('') || '<span class="mut small">Пока никого</span>'}</div></div>`;
}
function pProfile() {
  const me = S.me; const res = S.results.filter(r => r.pid === me.id);
  const best = res.length ? Math.min(...res.map(r => r.place)) : '—';
  const avg = res.length ? (res.reduce((a, r) => a + r.place, 0) / res.length).toFixed(1) : '—';
  const r = myRating(me.id);
  return `<div class="card gold"><div class="lbl">Карта игрока · Castle Club</div><div class="big" style="font-size:26px;margin:6px 0">${esc(me.nick)}</div><div class="small mut">${esc(me.phone || '')}</div></div>
  ${debtBanner(me.id)}
  <div class="grid3"><div class="stat"><b>${res.length}</b><span>игр</span></div><div class="stat"><b>${best}</b><span>лучшее место</span></div><div class="stat"><b>${avg}</b><span>среднее место</span></div>
    <div class="stat"><b>${r ? '#' + r.place : '—'}</b><span>в рейтинге</span></div><div class="stat"><b>${r ? r.pts : 0}</b><span>очки</span></div><div class="stat"><b>${res.filter(x => x.place <= 3).length}</b><span>топ-3</span></div></div>
  <div class="sec"><span>Последние игры</span></div>
  <div class="card list">${res.slice().reverse().map(x => { const t = T(x.tid) || {}; return `<div class="it"><div class="grow"><div class="nick">${esc(t.title)}</div><div class="small mut">${dateRu(t.date)}</div></div><div style="text-align:right"><b>${x.place} место</b><div class="small" style="color:var(--gold2)">+${x.points} очков</div></div></div>`; }).join('') || '<div class="empty">Ещё не играли</div>'}</div>
  <div class="sec"><span>Бонусы · ${fmt(bonusBal(me.id))}</span></div>
  <div class="card list">${S.bonus.filter(b => b.pid === me.id).slice().reverse().map(b => `<div class="it"><div class="grow">${esc(b.reason)}<div class="small mut">${fmtDate(b.ts)}</div></div><b style="color:${b.amount > 0 ? 'var(--green)' : 'var(--red)'}">${b.amount > 0 ? '+' : ''}${fmt(b.amount)}</b></div>`).join('') || '<div class="empty">Бонусов пока нет</div>'}</div>
  <button class="btn ghost wide" style="margin-top:12px" data-act="sheet" data-k="editProfile">Изменить профиль</button>
  ${IN_TG ? '' : '<button class="btn dark wide" style="margin-top:8px" data-act="logout">Выйти</button>'}`;
}

/* ---------- персонал ---------- */
function staffTabs() {
  const tabs = []; const pend = S.ops.filter(o => o.status === 'requested').length; const openD = S.debts.filter(d => d.status === 'open').length;
  if (can('roles')) tabs.push(['sum', 'Сводка']);
  if (can('issue') && !can('checkin')) tabs.push(['req', 'Запросы', pend], ['table', 'Мой стол'], ['clock', 'Таймер']);
  if (can('checkin') || can('tournaments')) tabs.push(['tour', 'Турнир', pend]);
  if (can('payments') || can('reports')) tabs.push(['cash', 'Касса']);
  if (can('payments') || can('debt_approve')) tabs.push(['debts', 'Долги', openD]);
  if (can('checkin')) tabs.push(['players', 'Игроки']);
  if (can('bonus')) tabs.push(['bonus', 'Бонусы']);
  if (can('structures')) tabs.push(['struct', 'Структуры']);
  if (can('roles')) tabs.push(['roles', 'Роли']);
  if (can('reports')) tabs.push(['log', 'Журнал']);
  tabs.push(['me', 'Я игрок']);
  return tabs;
}
function staffView() {
  const tabs = staffTabs();
  let tab = UI.tab.s; if (!tabs.find(t => t[0] === tab)) tab = tabs[0][0]; UI.tab.s = tab;
  const tabBar = `<div class="tabs" style="padding:0 0 12px">${tabs.map(([k, l, b]) => `<button class="tab ${tab === k ? 'on' : ''}" data-act="stab" data-k="${k}">${l}${b ? `<span class="badge">${b}</span>` : ''}</button>`).join('')}</div>`;
  const R = { sum: sSummary, req: dRequests, table: dTable, clock: dClock, tour: mTour, cash: mCash, debts: mDebts, players: mPlayers, bonus: mBonus, struct: mStructs, roles: oRoles, log: mLog, me: meAsPlayer };
  return `<main>${header(ROLE_TITLES[S.me.role] + ' · ' + esc(S.me.nick))}${tabBar}${R[tab]()}</main>`;
}
function meAsPlayer() {
  const k = UI.tab.mp || 'home';
  return `<div class="seg" style="margin-bottom:12px">${[['home', 'Главная'], ['game', 'Игра'], ['profile', 'Профиль']].map(([v, l]) => `<label><input type="radio" name="mp" ${k === v ? 'checked' : ''} data-act="mptab" data-k="${v}"><span>${l}</span></label>`).join('')}</div>${k === 'home' ? pHome() : k === 'game' ? pGame() : pProfile()}`;
}
const curT = () => T(UI.tid) || live() || sortedT().filter(t => t.stage !== 'finished')[0] || sortedT().slice(-1)[0];
const dT = () => { const t = curT(); return t && (t.stage === 'reg' || t.stage === 'closed') ? t : (live() || t); };
const noT = '<div class="empty">Турниров пока нет. Создайте первый во вкладке «Турнир».</div>';
function reqItem(o) {
  const r = regOf(o.tid, o.pid) || {};
  return `<div class="it">${avatar(o.pid)}<div class="grow"><div class="nick">${esc(nick(o.pid))} — ${opName(o)}</div>
    <div class="small mut">${fmt(o.chips)} фишек · ${rub(o.amount)} · стол ${esc(o.table || r.table || '—')}, бокс ${esc(o.box || r.box || '—')} · ${hhmm(o.ts)}</div></div>
    <div class="row" style="gap:6px"><button class="btn sm" data-act="do" data-type="issue_req" data-opid="${o.id}" data-q="1" data-ok="Выдано">Выдать</button><button class="btn red sm" data-act="do" data-type="reject_req" data-opid="${o.id}" aria-label="Отклонить">✕</button></div></div>`;
}
function dRequests() {
  const t = dT(); if (!t) return noT;
  const pend = S.ops.filter(o => o.status === 'requested' && o.tid === t.id);
  return `${tChips(t.id, 'selT', x => x.stage === 'reg' || x.stage === 'closed')}
  <div class="sec"><span>Запросы игроков</span><span>${pend.length}</span></div>
  <div class="card list">${pend.map(reqItem).join('') || '<div class="empty">Новых запросов нет</div>'}</div>
  <div class="lock">Выдали фишки → «Выдать». Деньги принимает менеджер, у дилера только отметка выдачи.</div>`;
}
const canCancel = o => o.status === 'issued' && (can('cancel_op') || (o.by === meId() && now() - o.ts < 5 * MIN));
function opRow(o) {
  return `<div class="it"><div class="grow"><div class="nick">${esc(nick(o.pid))} — ${opName(o)}</div>
    <div class="small mut">${hhmm(o.ts)} · ${rub(o.amount)} · ${o.by ? 'выдал ' + esc(nick(o.by)) : 'ждёт дилера'}${o.reqBy === 'player' ? ' · из приложения' : ''}${o.cancelReason ? ' · причина: ' + esc(o.cancelReason) : ''}</div></div>
    ${stChip(o)} ${canCancel(o) ? `<button class="btn red sm" data-act="sheet" data-k="cancel" data-id="${o.id}">Отменить</button>` : ''}</div>`;
}
function dTable() {
  const t = dT(); if (!t) return noT;
  const rs = regsOf(t.id).filter(r => r.status === 'arrived' && (UI.table === 'all' || r.table === UI.table));
  const tables = [...new Set(regsOf(t.id).map(r => r.table).filter(Boolean))].sort();
  const myOps = S.ops.filter(o => o.tid === t.id && o.by === meId() && o.type !== 'entry').slice(-6).reverse();
  return `${tChips(t.id, 'selT', x => x.stage === 'reg' || x.stage === 'closed')}
  <div class="seg" style="margin-bottom:10px">${['all', ...tables].map(k => `<label><input type="radio" name="tbl" ${UI.table === k ? 'checked' : ''} data-act="selTable" data-k="${esc(k)}"><span>${k === 'all' ? 'Все столы' : 'Стол ' + esc(k)}</span></label>`).join('')}</div>
  ${t.stage !== 'reg' ? '<div class="lock" style="margin-bottom:10px">Регистрация закрыта — ребаи и аддоны больше не выдаются</div>' : ''}
  <div class="card list">${rs.map(r => {
    const os = opsOf(t.id, r.pid).filter(o => o.status === 'issued');
    const rb = os.filter(o => o.type === 'rebuy').reduce((a, o) => a + o.mult, 0), ad = os.filter(o => o.type === 'addon').length; const d = due(t.id, r.pid);
    return `<div class="it">${avatar(r.pid)}<div class="grow"><div class="nick">${esc(nick(r.pid))} <span class="tag">ст.${esc(r.table || '—')} · б.${esc(r.box || '—')}</span></div>
      <div class="small mut">Ребаев ${rb} · аддонов ${ad} ${d ? `· <span class="due">должен ${rub(d)}</span>` : '· оплачено'}</div></div>
      <button class="btn sm" data-act="sheet" data-k="issue" data-pid="${r.pid}" data-tid="${t.id}" ${t.stage !== 'reg' ? 'disabled' : ''}>Выдать</button></div>`;
  }).join('') || '<div class="empty">Нет игроков</div>'}</div>
  <div class="sec"><span>Мои последние выдачи</span></div>
  <div class="card list">${myOps.map(opRow).join('') || '<div class="empty">Пока нет</div>'}</div>
  <div class="lock">Свою выдачу можно отменить в течение 5 минут (с причиной). Позже — только менеджер.</div>`;
}
function dClock() { const t = dT(); if (!t) return noT; return `${tChips(t.id, 'selT', x => x.stage === 'reg' || x.stage === 'closed')}${clockCard(t, can('clock'))}${can('clock') ? '' : `<button class="btn ghost wide" data-act="sheet" data-k="struct" data-tk="t" data-sid="${t.id}">Структура уровней</button>`}`; }

function mTour() {
  const t = curT();
  const head = `<div class="between" style="margin-bottom:10px"><div class="lbl">Турниры</div>${can('tournaments') ? '<button class="btn ghost sm" data-act="sheet" data-k="newT">＋ Новый турнир</button>' : ''}</div>`;
  if (!t) return head + '<div class="empty">Турниров пока нет</div>';
  const pend = S.ops.filter(o => o.status === 'requested' && o.tid === t.id);
  const rs = regsOf(t.id); const running = t.stage === 'reg' || t.stage === 'closed';
  const notReg = S.users.filter(u => u.role === 'player' && u.profileDone && !regOf(t.id, u.id));
  return `${head}${tChips(t.id, 'selT')}
  <div><div class="big">${esc(t.title)}</div><div class="small mut">${dateRu(t.date)} · ${t.time} · ${stageName(t)}</div></div>
  ${running ? clockCard(t, can('clock')) : `<div class="card between" style="margin-top:10px"><div><div class="lbl">Структура уровней</div><div class="small" style="margin-top:4px">${esc(t.structTitle || '')}</div></div><button class="btn ghost sm" data-act="sheet" data-k="struct" data-tk="t" data-sid="${t.id}">${t.stage === 'finished' ? 'Смотреть' : 'Настроить'}</button></div>`}
  ${can('tournaments') ? `<div style="margin:6px 0">
     ${t.stage === 'plan' ? `<button class="btn wide" data-act="do" data-type="tour_start" data-tid="${t.id}" data-ok="Турнир начат, таймер запущен">Начать турнир</button>` : ''}
     ${t.stage === 'reg' ? `<button class="btn wide" data-act="sheet" data-k="closeReg" data-tid="${t.id}">Закрыть регистрацию и аддон</button>` : ''}
     ${t.stage === 'closed' ? `<button class="btn wide" data-act="sheet" data-k="results" data-tid="${t.id}">Завершить и внести места</button>` : ''}</div>` : ''}
  ${pend.length ? `<div class="sec"><span>Запросы на ребай/аддон</span><span class="badge">${pend.length}</span></div><div class="card list">${pend.map(reqItem).join('')}</div>` : ''}
  <div class="sec"><span>Игроки · ${rs.length} записано · ${rs.filter(r => r.status === 'arrived').length} пришли</span></div>
  <div class="card list">${rs.map(r => { const d = due(t.id, r.pid); const u = U(r.pid) || {};
    return `<div class="it">${avatar(r.pid)}<div class="grow"><div class="nick">${esc(nick(r.pid))}${u.first ? ' <span class="tag">первый визит</span>' : ''}${blocked(r.pid) ? ' <span class="st debt">долг</span>' : ''}</div>
      <div class="small mut">${r.status === 'arrived' ? 'В игре · ст.' + esc(r.table || '—') + ' б.' + esc(r.box || '—') + (d ? ' · <span class="due">к оплате ' + rub(d) + '</span>' : ' · оплачено') : 'Записан, ещё не пришёл'}</div></div>
      ${r.status === 'arrived' ? (t.stage === 'reg' && can('issue') ? `<button class="btn dark sm" data-act="sheet" data-k="issue" data-pid="${r.pid}" data-tid="${t.id}">Выдать</button>` : '')
        : (t.stage === 'reg' && can('checkin') ? `<button class="btn sm" data-act="sheet" data-k="checkin" data-pid="${r.pid}" data-tid="${t.id}">Пришёл</button>` : '')}</div>`; }).join('') || '<div class="empty">Пока никто не записался</div>'}</div>
  ${can('checkin') && t.stage !== 'finished' && notReg.length ? `<form class="card" data-form="walkin" data-tid="${t.id}"><b>Добавить игрока без записи</b>
    <label class="f" for="wi">Игрок</label><select id="wi" name="pid">${notReg.map(u => `<option value="${u.id}">${esc(u.nick)}</option>`).join('')}</select>
    <button class="btn dark wide" style="margin-top:10px">Добавить в турнир</button></form>` : ''}`;
}
function mCash() {
  const t = curT(); if (!t) return noT;
  const ops = opsOf(t.id).filter(o => o.status === 'issued');
  const sum = k => ops.filter(o => o.type === k).reduce((a, o) => a + o.amount, 0);
  const cnt = k => ops.filter(o => o.type === k).reduce((a, o) => a + (k === 'rebuy' ? o.mult : 1), 0);
  const pays = S.pays.filter(p => p.tid === t.id); const by = m => pays.filter(p => p.method === m).reduce((a, p) => a + p.amount, 0);
  const rs = regsOf(t.id).filter(r => r.status === 'arrived').sort((a, b) => due(t.id, b.pid) - due(t.id, a.pid));
  const staff = S.users.filter(u => u.role !== 'player');
  return `${tChips(t.id, 'selT')}
  <div class="grid3"><div class="stat"><span>Выдано</span><b>${rub(issued(t.id))}</b></div><div class="stat"><span>Оплачено</span><b style="color:var(--green)">${rub(paid(t.id))}</b></div><div class="stat"><span>Не оплачено</span><b class="due">${rub(Math.max(0, issued(t.id) - paid(t.id)))}</b></div></div>
  <div class="card" style="margin-top:10px"><div class="perm"><span>Входы · ${cnt('entry')}</span><b>${rub(sum('entry'))}</b></div><div class="perm"><span>Ребаи · ${cnt('rebuy')}</span><b>${rub(sum('rebuy'))}</b></div><div class="perm" style="border:none"><span>Аддоны · ${cnt('addon')}</span><b>${rub(sum('addon'))}</b></div>
    <div class="small mut" style="margin-top:6px">Наличные ${rub(by('Наличные'))} · Карта ${rub(by('Карта'))} · Перевод ${rub(by('Перевод'))}</div></div>
  <div class="sec"><span>Расчёт с игроками</span></div>
  <div class="card list">${rs.map(r => { const d = due(t.id, r.pid); return `<div class="it">${avatar(r.pid)}<div class="grow"><div class="nick">${esc(nick(r.pid))}</div><div class="small mut">Выдано ${rub(issued(t.id, r.pid))} · оплачено ${rub(paid(t.id, r.pid))}</div></div>
    ${d ? (can('payments') ? `<button class="btn sm" data-act="sheet" data-k="pay" data-pid="${r.pid}" data-tid="${t.id}">Принять ${rub(d)}</button>` : `<span class="due">${rub(d)}</span>`) : '<span class="st paid">Оплачено</span>'}</div>`; }).join('') || '<div class="empty">Нет игроков в игре</div>'}</div>
  <div class="sec"><span>Выдачи по сотрудникам</span></div>
  <div class="card">${staff.map(u => { const os = ops.filter(o => o.by === u.id); return `<div class="perm"><span>${esc(u.nick)} <span class="tag">${ROLE_TITLES[u.role]}</span></span><span>${os.length} опер. · <b>${rub(os.reduce((a, o) => a + o.amount, 0))}</b></span></div>`; }).join('')}</div>
  <div class="sec"><span>Все операции турнира</span></div>
  <div class="card list">${opsOf(t.id).slice().reverse().map(opRow).join('') || '<div class="empty">Операций нет</div>'}</div>`;
}
function mDebts() {
  const list = S.debts.slice().sort((a, b) => (a.status === 'closed') - (b.status === 'closed') || b.ts - a.ts);
  return `<div class="lock" style="margin:0 0 12px">Долг попадает сюда автоматически, если игрок не рассчитался к закрытию регистрации. Пока перенос не согласован управляющим, игрок не может записаться на новые игры.</div>
  <div class="card list">${list.map(d => { const left = debtLeft(d); const t = T(d.tid) || {};
    const chip = d.status === 'open' ? '<span class="st debt">Не согласован</span>' : d.status === 'approved' ? `<span class="st appr">Перенос до ${esc(dateRu(d.until))}</span>` : '<span class="st paid">Закрыт</span>';
    return `<div class="it" style="flex-wrap:wrap">${avatar(d.pid)}<div class="grow"><div class="nick">${esc(nick(d.pid))} ${chip}</div>
      <div class="small mut">${esc(t.title)} · ${dateRu(t.date)}${d.reason ? ' · «' + esc(d.reason) + '» — ' + esc(nick(d.approvedBy)) : ''}</div></div><b class="${left ? 'due' : ''}">${rub(left)}</b>
      ${d.status !== 'closed' ? `<div class="row" style="width:100%;gap:8px;margin-top:8px;padding-left:46px">
        ${can('payments') ? `<button class="btn sm" data-act="sheet" data-k="pay" data-pid="${d.pid}" data-tid="${d.tid}">Принять оплату</button>` : ''}
        ${d.status === 'open' ? (can('debt_approve') ? `<button class="btn ghost sm" data-act="sheet" data-k="approve" data-id="${d.id}">Согласовать перенос</button>` : '<span class="small mut">Перенос согласует управляющий</span>') : ''}</div>` : ''}</div>`; }).join('') || '<div class="empty">Долгов нет</div>'}</div>`;
}
function mPlayers() {
  const list = S.users.filter(u => u.profileDone).sort((a, b) => a.nick.localeCompare(b.nick));
  return `<div class="between" style="margin-bottom:10px"><div class="lbl">Все игроки и персонал · ${list.length}</div><button class="btn ghost sm" data-act="sheet" data-k="newPlayer">＋ Без Telegram</button></div>
  <div class="card list">${list.map(u => `<div class="it">${avatar(u.id)}<div class="grow"><div class="nick">${esc(u.nick)} ${u.role !== 'player' ? `<span class="tag">${ROLE_TITLES[u.role]}</span>` : ''}${u.noTg ? ' <span class="tag">без Telegram</span>' : ''}${blocked(u.id) ? ' <span class="st debt">долг</span>' : ''}</div>
    <div class="small mut">${esc(u.name || '')} · ${esc(u.phone || 'нет телефона')}</div></div>
    ${u.phone ? `<button class="btn dark sm" data-act="code" data-pid="${u.id}">Код для веба</button>` : ''}</div>`).join('') || '<div class="empty">Пока никого</div>'}</div>
  <div class="lock">«Код для веба» — одноразовый код на 24 часа для входа без Telegram на сайте клуба. Передайте его игроку лично.</div>`;
}
function mBonus() {
  const players = S.users.filter(u => u.profileDone);
  return `<form class="card" data-form="bonus"><b>Начислить или списать бонусы</b>
    <label class="f" for="bp">Игрок</label><select id="bp" name="pid">${players.map(u => `<option value="${u.id}">${esc(u.nick)} · ${fmt(bonusBal(u.id))}</option>`).join('')}</select>
    <label class="f" for="ba">Сумма (минус — списание)</label><input id="ba" type="number" name="amount" value="100" required>
    <label class="f" for="br">Причина</label><input id="br" type="text" name="reason" placeholder="Например: день рождения" required>
    <button class="btn wide" style="margin-top:12px">Провести</button></form>
  <div class="sec"><span>Последние операции</span></div>
  <div class="card list">${S.bonus.slice().reverse().slice(0, 30).map(b => `<div class="it"><div class="grow"><div class="nick">${esc(nick(b.pid))}</div><div class="small mut">${esc(b.reason)} · ${esc(nick(b.by))} · ${fmtDate(b.ts)}</div></div><b style="color:${b.amount > 0 ? 'var(--green)' : 'var(--red)'}">${b.amount > 0 ? '+' : ''}${fmt(b.amount)}</b></div>`).join('') || '<div class="empty">Пока нет</div>'}</div>`;
}
function structSummary(L) { const play = L.filter(l => !l.brk); const f = play[0], l = play[play.length - 1]; return play.length + ' уровней · ' + L.filter(x => x.brk).length + ' перерыва · ' + fmt(f.sb) + '/' + fmt(f.bb) + ' → ' + fmt(l.sb) + '/' + fmt(l.bb); }
function mStructs() {
  return `<div class="lock" style="margin:0 0 12px">Шаблоны структур. Турнир при создании берёт копию — правки во время игры не меняют шаблон.</div>
  <div class="card list">${S.structures.map(st => `<div class="it" data-act="sheet" data-k="struct" data-tk="s" data-sid="${st.id}" style="cursor:pointer"><div class="grow"><div class="nick">${esc(st.title)}</div><div class="small mut">${structSummary(st.levels)}</div></div><span class="mut">›</span></div>`).join('')}</div>
  <button class="btn wide ghost" data-act="do" data-type="st_new" data-ok="Структура создана">＋ Новая структура</button>`;
}
function oRoles() {
  const people = S.users.filter(u => u.id !== meId() && u.profileDone);
  const permsOf = role => role === 'owner' ? 'Все права, включая назначение ролей' : role === 'player' ? 'Только функции игрока' :
    (PERMS.filter(([k]) => (S.roles[role] || []).includes(k)).map(p => p[1]).join(' · ') || 'Нет прав персонала');
  return `<div class="sec" style="margin-top:0"><span>Люди и роли</span></div>
  <div class="card list">${people.map(u => `<div class="it" style="flex-wrap:wrap">${avatar(u.id)}<div class="grow"><div class="nick">${esc(u.nick)} <span class="tag">${ROLE_TITLES[u.role]}</span></div><div class="small mut">${esc(u.name || '')}</div></div>
    <select style="width:auto;min-width:150px" data-act="setRole" data-uid="${u.id}" aria-label="Роль ${esc(u.nick)}">${['owner', 'manager', 'dealer', 'player'].map(r => `<option value="${r}" ${u.role === r ? 'selected' : ''}>${ROLE_TITLES[r]}</option>`).join('')}</select>
    <div class="small mut" style="flex-basis:100%;margin-top:6px">Может: ${esc(permsOf(u.role))}</div></div>`).join('') || '<div class="empty">Пока никого. Попросите сотрудников зарегистрироваться в боте.</div>'}</div>
  <div class="sec"><span>Настройка ролей</span></div>
  <div class="lock" style="margin:0 0 10px">Здесь задаётся, что умеет каждая роль. Галочка меняет права сразу у всех людей с этой ролью. Чтобы изменить права одного человека — смените ему роль выше.</div>
  ${['manager', 'dealer'].map(r => `<details id="perm-${r}" class="card" style="padding:0" ${OPEN['perm-' + r] ? 'open' : ''}><summary style="padding:14px 16px;cursor:pointer;font-weight:600">Что может роль «${ROLE_TITLES[r]}»</summary><div style="padding:0 16px 8px">${PERMS.filter(p => p[0] !== 'roles').map(([k, l]) =>
    `<label class="perm"><span>${l}</span><input type="checkbox" data-act="perm" data-role="${r}" data-k="${k}" ${S.roles[r].includes(k) ? 'checked' : ''}></label>`).join('')}</div></details>`).join('')}`;
}
function mLog() {
  return `<div class="lock" style="margin:0 0 12px">Каждое действие пишется в журнал. Удалить запись нельзя.</div>
  <div class="card list">${S.log.map(l => `<div class="it"><div class="grow">${esc(l.text)}<div class="small mut">${esc(nick(l.by))} · ${fmtDate(l.ts)}, ${hhmm(l.ts)}</div></div></div>`).join('') || '<div class="empty">Пусто</div>'}</div>`;
}
function sSummary() {
  const t = live() || curT();
  const pend = S.ops.filter(o => o.status === 'requested').length; const openD = S.debts.filter(d => d.status === 'open');
  const allDebt = S.debts.filter(d => d.status !== 'closed').reduce((a, d) => a + debtLeft(d), 0);
  const unpaid = t ? regsOf(t.id).filter(r => due(t.id, r.pid) > 0) : [];
  return `${t ? `<div class="sec" style="margin-top:0"><span>${esc(t.title)}</span><span>${stageName(t)}</span></div>
  <div class="grid3"><div class="stat"><b>${regsOf(t.id).filter(r => r.status === 'arrived').length}/${regsOf(t.id).length}</b><span>в игре / записано</span></div>
    <div class="stat"><b>${rub(issued(t.id))}</b><span>выдано</span></div><div class="stat"><b style="color:var(--green)">${rub(paid(t.id))}</b><span>оплачено</span></div></div>
  ${t.stage === 'reg' || t.stage === 'closed' ? clockCard(t, false) : ''}` : '<div class="card gold"><b>Система готова.</b><div class="small mut" style="margin-top:6px">1) Попросите сотрудников открыть бота и зарегистрироваться. 2) Назначьте им роли во вкладке «Роли». 3) Создайте первый турнир во вкладке «Турнир».</div></div>'}
  <div class="sec"><span>Требует внимания</span></div>
  <div class="card list">
    <div class="it" data-act="stab" data-k="debts" style="cursor:pointer"><div class="grow"><div class="nick">Несогласованные долги</div><div class="small mut">${openD.map(d => esc(nick(d.pid))).join(', ') || 'нет'}</div></div><b class="${openD.length ? 'due' : ''}">${openD.length}</b></div>
    <div class="it" data-act="stab" data-k="tour" style="cursor:pointer"><div class="grow"><div class="nick">Запросы на ребай/аддон</div><div class="small mut">ждут дилера</div></div><b>${pend}</b></div>
    <div class="it" data-act="stab" data-k="cash" style="cursor:pointer"><div class="grow"><div class="nick">Не оплатили в текущем турнире</div><div class="small mut">${unpaid.map(r => esc(nick(r.pid)) + ' ' + rub(due(t.id, r.pid))).join(', ') || 'все рассчитались'}</div></div><b>${unpaid.length}</b></div>
    <div class="it"><div class="grow"><div class="nick">Общий долг игроков клубу</div></div><b class="${allDebt ? 'due' : ''}">${rub(allDebt)}</b></div></div>`;
}

/* ---------- окна ---------- */
function tgt(s) { if (s.tk === 't') { const t = T(s.sid); return t && { t, levels: t.levels, title: t.title }; } const st = S.structures.find(x => x.id === s.sid); return st && { st, levels: st.levels }; }
function sheetHtml() {
  const s = UI.sheet; if (!s) return '';
  const t = T(s.tid); const close = '<button class="x" data-act="close" aria-label="Закрыть">✕</button>';
  const methods = `<div class="seg" style="margin-top:8px">${['Наличные', 'Карта', 'Перевод'].map((m, i) => `<label><input type="radio" name="method" value="${m}" ${i ? '' : 'checked'}><span>${m}</span></label>`).join('')}</div>`;
  let h = '';
  if (s.k === 'req' && t) {
    const isR = s.type === 'rebuy';
    h = `<div class="between"><h3>${isR ? 'Запросить ребай' : 'Запросить аддон'}</h3>${close}</div>
    <form data-form="req" data-tid="${t.id}" data-type="${s.type}">
      ${isR ? `<div class="seg" style="margin-top:12px">${[1, 2, 3].slice(0, t.maxMult).map(m => `<label><input type="radio" name="mult" value="${m}" ${m === 1 ? 'checked' : ''}><span>×${m}<br><small>${fmt(t.rebuyChips * m)} · ${rub(t.rebuy * m)}</small></span></label>`).join('')}</div>` : `<div class="card" style="margin-top:12px">${fmt(t.addonChips)} фишек · ${rub(t.addon)}</div>`}
      <button class="btn wide" style="margin-top:14px">Отправить дилеру</button></form>`;
  }
  if (s.k === 'issue' && t) {
    const r = regOf(t.id, s.pid) || {}; const ad = opsOf(t.id, s.pid).filter(o => o.type === 'addon' && o.status === 'issued').length;
    h = `<div class="between"><h3>Выдать: ${esc(nick(s.pid))}</h3>${close}</div>
    <form data-form="issue" data-tid="${t.id}" data-pid="${s.pid}">
      <div class="seg" style="margin-top:12px">${[1, 2, 3].slice(0, t.maxMult).map(m => `<label><input type="radio" name="what" value="rebuy:${m}" ${m === 1 ? 'checked' : ''}><span>Ребай ×${m}<br><small>${rub(t.rebuy * m)}</small></span></label>`).join('')}
        <label><input type="radio" name="what" value="addon:1" ${ad >= t.addonMax ? 'disabled' : ''}><span>Аддон<br><small>${ad}/${t.addonMax} · ${rub(t.addon)}</small></span></label></div>
      <div class="grid2"><div><label class="f" for="it">Стол (необязательно)</label><input id="it" type="text" name="table" value="${esc(r.table || '')}"></div>
      <div><label class="f" for="ib">Бокс (необязательно)</label><input id="ib" type="text" name="box" value="${esc(r.box || '')}"></div></div>
      ${due(t.id, s.pid) ? `<div class="lock">Сейчас не оплачено: <span class="due">${rub(due(t.id, s.pid))}</span>. Выдать можно — сумма уйдёт в расчёт.</div>` : ''}
      <button class="btn wide" style="margin-top:14px">Отметить выдачу</button></form>`;
  }
  if (s.k === 'checkin' && t) {
    const u = U(s.pid) || {};
    h = `<div class="between"><h3>Пришёл: ${esc(u.nick)}</h3>${close}</div>
    <form data-form="checkin" data-tid="${t.id}" data-pid="${s.pid}">
      <div class="card" style="margin-top:12px">Вход: <b>${u.first ? 'бесплатно — первый визит 🎁' : rub(t.entry)}</b> · стек ${fmt(t.stack)}</div>
      <div class="grid2"><div><label class="f" for="ct">Стол</label><input id="ct" type="text" name="table" placeholder="необязательно"></div>
      <div><label class="f" for="cb">Бокс</label><input id="cb" type="text" name="box" placeholder="необязательно"></div></div>
      ${u.first ? '' : `<label class="row small" style="margin-top:12px;gap:10px"><input type="checkbox" name="paidNow" style="width:22px;height:22px;accent-color:var(--gold)"> Вход оплачен сейчас</label>${methods}`}
      <button class="btn wide" style="margin-top:14px">Отметить приход и выдать стек</button></form>`;
  }
  if (s.k === 'pay' && t) {
    const d = due(t.id, s.pid);
    h = `<div class="between"><h3>Оплата: ${esc(nick(s.pid))}</h3>${close}</div>
    <form data-form="pay" data-tid="${t.id}" data-pid="${s.pid}"><div class="small mut" style="margin-top:6px">${esc(t.title)} · выдано ${rub(issued(t.id, s.pid))} · оплачено ${rub(paid(t.id, s.pid))}</div>
      <label class="f" for="pa">Сумма</label><input id="pa" type="number" name="amount" value="${d}" min="1" max="${d}" required>${methods}
      <button class="btn wide" style="margin-top:14px">Принять оплату</button></form>`;
  }
  if (s.k === 'cancel') {
    const o = S.ops.find(x => x.id === s.id); if (!o) return '';
    h = `<div class="between"><h3>Отменить: ${opName(o)}</h3>${close}</div>
    <form data-form="cancel" data-id="${o.id}"><div class="small mut" style="margin-top:6px">${esc(nick(o.pid))} · ${rub(o.amount)} · запись останется в журнале со статусом «Отменён»</div>
      <label class="f" for="cr">Причина</label><input id="cr" type="text" name="reason" placeholder="Например: ошибся игроком" required>
      <button class="btn red wide" style="margin-top:14px">Отменить операцию</button></form>`;
  }
  if (s.k === 'approve') {
    const d = S.debts.find(x => x.id === s.id); if (!d) return '';
    h = `<div class="between"><h3>Перенос долга: ${esc(nick(d.pid))}</h3>${close}</div>
    <form data-form="approve" data-id="${d.id}"><div class="small mut" style="margin-top:6px">${esc((T(d.tid) || {}).title)} · ${rub(debtLeft(d))}</div>
      <label class="f" for="au">Оплатить до</label><input id="au" type="date" name="until" required value="${isoDay(now() + 7 * DAY)}">
      <label class="f" for="ar">О чём договорились</label><input id="ar" type="text" name="reason" required>
      <button class="btn wide" style="margin-top:14px">Согласовать</button></form>`;
  }
  if (s.k === 'closeReg' && t) {
    const debtors = regsOf(t.id).filter(r => r.status === 'arrived' && due(t.id, r.pid) > 0);
    h = `<div class="between"><h3>Закрыть регистрацию и аддон</h3>${close}</div>
    <div class="small mut" style="margin-top:6px">После этого ребаи и аддоны выдавать нельзя. Кто не рассчитался — попадёт в журнал долгов.</div>
    <div class="card list" style="margin-top:12px">${debtors.map(r => `<div class="it">${avatar(r.pid)}<div class="grow">${esc(nick(r.pid))}</div><b class="due">${rub(due(t.id, r.pid))}</b></div>`).join('') || '<div class="empty">Все рассчитались 👌</div>'}</div>
    <button class="btn wide" style="margin-top:12px" data-act="do" data-type="close_reg" data-tid="${t.id}" data-ok="Регистрация закрыта">Закрыть${debtors.length ? ' и записать ' + debtors.length + ' в долги' : ''}</button>`;
  }
  if (s.k === 'results' && t) {
    const rs = regsOf(t.id).filter(r => r.status === 'arrived');
    h = `<div class="between"><h3>Итоги: ${esc(t.title)}</h3>${close}</div>
    <form data-form="results" data-tid="${t.id}"><div class="small mut" style="margin-top:6px">Места. Очки: 1 — 100, 2 — 70, 3 — 50, 4 — 40… остальным 2 за участие.</div>
      ${rs.map((r, i) => `<div class="perm"><span>${esc(nick(r.pid))}</span><input type="number" name="${r.pid}" value="${i + 1}" min="1" max="${rs.length}" style="width:80px" aria-label="Место ${esc(nick(r.pid))}"></div>`).join('')}
      <button class="btn wide" style="margin-top:14px">Сохранить итоги</button></form>`;
  }
  if (s.k === 'newT') {
    h = `<div class="between"><h3>Новый турнир</h3>${close}</div>
    <form data-form="newT"><label class="f" for="nt">Шаблон</label><select id="nt" name="tpl">${Object.entries(TEMPLATES).map(([k, v]) => `<option value="${k}">${v.title} · вход ${rub(v.entry)} · ребай ${rub(v.rebuy)}</option>`).join('')}</select>
      <label class="f" for="nn">Название</label><input id="nn" type="text" name="title" placeholder="Можно оставить из шаблона">
      <label class="f" for="ns">Структура уровней</label><select id="ns" name="struct"><option value="">Как в шаблоне</option>${S.structures.map(st => `<option value="${st.id}">${esc(st.title)}</option>`).join('')}</select>
      <div class="grid3"><div><label class="f" for="nd">Дата</label><input id="nd" type="date" name="date" value="${isoDay(now())}" required></div>
      <div><label class="f" for="nh">Старт</label><input id="nh" type="time" name="time" value="19:00"></div>
      <div><label class="f" for="nl">Поздняя рег.</label><input id="nl" type="time" name="lateReg" value="21:15"></div></div>
      <button class="btn wide" style="margin-top:14px">Создать и разослать афишу</button></form>`;
  }
  if (s.k === 'newPlayer') {
    h = `<div class="between"><h3>Игрок без Telegram</h3>${close}</div>
    <form data-form="newPlayer"><label class="f" for="np1">Ник / имя</label><input id="np1" type="text" name="nick" required>
      <label class="f" for="np2">Телефон</label><input id="np2" type="tel" name="phone" required>
      <label class="row small" style="margin-top:12px;gap:10px"><input type="checkbox" name="adult" required style="width:22px;height:22px;accent-color:var(--gold)"> Проверил(а) документ: игроку есть 18 лет</label>
      <button class="btn wide" style="margin-top:14px">Создать и выдать код входа</button></form>`;
  }
  if (s.k === 'code') {
    h = `<div class="between"><h3>Код входа: ${esc(nick(s.pid))}</h3>${close}</div>
    <div class="card gold" style="margin-top:12px;text-align:center"><div class="lbl">Код на 24 часа</div><div class="big" style="font-size:44px;letter-spacing:.15em">${esc(s.code)}</div></div>
    <div class="small mut">Игрок открывает сайт <b>${esc(location.origin + location.pathname.replace(/index\.html$/, ''))}</b>, вводит свой телефон и этот код. Передайте код лично — он даёт вход в профиль игрока.</div>`;
  }
  if (s.k === 'notes') {
    const ns = S.notes;
    h = `<div class="between"><h3>Уведомления</h3>${close}</div>
    <div class="card list" style="margin-top:12px">${ns.map(n => `<div class="it"><div class="grow">${esc(n.text)}<div class="small mut">${fmtDate(n.ts)}, ${hhmm(n.ts)}</div></div></div>`).join('') || '<div class="empty">Пока пусто</div>'}</div>`;
  }
  if (s.k === 'editProfile') {
    const me = S.me;
    h = `<div class="between"><h3>Профиль</h3>${close}</div>
    <form data-form="profile"><label class="f" for="ep1">Имя</label><input id="ep1" type="text" name="name" value="${esc(me.name || '')}" required>
      <label class="f" for="ep2">Ник</label><input id="ep2" type="text" name="nick" value="${esc(me.nick)}" required>
      <label class="f" for="ep3">Телефон</label><input id="ep3" type="tel" name="phone" value="${esc(me.phone || '')}" required>
      <input type="hidden" name="dob" value="${esc(me.dob || '')}"><input type="hidden" name="pd" value="1">
      <button class="btn wide" style="margin-top:14px">Сохранить</button></form>`;
  }
  if (s.k === 'struct') {
    const g = tgt(s); if (!g) return '';
    const L = g.levels; const v = g.t && (g.t.stage === 'reg' || g.t.stage === 'closed') ? clockView(g.t) : null;
    const ed = g.t ? can('clock') && g.t.stage !== 'finished' : can('structures');
    const da = `data-tk="${s.tk}" data-sid="${s.sid}"`;
    h = `<div class="between"><h3>${g.t ? 'Структура: ' + esc(g.t.title) : 'Шаблон структуры'}</h3>${close}</div>
    ${g.st && ed ? `<form data-form="stTitle" data-sid="${s.sid}" class="row" style="margin-top:8px"><input type="text" name="title" value="${esc(g.st.title)}" aria-label="Название"><button class="btn dark sm">Сохранить</button></form>` : ''}
    <div class="small mut" style="margin-top:6px">${g.t ? 'Правки действуют сразу: таймер пересчитается у всех. Шаблон «' + esc(g.t.structTitle || '') + '» не меняется.' : structSummary(L)}</div>
    ${ed ? `<form data-form="speed" ${da} class="card" style="margin-top:12px"><b>${g.t ? 'Ускорить или замедлить игру' : 'Время всех уровней'}</b>
      <div class="seg" style="margin-top:10px">${[5, 10, 12, 15, 20, 25].map(m => `<label><input type="radio" name="m" value="${m}" ${m === (g.t ? 5 : lastPlay(L).dur) ? 'checked' : ''}><span>${m} мин</span></label>`).join('')}</div>
      ${v ? `<div class="seg" style="margin-top:8px"><label><input type="radio" name="scope" value="cur" checked><span>С текущего</span></label><label><input type="radio" name="scope" value="next"><span>Со следующего</span></label></div>` : ''}
      <button class="btn wide" style="margin-top:10px">Применить</button></form>` : ''}
    <div class="sec"><span>Уровни</span><span>${L.length}</span></div>
    <div class="card list">${L.map((l, i) => { const cur = v && i === v.lvl, past = v && i < v.lvl;
      return `<div class="it" style="${cur ? 'background:#241c0d;border-radius:10px;padding-left:8px;' : ''}${past ? 'opacity:.45' : ''}">
        <b style="width:52px;color:${l.brk ? 'var(--mut)' : 'var(--gold2)'}">${l.brk ? 'Пер.' : 'Ур. ' + lvNo(L, i)}</b>
        <div class="grow">${l.brk ? 'Перерыв' : fmt(l.sb) + ' / ' + fmt(l.bb) + ' · анте ' + fmt(l.ante)}<div class="small mut">${l.dur} мин${cur ? ' · <span style="color:var(--gold2)">идёт сейчас</span>' : ''}</div></div>
        ${v && ed && !cur ? `<button class="btn dark sm" data-act="do" data-type="go_lvl" data-tid="${s.sid}" data-i="${i}" data-keep="1">Перейти</button>` : ''}
        ${ed ? `<button class="btn ghost sm" data-act="sheet" data-k="lvl" ${da} data-i="${i}" aria-label="Изменить">✎</button>` : ''}</div>`; }).join('')}</div>
    ${ed ? `<div class="grid2" style="margin-top:10px">
      <button class="btn" data-act="do" data-type="st_auto" ${da} data-keep="1" data-ok="Добавлено 3 уровня">＋ 3 уровня выше</button>
      <button class="btn dark" data-act="sheet" data-k="lvl" ${da} data-i="new">＋ Свой уровень</button>
      <button class="btn dark" data-act="do" data-type="st_break" ${da} data-keep="1" data-ok="Перерыв добавлен">＋ Перерыв${v ? ' после текущего' : ''}</button>
      ${g.t && can('structures') ? `<button class="btn ghost" data-act="do" data-type="st_dup" ${da} data-keep="1" data-ok="Сохранено в шаблоны">Сохранить как шаблон</button>` : ''}
      ${g.st ? `<button class="btn ghost" data-act="do" data-type="st_dup" ${da} data-keep="1" data-ok="Копия создана">Дублировать</button>` : ''}</div>
      ${g.st && S.structures.length > 1 ? `<button class="btn red wide" style="margin-top:10px" data-act="do" data-type="st_delete" data-sid="${s.sid}" data-ok="Шаблон удалён">Удалить шаблон</button>` : ''}` : '<div class="lock">Только просмотр.</div>'}`;
  }
  if (s.k === 'lvl') {
    const g = tgt(s); if (!g) return '';
    const isNew = s.i === 'new'; const lp = lastPlay(g.levels); const nb = C.nextBB(lp.bb);
    const L = isNew ? { sb: nb / 2, bb: nb, ante: nb, dur: lp.dur } : g.levels[+s.i];
    const da = `data-tk="${s.tk}" data-sid="${s.sid}" data-i="${s.i}"`;
    h = `<div class="between"><h3>${isNew ? 'Новый уровень в конец' : L.brk ? 'Перерыв' : 'Уровень ' + lvNo(g.levels, +s.i)}</h3><button class="x" data-act="sheet" data-k="struct" data-tk="${s.tk}" data-sid="${s.sid}" aria-label="Назад">←</button></div>
    <form data-form="lvl" ${da}>
      ${L.brk ? '' : `<div class="grid3"><div><label class="f" for="l1">Малый</label><input id="l1" type="number" name="sb" value="${L.sb}" min="1" required></div>
        <div><label class="f" for="l2">Большой</label><input id="l2" type="number" name="bb" value="${L.bb}" min="1" required></div>
        <div><label class="f" for="l3">Анте</label><input id="l3" type="number" name="ante" value="${L.ante}" min="0" required></div></div>`}
      <label class="f" for="l4">Длительность, мин</label><input id="l4" type="number" name="dur" value="${L.dur}" min="1" max="120" required>
      <button class="btn wide" style="margin-top:14px">${isNew ? 'Добавить' : 'Сохранить'}</button></form>
    ${isNew ? '' : `<div class="grid2" style="margin-top:10px"><button class="btn dark" data-act="lvlOp" data-type="st_ins" ${da}>＋ Вставить после</button><button class="btn red" data-act="lvlOp" data-type="st_del" ${da}>Удалить</button></div>`}`;
  }
  return h ? `<div class="scrim" data-act="scrim"><div class="sheet" role="dialog" aria-modal="true">${h}</div></div>` : '';
}

/* ---------- отрисовка ---------- */
function fullHtml() {
  const t = T(UI.full); if (!t) return '';
  const v = clockView(t);
  return `<div class="full"><img src="logo.svg" alt="Castle Club"><div class="lbl" style="font-size:16px">${esc(t.title)} · <span data-clk="lvl" data-tid="${t.id}">${v.L.brk ? 'Перерыв' : 'Уровень ' + v.no}</span></div>
    <div class="tm" data-clk="tm" data-tid="${t.id}">${mmss(v.rem)}</div>
    <div class="bl" data-clk="bl" data-tid="${t.id}">${blinds(v.L)}</div>
    <div class="mut" style="margin-top:10px;font-size:18px" data-clk="brk" data-tid="${t.id}">${brkText(v)}</div>
    <div class="mut" style="margin-top:6px">В игре ${regsOf(t.id).filter(r => r.status === 'arrived').length}</div>
    <button class="btn ghost" style="margin-top:24px" data-act="unfull">Закрыть</button></div>`;
}
/* Введённое пользователем не должно пропадать при фоновом обновлении экрана */
const DIRTY = {}, OPEN = {};
document.addEventListener('toggle', e => { if (e.target.id) OPEN[e.target.id] = e.target.open; }, true);
const fieldVal = el => el.type === 'checkbox' || el.type === 'radio' ? el.checked : el.value;
document.addEventListener('input', e => { const el = e.target; if (el.id && /INPUT|SELECT|TEXTAREA/.test(el.tagName)) DIRTY[el.id] = fieldVal(el); }, true);
document.addEventListener('change', e => { const el = e.target; if (el.id && /INPUT|SELECT|TEXTAREA/.test(el.tagName)) DIRTY[el.id] = fieldVal(el); }, true);
function restoreFields() {
  for (const id in DIRTY) { const el = document.getElementById(id); if (!el) continue; if (el.type === 'checkbox' || el.type === 'radio') el.checked = DIRTY[id]; else el.value = DIRTY[id]; }
}
function clearDirty(form) { form.querySelectorAll('[id]').forEach(el => { delete DIRTY[el.id]; }); }
function render() { const y = window.scrollY; renderInner(); restoreFields(); const on = document.querySelector('.tabs .tab.on'); if (on && on.parentElement) on.parentElement.scrollLeft = on.offsetLeft - on.parentElement.clientWidth / 2 + on.clientWidth / 2; if (Math.abs(window.scrollY - y) > 2) window.scrollTo(0, y); }
function renderInner() {
  const app = document.getElementById('app'), layer = document.getElementById('layer');
  if (!S) { app.innerHTML = TOKEN ? '<main><div class="empty">Загрузка…</div></main>' : loginView(); layer.innerHTML = ''; return; }
  app.innerHTML = !S.me.profileDone ? onboarding() : (isStaff() ? staffView() : playerView());
  layer.innerHTML = sheetHtml() + fullHtml();
}
function renderOffline(msg) {
  if (S) { render(); return; }
  document.getElementById('app').innerHTML = `<main><div class="brand"><img src="logo.svg" alt=""><div><div class="t">CASTLE CLUB</div></div></div><div class="card warn"><b>${esc(msg)}</b><div class="small mut" style="margin-top:6px">Бесплатный сервер просыпается до минуты. Повторяем автоматически…</div></div></main>`;
}
function tick() {
  if (!S) return;
  document.querySelectorAll('[data-clk]').forEach(el => {
    const t = T(el.dataset.tid); if (!t || !t.levels) return; const v = clockView(t); const k = el.dataset.clk;
    if (k === 'tm') { el.textContent = mmss(v.rem); el.classList.toggle('paused', !v.running); }
    if (k === 'lvl') el.textContent = v.L.brk ? 'Перерыв' : 'Уровень ' + v.no;
    if (k === 'bl') el.textContent = blinds(v.L);
    if (k === 'brk') el.textContent = brkText(v);
  });
}
let toastTimer;
function toast(msg) {
  let el = document.querySelector('.toast'); if (!el) { el = document.createElement('div'); el.className = 'toast'; document.body.appendChild(el); }
  el.textContent = msg; clearTimeout(toastTimer); toastTimer = setTimeout(() => el.remove(), 3000);
  if (IN_TG && TGW.HapticFeedback) try { TGW.HapticFeedback.notificationOccurred('success'); } catch (e) {}
}

/* ---------- действия ---------- */
const QUEUE_OK = new Set(['issue', 'issue_req', 'reject_req', 'pay', 'checkin', 'cancel_op', 'walkin']);
const ACT = {
  ptab: d => { UI.tab.p = d.k; render(); scrollTo(0, 0); },
  stab: d => { UI.tab.s = d.k; render(); scrollTo(0, 0); },
  mptab: d => { UI.tab.mp = d.k; render(); },
  selT: d => { UI.tid = d.tid; render(); },
  selTable: d => { UI.table = d.k; render(); },
  openGame: d => { UI.ptid = d.tid; if (isStaff()) { UI.tab.s = 'me'; UI.tab.mp = 'game'; } else UI.tab.p = 'game'; render(); scrollTo(0, 0); },
  sheet: d => { UI.sheet = Object.assign({}, d); if (d.k === 'notes' && S.notes.some(n => !n.read)) act('notes_read', {}, { keepSheet: true }); render(); },
  close: () => { UI.sheet = null; render(); },
  scrim: (d, el, e) => { if (e.target === el) { UI.sheet = null; render(); } },
  full: d => { UI.full = d.tid; render(); try { document.documentElement.requestFullscreen && document.documentElement.requestFullscreen(); } catch (e) {} },
  unfull: () => { UI.full = null; render(); try { document.fullscreenElement && document.exitFullscreen(); } catch (e) {} },
  logout: () => { logout(); render(); },
  sharePhone: () => { try { TGW.requestContact((ok, res) => { const ph = res && res.responseUnsafe && res.responseUnsafe.contact && res.responseUnsafe.contact.phone_number; if (ok && ph) { const i = document.getElementById('ob-phone'); if (i) { i.value = (ph.startsWith('+') ? '' : '+') + ph; DIRTY[i.id] = i.value; } } }); } catch (e) { toast('Введите номер вручную'); } },
  do: d => {
    const p = {}; ['tid', 'm', 'i', 'tk', 'sid'].forEach(k => { if (d[k] !== undefined) p[k] = d[k]; });
    if (d.opid) p.opId = d.opid;
    if (d.type === 'go_lvl') p.tid = d.tid;
    act(d.type, p, { ok: d.ok, keepSheet: !!d.keep, queue: QUEUE_OK.has(d.type) });
  },
  lvlOp: d => { act(d.type, { tk: d.tk, sid: d.sid, i: d.i }).then(r => { if (r && !r.queued) { UI.sheet = d.type === 'st_ins' ? { k: 'lvl', tk: d.tk, sid: d.sid, i: String(+d.i + 1) } : { k: 'struct', tk: d.tk, sid: d.sid }; render(); } }); },
  code: d => { act('login_code', { pid: d.pid }, { keepSheet: true }).then(r => { if (r && r.extra) { UI.sheet = { k: 'code', pid: d.pid, code: r.extra.code }; render(); } }); }
};
const CHANGE = {
  setRole: el => act('set_role', { uid: el.dataset.uid, role: el.value }, { ok: 'Роль назначена' }),
  perm: el => act('set_perm', { role: el.dataset.role, perm: el.dataset.k, on: el.checked }),
  selTable: el => { UI.table = el.dataset.k; render(); },
  mptab: el => { UI.tab.mp = el.dataset.k; render(); }
};
const FORM = {
  codeLogin: async f => {
    try { const r = await api('/api/auth/code', { body: { phone: f.get('phone'), code: f.get('code') } }); TOKEN = r.token; localStorage.setItem('cc-token', TOKEN); UI.loginErr = ''; await load(); }
    catch (e) { UI.loginErr = e.message; render(); }
  },
  profile: f => act('profile', { name: f.get('name'), nick: f.get('nick'), phone: f.get('phone'), dob: ruToIso(f.get('dob')) }, { ok: 'Сохранено' }),
  req: (f, d) => act('req', { tid: d.tid, type: d.type, mult: f.get('mult') || 1 }, { ok: 'Запрос отправлен дилеру' }),
  issue: (f, d) => { const [type, mult] = f.get('what').split(':'); act('issue', { tid: d.tid, pid: d.pid, type, mult, table: f.get('table'), box: f.get('box') }, { ok: 'Выдача отмечена', queue: true }); },
  checkin: (f, d) => act('checkin', { tid: d.tid, pid: d.pid, table: f.get('table'), box: f.get('box'), paidNow: !!f.get('paidNow'), method: f.get('method') }, { ok: 'Игрок в игре', queue: true }),
  walkin: (f, d) => act('walkin', { tid: d.tid, pid: f.get('pid') }, { keepSheet: true }).then(r => { if (r && !r.queued) { UI.sheet = { k: 'checkin', tid: d.tid, pid: f.get('pid') }; render(); } }),
  pay: (f, d) => act('pay', { tid: d.tid, pid: d.pid, amount: f.get('amount'), method: f.get('method') }, { ok: 'Оплата принята', queue: true }),
  cancel: (f, d) => act('cancel_op', { opId: d.id, reason: f.get('reason') }, { ok: 'Операция отменена', queue: true }),
  approve: (f, d) => act('approve_debt', { debtId: d.id, until: f.get('until'), reason: f.get('reason') }, { ok: 'Перенос согласован' }),
  results: (f, d) => { const places = {}; for (const [k, v] of f.entries()) places[k] = v; act('results', { tid: d.tid, places }, { ok: 'Итоги сохранены, рейтинг обновлён' }); },
  newT: f => act('tour_create', { tpl: f.get('tpl'), title: f.get('title'), struct: f.get('struct'), date: f.get('date'), time: f.get('time'), lateReg: f.get('lateReg') }, { ok: 'Турнир создан, афиша разослана' }).then(r => { if (r && S.tournaments.length) { UI.tid = sortedT().filter(t => t.stage === 'plan').slice(-1)[0]?.id || UI.tid; render(); } }),
  newPlayer: f => act('new_player', { nick: f.get('nick'), phone: f.get('phone'), adult: !!f.get('adult') }, { keepSheet: true }).then(r => { if (r && r.extra && r.extra.uid) ACT.code({ pid: r.extra.uid }); }),
  bonus: f => act('bonus', { pid: f.get('pid'), amount: f.get('amount'), reason: f.get('reason') }, { ok: 'Бонусы проведены' }),
  speed: (f, d) => act('st_speed', { tk: d.tk, sid: d.sid, m: f.get('m'), scope: f.get('scope') || 'cur' }, { keepSheet: true, ok: 'Время уровней изменено' }),
  lvl: (f, d) => act('st_lvl', { tk: d.tk, sid: d.sid, i: d.i, sb: f.get('sb'), bb: f.get('bb'), ante: f.get('ante'), dur: f.get('dur') }, { keepSheet: true, ok: 'Сохранено' }).then(r => { if (r) { UI.sheet = { k: 'struct', tk: d.tk, sid: d.sid }; render(); } }),
  stTitle: (f, d) => act('st_title', { sid: d.sid, title: f.get('title') }, { keepSheet: true, ok: 'Название сохранено' })
};
document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]'); if (!el) return;
  if (el.tagName === 'SELECT' || (el.tagName === 'INPUT' && el.type === 'checkbox')) return;
  if (el.tagName === 'INPUT' && el.type === 'radio') { const fn = CHANGE[el.dataset.act]; if (fn) fn(el); return; }
  const fn = ACT[el.dataset.act]; if (fn) { if (el.tagName === 'BUTTON') e.preventDefault(); fn(el.dataset, el, e); }
});
document.addEventListener('change', e => { const el = e.target; if (!el.dataset || !el.dataset.act) return; if (el.tagName === 'SELECT' || el.type === 'checkbox') { const fn = CHANGE[el.dataset.act]; if (fn) fn(el); } });
document.addEventListener('submit', e => { e.preventDefault(); const f = e.target; const fn = FORM[f.dataset.form]; if (!fn) return; const r = fn(new FormData(f), f.dataset); Promise.resolve(r).then(x => { if (x && !x.queued) clearDirty(f); }).catch(() => {}); });

/* ---------- запуск ---------- */
async function start() {
  if (IN_TG) { try { TGW.ready(); TGW.expand(); TGW.setHeaderColor && TGW.setHeaderColor('#0a0a0b'); TGW.setBackgroundColor && TGW.setBackgroundColor('#0a0a0b'); } catch (e) {} }
  try { const r = await fetch(API + '/api/config'); BOT = (await r.json()).bot || ''; } catch (e) {}
  for (let attempt = 0; ; attempt++) {
    try {
      if (IN_TG) { const r = await api('/api/auth/telegram', { body: { initData: TGW.initData } }); TOKEN = r.token; try { localStorage.setItem('cc-token', TOKEN); } catch (e) {} }
      if (TOKEN) await load(); else render();
      break;
    } catch (e) {
      if (e instanceof NetErr) { renderOffline(e.message); await new Promise(r => setTimeout(r, Math.min(15000, 3000 + attempt * 2000))); continue; }
      document.getElementById('app').innerHTML = `<main><div class="card warn"><b>${esc(e.message)}</b></div></main>`; return;
    }
  }
  setInterval(tick, 1000);
  setInterval(() => { if (TOKEN && S) load(true); }, 5000);
  setInterval(flush, 5000);
  window.addEventListener('online', flush);
}
start();
