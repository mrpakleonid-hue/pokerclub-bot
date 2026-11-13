(function () {
'use strict';
// Castle Club — общая логика. Всё состояние строится проигрыванием журнала событий.
// Каждое событие: { id, ts, uid, type, payload }. Повторное проигрывание даёт тот же результат.

const MIN = 60000, DAY = 86400000;

function mkLevels(pairs, dur, brkEvery, brkDur) {
  const out = [];
  pairs.forEach((x, i) => {
    out.push({ sb: x[0], bb: x[1], ante: x[1], dur });
    if ((i + 1) % brkEvery === 0 && i < pairs.length - 1) out.push({ brk: true, dur: brkDur });
  });
  return out;
}
const STD_PAIRS = [[100,100],[100,200],[100,300],[200,400],[200,500],[300,600],[400,800],[500,1000],[600,1200],[800,1600],[1000,2000],[1500,3000],[2000,4000],[3000,6000],[4000,8000]];
const DEEP_PAIRS = [[100,200],[200,300],[200,400],[300,500],[300,600],[400,800],[500,1000],[600,1200],[800,1600],[1000,2000],[1500,3000],[2000,4000],[3000,6000]];
const NICE = [100,200,300,400,500,600,800,1000,1200,1500,2000,2500,3000,4000,5000,6000,8000,10000,12000,15000,20000,25000,30000,40000,50000,60000,80000,100000,120000,150000,200000,250000,300000,400000,500000];
const nextBB = bb => NICE.find(x => x >= bb * 1.4) || Math.round(bb * 1.5 / 1000) * 1000;
const lvNo = (L, i) => { let n = 0; for (let k = 0; k <= i; k++) if (!L[k].brk) n++; return n; };
const lastPlay = L => { for (let k = L.length - 1; k >= 0; k--) if (!L[k].brk) return L[k]; return { bb: 100, dur: 15 }; };
const clone = x => JSON.parse(JSON.stringify(x));

const TEMPLATES = {
  bounty: { title: 'Castle Bounty', structure: 'std', entry: 1000, stack: 10000, rebuy: 500, rebuyChips: 10000, maxMult: 3, addon: 500, addonChips: 20000, addonMax: 3 },
  rebuy:  { title: 'Crazy Re-Buy', structure: 'turbo', entry: 1000, stack: 10000, rebuy: 500, rebuyChips: 10000, maxMult: 3, addon: 500, addonChips: 20000, addonMax: 3 },
  deep:   { title: 'Main Event', structure: 'deep', entry: 2000, stack: 20000, rebuy: 1000, rebuyChips: 20000, maxMult: 2, addon: 1000, addonChips: 30000, addonMax: 1 },
  high:   { title: 'High Roller', structure: 'deep', entry: 5000, stack: 30000, rebuy: 2500, rebuyChips: 30000, maxMult: 1, addon: 2500, addonChips: 40000, addonMax: 1 }
};
const PERMS = [
  ['clock', 'Управлять таймером и уровнями идущей игры'],
  ['structures', 'Настраивать шаблоны структур уровней'],
  ['checkin', 'Отмечать приход, добавлять игроков, выдавать коды входа'],
  ['issue', 'Выдавать ребаи и аддоны'],
  ['cancel_op', 'Отменять любые операции'],
  ['payments', 'Принимать оплату'],
  ['tournaments', 'Создавать турниры, закрывать регистрацию, вносить итоги'],
  ['bonus', 'Начислять и списывать бонусы'],
  ['reports', 'Видеть кассу, отчёты и журнал'],
  ['debt_approve', 'Согласовывать перенос долга'],
  ['roles', 'Назначать роли и права']
];
const ROLE_TITLES = { owner: 'Управляющий', manager: 'Менеджер / питбосс', dealer: 'Дилер', player: 'Игрок' };
const POINTS = [100, 70, 50, 40, 30, 25, 20, 15, 10, 5];

function initialState() {
  return {
    users: [],
    roles: {
      owner: PERMS.map(p => p[0]),
      manager: ['clock', 'structures', 'checkin', 'issue', 'cancel_op', 'payments', 'tournaments', 'bonus', 'reports'],
      dealer: ['issue'],
      player: []
    },
    structures: [
      { id: 'std', title: 'Стандарт · 17 мин', levels: mkLevels(STD_PAIRS, 17, 4, 10) },
      { id: 'turbo', title: 'Турбо · 10 мин', levels: mkLevels(STD_PAIRS, 10, 6, 5) },
      { id: 'deep', title: 'Глубокий · 25 мин', levels: mkLevels(DEEP_PAIRS, 25, 4, 15) }
    ],
    tournaments: [], regs: [], ops: [], pays: [], debts: [], bonus: [], results: [], log: [], notes: [],
    codes: {}, // код входа для веба: uid -> { code, exp }
    applied: {}, n: 0
  };
}

/* ---------- помощники (используются и в браузере) ---------- */
const U = (S, id) => S.users.find(u => u.id === id);
const nick = (S, id) => (U(S, id) || {}).nick || '—';
const T = (S, id) => S.tournaments.find(t => t.id === id);
const can = (S, uid, p) => { const u = U(S, uid); return !!u && (S.roles[u.role] || []).includes(p); };
const opsOf = (S, tid, pid) => S.ops.filter(o => o.tid === tid && (!pid || o.pid === pid));
const issued = (S, tid, pid) => opsOf(S, tid, pid).filter(o => o.status === 'issued').reduce((a, o) => a + o.amount, 0);
const paid = (S, tid, pid) => S.pays.filter(p => p.tid === tid && (!pid || p.pid === pid)).reduce((a, p) => a + p.amount, 0);
const due = (S, tid, pid) => Math.max(0, issued(S, tid, pid) - paid(S, tid, pid));
const regOf = (S, tid, pid) => S.regs.find(r => r.tid === tid && r.pid === pid && r.status !== 'cancelled');
const regsOf = (S, tid) => S.regs.filter(r => r.tid === tid && r.status !== 'cancelled');
const blocked = (S, pid) => S.debts.some(d => d.pid === pid && d.status === 'open');
const opName = o => o.type === 'entry' ? 'Вход' : o.type === 'rebuy' ? 'Ребай ×' + o.mult : 'Аддон';
const fmt = n => Number(n || 0).toLocaleString('ru-RU');
const rub = n => fmt(n) + ' ₽';

function clockView(t, now) {
  const LV = t.levels;
  const c = t.clock || { running: false, lvl: 0, rem: LV[0].dur * MIN, since: now };
  let lvl = Math.min(c.lvl, LV.length - 1), rem = c.rem - (c.running ? now - c.since : 0);
  while (rem <= 0 && lvl < LV.length - 1) { lvl++; rem += LV[lvl].dur * MIN; }
  if (rem < 0) rem = 0;
  let toBreak = rem, k = lvl + 1, hasBreak = false;
  if (LV[lvl].brk) toBreak = 0; else { while (k < LV.length && !LV[k].brk) { toBreak += LV[k].dur * MIN; k++; } hasBreak = k < LV.length; }
  return { lvl, rem, running: c.running, L: LV[lvl], next: LV[lvl + 1], toBreak, hasBreak, no: lvNo(LV, lvl), isLast: lvl === LV.length - 1, LV };
}
function rebase(t, now) { const v = clockView(t, now); t.clock = { running: v.running, lvl: v.lvl, rem: v.rem, since: now }; }
function rating(S) {
  const m = {};
  S.results.forEach(r => { m[r.pid] = (m[r.pid] || 0) + r.points; });
  return Object.entries(m).sort((a, b) => b[1] - a[1]).map(([pid, pts], i) => ({ pid, pts, place: i + 1 }));
}

/* ---------- применение событий ---------- */
class Refused extends Error {}
const no = msg => { throw new Refused(msg); };

function apply(S, ev) {
  if (S.applied[ev.id]) return { dup: true, out: [] };
  const H = HANDLERS[ev.type];
  if (!H) no('Неизвестное действие');
  const ctx = {
    S, ev, uid: ev.uid, now: ev.ts, p: ev.payload || {}, out: [],
    me: U(S, ev.uid),
    need(perm) { if (!can(S, ev.uid, perm)) no('Нет прав на это действие'); },
    log(text) { S.log.unshift({ ts: ev.ts, by: ev.uid, text }); if (S.log.length > 1000) S.log.length = 1000; },
    notify(pid, text) {
      S.notes.unshift({ pid, text, ts: ev.ts, read: false });
      if (S.notes.length > 3000) S.notes.length = 3000;
      const u = U(S, pid); if (u && u.tg_id) this.out.push({ chat_id: u.tg_id, text });
    },
    nid(suffix) { S.n++; return ev.id.slice(0, 8) + (suffix || '') + S.n; },
    t(tid) { const t = T(S, tid || ctx.p.tid); if (!t) no('Турнир не найден'); return t; },
    user(id) { const u = U(S, id); if (!u) no('Игрок не найден'); return u; }
  };
  if (!ctx.me && !SYSTEM.has(ev.type)) no('Нужно войти заново');
  const extra = H(ctx) || null;
  normalizeDebts(S);
  S.applied[ev.id] = 1;
  return { out: ctx.out, extra };
}
const SYSTEM = new Set(['user_new', 'code_login']);
function normalizeDebts(S) { S.debts.forEach(d => { if (d.status !== 'closed' && due(S, d.tid, d.pid) <= 0) d.status = 'closed'; }); }

function tgt(ctx) {
  const p = ctx.p;
  if (p.tk === 't') { ctx.need('clock'); const t = ctx.t(p.sid); return { t, levels: t.levels, title: t.title }; }
  ctx.need('structures');
  const st = ctx.S.structures.find(x => x.id === p.sid); if (!st) no('Структура не найдена');
  return { st, levels: st.levels, title: 'шаблоне «' + st.title + '»' };
}
const int = (v, min, max) => { const n = Math.round(Number(v)); if (!Number.isFinite(n) || n < min || n > max) no('Неверное число'); return n; };
const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max || 80);

const HANDLERS = {
  /* --- пользователи --- */
  user_new({ S, p, ev }) {
    if (U(S, p.uid)) return;
    const role = S.users.length === 0 ? 'owner' : 'player';
    S.users.push({ id: p.uid, tg_id: p.tg_id || null, nick: str(p.nick, 40) || 'Игрок', name: str(p.name, 60), phone: '', dob: '', role, first: true, profileDone: false, created: ev.ts });
  },
  profile(ctx) {
    const { S, p, me } = ctx;
    const name = str(p.name, 60), nk = str(p.nick, 40), phone = str(p.phone, 30), dob = str(p.dob, 10);
    if (!name || !nk || !phone || !/^\d{4}-\d{2}-\d{2}$/.test(dob)) no('Заполните все поля');
    const age = (ctx.now - Date.parse(dob)) / (365.25 * DAY);
    if (!(age >= 18)) no('Клуб принимает игроков с 18 лет');
    if (me.profileDone && me.dob && me.dob !== dob && !can(S, me.id, 'roles')) no('Дату рождения меняет только управляющий');
    if (S.users.some(u => u.id !== me.id && u.nick.toLowerCase() === nk.toLowerCase())) no('Такой ник уже занят');
    Object.assign(me, { name, nick: nk, phone, dob, profileDone: true });
    ctx.log('Регистрация игрока: ' + nk);
    ctx.notify(me.id, 'Добро пожаловать в Castle Club! Первый вход в подарок 🎁');
  },
  new_player(ctx) {
    ctx.need('checkin');
    const nk = str(ctx.p.nick, 40), phone = str(ctx.p.phone, 30);
    if (!nk || !phone) no('Укажите имя и телефон');
    if (ctx.S.users.some(u => u.nick.toLowerCase() === nk.toLowerCase())) no('Такой ник уже занят');
    if (!ctx.p.adult) no('Подтвердите, что игроку есть 18 лет');
    const id = 'w' + ctx.ev.id.slice(0, 10);
    ctx.S.users.push({ id, tg_id: null, nick: nk, name: nk, phone, dob: '', role: 'player', first: true, profileDone: true, noTg: true, created: ctx.now });
    ctx.log('Создан игрок без Telegram: ' + nk);
    return { uid: id };
  },
  login_code(ctx) {
    ctx.need('checkin');
    const u = ctx.user(ctx.p.pid);
    ctx.S.codes[u.id] = { code: str(ctx.p.code, 10), exp: ctx.now + DAY };
    ctx.log('Выдан код входа в веб-версию: ' + u.nick);
    return { code: ctx.p.code, pid: u.id };
  },
  code_login({ S, p }) { delete S.codes[p.uid]; },
  notes_read({ S, uid }) { S.notes.forEach(n => { if (n.pid === uid) n.read = true; }); },

  /* --- турниры --- */
  tour_create(ctx) {
    ctx.need('tournaments');
    const tp = TEMPLATES[ctx.p.tpl]; if (!tp) no('Нет такого шаблона');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ctx.p.date || '')) no('Укажите дату');
    const st = ctx.S.structures.find(x => x.id === (ctx.p.struct || tp.structure)) || ctx.S.structures[0];
    const t = Object.assign(clone(tp), {
      id: 't' + ctx.ev.id.slice(0, 10), title: str(ctx.p.title, 60) || tp.title, date: ctx.p.date,
      time: /^\d{1,2}:\d{2}$/.test(ctx.p.time || '') ? ctx.p.time : '19:00', lateReg: /^\d{1,2}:\d{2}$/.test(ctx.p.lateReg || '') ? ctx.p.lateReg : '21:15',
      stage: 'plan', levels: clone(st.levels), structTitle: st.title
    });
    ctx.S.tournaments.push(t);
    ctx.log('Создан турнир ' + t.title + ' — ' + t.date + ' ' + t.time);
    ctx.S.users.filter(u => u.role === 'player' && u.profileDone).forEach(u => ctx.notify(u.id, 'Новая игра: ' + t.title + ', ' + t.date.split('-').reverse().join('.') + ' в ' + t.time + '. Записывайтесь в приложении!'));
  },
  tour_start(ctx) {
    ctx.need('tournaments'); const t = ctx.t();
    if (t.stage !== 'plan') no('Турнир уже идёт');
    t.stage = 'reg'; t.clock = { running: true, lvl: 0, rem: t.levels[0].dur * MIN, since: ctx.now };
    ctx.log('Начат турнир ' + t.title);
  },
  reg(ctx) {
    const t = ctx.t(); const pid = ctx.uid;
    if (!ctx.me.profileDone) no('Сначала завершите регистрацию');
    if (t.stage === 'finished' || t.stage === 'closed') no('Запись закрыта');
    if (regOf(ctx.S, t.id, pid)) no('Вы уже записаны');
    if (blocked(ctx.S, pid)) no('Запись закрыта: есть несогласованный долг. Обратитесь к управляющему');
    ctx.S.regs.push({ tid: t.id, pid, status: 'registered' });
    ctx.log(nick(ctx.S, pid) + ' записался на ' + t.title);
    ctx.notify(pid, 'Вы записаны на ' + t.title + ' (' + t.date.split('-').reverse().join('.') + ', ' + t.time + ')');
  },
  unreg(ctx) {
    const r = regOf(ctx.S, ctx.p.tid, ctx.uid); if (!r) no('Вы не записаны');
    if (r.status === 'arrived') no('Вы уже в игре — обратитесь к менеджеру');
    r.status = 'cancelled'; ctx.log(nick(ctx.S, ctx.uid) + ' отменил запись на ' + ctx.t().title);
  },
  walkin(ctx) {
    ctx.need('checkin'); const t = ctx.t(); ctx.user(ctx.p.pid);
    if (t.stage === 'finished') no('Турнир завершён');
    if (regOf(ctx.S, t.id, ctx.p.pid)) no('Игрок уже в списке');
    ctx.S.regs.push({ tid: t.id, pid: ctx.p.pid, status: 'registered' });
    ctx.log('Добавлен без записи: ' + nick(ctx.S, ctx.p.pid) + ' в ' + t.title);
  },
  checkin(ctx) {
    ctx.need('checkin'); const t = ctx.t(); const u = ctx.user(ctx.p.pid);
    if (t.stage !== 'reg') no('Приход отмечается, пока открыта регистрация');
    const r = regOf(ctx.S, t.id, u.id); if (!r) no('Игрок не записан'); if (r.status === 'arrived') no('Уже отмечен');
    r.status = 'arrived'; r.table = str(ctx.p.table, 4); r.box = str(ctx.p.box, 4);
    const amount = u.first ? 0 : t.entry;
    ctx.S.ops.push({ id: ctx.nid('o'), tid: t.id, pid: u.id, type: 'entry', mult: 1, chips: t.stack, amount, status: 'issued', by: ctx.uid, reqBy: 'staff', table: r.table, box: r.box, ts: ctx.now, note: u.first ? 'Первый вход в подарок' : '' });
    if (ctx.p.paidNow && amount) ctx.S.pays.push({ id: ctx.nid('p'), tid: t.id, pid: u.id, amount, method: str(ctx.p.method, 20) || 'Наличные', by: ctx.uid, ts: ctx.now });
    u.first = false;
    ctx.log('Отмечен приход ' + u.nick + ' в ' + t.title + (amount ? '' : ' — первый вход бесплатно'));
    ctx.notify(u.id, 'Вы в игре! Стек ' + fmt(t.stack) + (r.table ? ', стол ' + r.table + (r.box ? ', бокс ' + r.box : '') : ''));
  },
  req(ctx) {
    const t = ctx.t(); const pid = ctx.uid; const r = regOf(ctx.S, t.id, pid);
    if (!r || r.status !== 'arrived') no('Вы не отмечены в игре');
    if (t.stage !== 'reg') no('Регистрация закрыта');
    const isR = ctx.p.type === 'rebuy';
    if (!isR && ctx.p.type !== 'addon') no('Неизвестный запрос');
    const m = isR ? int(ctx.p.mult, 1, t.maxMult) : 1;
    if (!isR && opsOf(ctx.S, t.id, pid).filter(o => o.type === 'addon' && (o.status === 'issued' || o.status === 'requested')).length >= t.addonMax) no('Лимит аддонов');
    ctx.S.ops.push({ id: ctx.nid('o'), tid: t.id, pid, type: ctx.p.type, mult: m, chips: isR ? t.rebuyChips * m : t.addonChips, amount: isR ? t.rebuy * m : t.addon, status: 'requested', reqBy: 'player', table: r.table, box: r.box, ts: ctx.now });
    ctx.log(nick(ctx.S, pid) + ' запросил ' + (isR ? 'ребай ×' + m : 'аддон'));
  },
  issue_req(ctx) {
    ctx.need('issue'); const o = ctx.S.ops.find(x => x.id === ctx.p.opId); if (!o || o.status !== 'requested') no('Запрос уже обработан');
    const t = ctx.t(o.tid); if (t.stage !== 'reg') no('Регистрация закрыта');
    o.status = 'issued'; o.by = ctx.uid; o.ts = ctx.now;
    ctx.log('Выдан ' + opName(o).toLowerCase() + ' игроку ' + nick(ctx.S, o.pid) + ' по запросу');
    ctx.notify(o.pid, opName(o) + ' выдан: ' + fmt(o.chips) + ' фишек. К оплате ' + rub(due(ctx.S, o.tid, o.pid)) + ' — до ' + t.lateReg);
  },
  reject_req(ctx) {
    ctx.need('issue'); const o = ctx.S.ops.find(x => x.id === ctx.p.opId); if (!o || o.status !== 'requested') no('Запрос уже обработан');
    o.status = 'rejected'; o.by = ctx.uid; ctx.log('Отклонён запрос ' + opName(o).toLowerCase() + ' от ' + nick(ctx.S, o.pid));
    ctx.notify(o.pid, 'Запрос «' + opName(o) + '» отклонён. Подойдите к дилеру.');
  },
  issue(ctx) {
    ctx.need('issue'); const t = ctx.t(); const u = ctx.user(ctx.p.pid);
    if (t.stage !== 'reg') no('Регистрация закрыта');
    const r = regOf(ctx.S, t.id, u.id); if (!r || r.status !== 'arrived') no('Игрок не в игре');
    const isR = ctx.p.type === 'rebuy'; if (!isR && ctx.p.type !== 'addon') no('Неизвестная операция');
    const m = isR ? int(ctx.p.mult, 1, t.maxMult) : 1;
    if (!isR && opsOf(ctx.S, t.id, u.id).filter(o => o.type === 'addon' && o.status === 'issued').length >= t.addonMax) no('Лимит аддонов');
    const o = { id: ctx.nid('o'), tid: t.id, pid: u.id, type: ctx.p.type, mult: m, chips: isR ? t.rebuyChips * m : t.addonChips, amount: isR ? t.rebuy * m : t.addon, status: 'issued', by: ctx.uid, reqBy: 'staff', table: str(ctx.p.table, 4), box: str(ctx.p.box, 4), ts: ctx.now };
    ctx.S.ops.push(o);
    ctx.log('Выдан ' + opName(o).toLowerCase() + ' игроку ' + u.nick + (o.table ? ' (стол ' + o.table + ', бокс ' + (o.box || '—') + ')' : ''));
    ctx.notify(u.id, opName(o) + ' выдан: ' + fmt(o.chips) + ' фишек. К оплате ' + rub(due(ctx.S, t.id, u.id)));
  },
  cancel_op(ctx) {
    const o = ctx.S.ops.find(x => x.id === ctx.p.opId); if (!o || o.status !== 'issued') no('Операцию нельзя отменить');
    const own = o.by === ctx.uid && ctx.now - o.ts < 5 * MIN;
    if (!own && !can(ctx.S, ctx.uid, 'cancel_op')) no('Отменить можно только свою выдачу в течение 5 минут');
    const reason = str(ctx.p.reason, 120); if (!reason) no('Укажите причину');
    o.status = 'cancelled'; o.cancelReason = reason; o.cancelBy = ctx.uid;
    ctx.log('Отменён ' + opName(o).toLowerCase() + ' у ' + nick(ctx.S, o.pid) + ': ' + reason);
    ctx.notify(o.pid, opName(o) + ' отменён: ' + reason);
  },
  pay(ctx) {
    ctx.need('payments'); const t = ctx.t(); ctx.user(ctx.p.pid);
    const d = due(ctx.S, t.id, ctx.p.pid); const amount = int(ctx.p.amount, 1, 10000000);
    if (amount > d) no('Сумма больше долга (' + rub(d) + ')');
    const method = ['Наличные', 'Карта', 'Перевод'].includes(ctx.p.method) ? ctx.p.method : 'Наличные';
    ctx.S.pays.push({ id: ctx.nid('p'), tid: t.id, pid: ctx.p.pid, amount, method, by: ctx.uid, ts: ctx.now });
    ctx.log('Принята оплата ' + rub(amount) + ' (' + method.toLowerCase() + ') от ' + nick(ctx.S, ctx.p.pid) + ' за ' + t.title);
    const left = due(ctx.S, t.id, ctx.p.pid);
    ctx.notify(ctx.p.pid, 'Оплата ' + rub(amount) + ' принята. ' + (left ? 'Осталось ' + rub(left) : 'Всё оплачено, спасибо!'));
  },
  close_reg(ctx) {
    ctx.need('tournaments'); const t = ctx.t(); if (t.stage !== 'reg') no('Регистрация уже закрыта');
    ctx.S.ops.filter(o => o.tid === t.id && o.status === 'requested').forEach(o => { o.status = 'rejected'; o.cancelReason = 'регистрация закрыта'; });
    let n = 0;
    regsOf(ctx.S, t.id).filter(r => r.status === 'arrived' && due(ctx.S, t.id, r.pid) > 0).forEach(r => {
      ctx.S.debts.push({ id: ctx.nid('d'), tid: t.id, pid: r.pid, status: 'open', ts: ctx.now }); n++;
      ctx.notify(r.pid, 'Не оплачено ' + rub(due(ctx.S, t.id, r.pid)) + ' за ' + t.title + '. Долг записан — оплатите менеджеру.');
    });
    t.stage = 'closed';
    ctx.log('Закрыта регистрация и аддон в ' + t.title + (n ? ', в долги записано: ' + n : ', все рассчитались'));
    return { debts: n };
  },
  results(ctx) {
    ctx.need('tournaments'); const t = ctx.t(); if (t.stage !== 'closed') no('Сначала закройте регистрацию');
    const places = ctx.p.places || {};
    ctx.S.results = ctx.S.results.filter(r => r.tid !== t.id);
    Object.entries(places).forEach(([pid, place]) => {
      if (!regOf(ctx.S, t.id, pid)) return;
      const pl = int(place, 1, 1000), pts = POINTS[pl - 1] ?? 2;
      ctx.S.results.push({ tid: t.id, pid, place: pl, points: pts });
      ctx.notify(pid, t.title + ': ' + pl + ' место, +' + pts + ' очков рейтинга');
    });
    t.stage = 'finished'; if (t.clock) { const v = clockView(t, ctx.now); t.clock = { running: false, lvl: v.lvl, rem: v.rem, since: ctx.now }; }
    ctx.log('Внесены итоги ' + t.title + ', рейтинг пересчитан');
  },
  approve_debt(ctx) {
    ctx.need('debt_approve'); const d = ctx.S.debts.find(x => x.id === ctx.p.debtId); if (!d || d.status !== 'open') no('Долг уже обработан');
    const reason = str(ctx.p.reason, 150); if (!reason) no('Напишите, о чём договорились');
    d.status = 'approved'; d.until = str(ctx.p.until, 10); d.reason = reason; d.approvedBy = ctx.uid;
    ctx.log('Согласован перенос долга ' + nick(ctx.S, d.pid) + ' до ' + d.until + ': ' + reason);
    ctx.notify(d.pid, 'Перенос оплаты согласован до ' + d.until.split('-').reverse().join('.') + '. Запись на игры снова открыта.');
  },
  bonus(ctx) {
    ctx.need('bonus'); ctx.user(ctx.p.pid);
    const amount = int(ctx.p.amount, -1000000, 1000000); if (!amount) no('Сумма не может быть 0');
    const reason = str(ctx.p.reason, 100); if (!reason) no('Укажите причину');
    ctx.S.bonus.push({ id: ctx.nid('b'), pid: ctx.p.pid, amount, reason, by: ctx.uid, ts: ctx.now });
    ctx.log((amount > 0 ? 'Начислено ' : 'Списано ') + Math.abs(amount) + ' бонусов ' + nick(ctx.S, ctx.p.pid) + ': ' + reason);
    ctx.notify(ctx.p.pid, (amount > 0 ? '+' : '') + amount + ' бонусов: ' + reason);
  },
  set_role(ctx) {
    ctx.need('roles'); const u = ctx.user(ctx.p.uid);
    if (u.id === ctx.uid) no('Свою роль поменять нельзя');
    if (!['owner', 'manager', 'dealer', 'player'].includes(ctx.p.role)) no('Нет такой роли');
    const was = u.role; u.role = ctx.p.role;
    ctx.log('Роль ' + u.nick + ': ' + ROLE_TITLES[was] + ' → ' + ROLE_TITLES[u.role]);
    ctx.notify(u.id, 'Вам назначена роль: ' + ROLE_TITLES[u.role]);
  },
  set_perm(ctx) {
    ctx.need('roles'); const r = ctx.p.role, k = ctx.p.perm;
    if (!['manager', 'dealer'].includes(r) || !PERMS.some(p => p[0] === k) || k === 'roles') no('Это право менять нельзя');
    const arr = ctx.S.roles[r];
    if (ctx.p.on) { if (!arr.includes(k)) arr.push(k); } else ctx.S.roles[r] = arr.filter(x => x !== k);
    ctx.log((ctx.p.on ? 'Выдано право' : 'Забрано право') + ' «' + PERMS.find(p => p[0] === k)[1] + '» у роли ' + ROLE_TITLES[r]);
  },

  /* --- таймер --- */
  clk_toggle(ctx) { ctx.need('clock'); const t = ctx.t(); const v = clockView(t, ctx.now); t.clock = { running: !v.running, lvl: v.lvl, rem: v.rem, since: ctx.now }; ctx.log((v.running ? 'Пауза' : 'Запуск') + ' таймера ' + t.title); },
  clk_next(ctx) { ctx.need('clock'); const t = ctx.t(); const v = clockView(t, ctx.now); if (v.isLast) no('Это последний уровень — добавьте уровни в «Структуре»'); t.clock = { running: v.running, lvl: v.lvl + 1, rem: v.LV[v.lvl + 1].dur * MIN, since: ctx.now }; ctx.log('Уровень вперёд в ' + t.title); },
  clk_prev(ctx) { ctx.need('clock'); const t = ctx.t(); const v = clockView(t, ctx.now); const l = Math.max(0, v.lvl - 1); t.clock = { running: v.running, lvl: l, rem: v.LV[l].dur * MIN, since: ctx.now }; ctx.log('Уровень назад в ' + t.title); },
  clk_add(ctx) { ctx.need('clock'); const t = ctx.t(); rebase(t, ctx.now); const m = int(ctx.p.m, -30, 30); t.clock.rem = Math.max(1000, t.clock.rem + m * MIN); ctx.log((m > 0 ? '+' : '') + m + ' мин на текущем уровне в ' + t.title); },
  go_lvl(ctx) { ctx.need('clock'); const t = ctx.t(); const i = int(ctx.p.i, 0, t.levels.length - 1); const running = t.clock ? clockView(t, ctx.now).running : false; t.clock = { running, lvl: i, rem: t.levels[i].dur * MIN, since: ctx.now }; ctx.log('Переход на ' + (t.levels[i].brk ? 'перерыв' : 'уровень ' + lvNo(t.levels, i)) + ' в ' + t.title); },

  /* --- структуры уровней --- */
  st_speed(ctx) {
    const g = tgt(ctx); const m = int(ctx.p.m, 1, 120); const L = g.levels; let from = 0;
    if (g.t) { rebase(g.t, ctx.now); const c = g.t.clock; from = ctx.p.scope === 'next' ? c.lvl + 1 : c.lvl;
      if (ctx.p.scope !== 'next' && !L[c.lvl].brk) { const old = L[c.lvl].dur; c.rem = Math.max(1000, Math.min(c.rem + (m - old) * MIN, m * MIN)); } }
    for (let k = from; k < L.length; k++) if (!L[k].brk) L[k].dur = m;
    ctx.log('Уровни по ' + m + ' мин в ' + g.title);
  },
  st_lvl(ctx) {
    const g = tgt(ctx); const L = g.levels; const dur = int(ctx.p.dur, 1, 120);
    if (ctx.p.i === 'new') { const sb = int(ctx.p.sb, 1, 1e7), bb = int(ctx.p.bb, 1, 1e7); L.push({ sb, bb, ante: int(ctx.p.ante, 0, 1e7), dur }); ctx.log('Добавлен уровень ' + fmt(sb) + '/' + fmt(bb) + ' в ' + g.title); return; }
    const i = int(ctx.p.i, 0, L.length - 1); const l = L[i];
    if (g.t) { rebase(g.t, ctx.now); if (g.t.clock.lvl === i) g.t.clock.rem = Math.max(1000, g.t.clock.rem + (dur - l.dur) * MIN); }
    if (!l.brk) { l.sb = int(ctx.p.sb, 1, 1e7); l.bb = int(ctx.p.bb, 1, 1e7); l.ante = int(ctx.p.ante, 0, 1e7); }
    l.dur = dur; ctx.log('Изменён ' + (l.brk ? 'перерыв' : 'уровень ' + lvNo(L, i)) + ' в ' + g.title);
  },
  st_ins(ctx) {
    const g = tgt(ctx); const L = g.levels; const i = int(ctx.p.i, 0, L.length - 1);
    if (g.t) rebase(g.t, ctx.now);
    const base = L[i].brk ? lastPlay(L.slice(0, i + 1)) : L[i]; const bb = nextBB(base.bb || 100);
    L.splice(i + 1, 0, { sb: bb / 2, bb, ante: bb, dur: base.dur || 15 });
    if (g.t && g.t.clock.lvl > i) g.t.clock.lvl++;
    ctx.log('Вставлен уровень в ' + g.title);
  },
  st_del(ctx) {
    const g = tgt(ctx); const L = g.levels; const i = int(ctx.p.i, 0, L.length - 1); if (L.length < 2) no('Нельзя удалить последний уровень');
    if (g.t) { rebase(g.t, ctx.now); if (g.t.clock.lvl === i) no('Нельзя удалить текущий уровень'); if (g.t.clock.lvl > i) g.t.clock.lvl--; }
    L.splice(i, 1); ctx.log('Удалён уровень в ' + g.title);
  },
  st_auto(ctx) {
    const g = tgt(ctx); if (g.t) rebase(g.t, ctx.now);
    let bb = lastPlay(g.levels).bb; const dur = lastPlay(g.levels).dur;
    for (let i = 0; i < 3; i++) { bb = nextBB(bb); g.levels.push({ sb: bb / 2, bb, ante: bb, dur }); }
    ctx.log('Добавлено 3 уровня в ' + g.title + ' (до ' + fmt(bb / 2) + '/' + fmt(bb) + ')');
  },
  st_break(ctx) {
    const g = tgt(ctx); if (g.t) rebase(g.t, ctx.now);
    const at = g.t ? clockView(g.t, ctx.now).lvl + 1 : g.levels.length;
    g.levels.splice(at, 0, { brk: true, dur: 10 }); ctx.log('Добавлен перерыв в ' + g.title);
  },
  st_new(ctx) { ctx.need('structures'); const st = { id: 's' + ctx.ev.id.slice(0, 10), title: 'Новая структура', levels: mkLevels(STD_PAIRS.slice(0, 10), 15, 4, 10) }; ctx.S.structures.push(st); ctx.log('Создана структура уровней'); return { sid: st.id }; },
  st_dup(ctx) {
    ctx.need('structures'); const p = ctx.p; let levels, title;
    if (p.tk === 't') { const t = ctx.t(p.sid); levels = t.levels; title = t.title + ' · своя'; }
    else { const s = ctx.S.structures.find(x => x.id === p.sid); if (!s) no('Структура не найдена'); levels = s.levels; title = s.title + ' (копия)'; }
    ctx.S.structures.push({ id: 's' + ctx.ev.id.slice(0, 10), title, levels: clone(levels) }); ctx.log('Сохранена структура «' + title + '»');
  },
  st_delete(ctx) { ctx.need('structures'); if (ctx.S.structures.length < 2) no('Нужна хотя бы одна структура'); ctx.S.structures = ctx.S.structures.filter(x => x.id !== ctx.p.sid); ctx.log('Удалён шаблон структуры'); },
  st_title(ctx) { ctx.need('structures'); const s = ctx.S.structures.find(x => x.id === ctx.p.sid); if (!s) no('Структура не найдена'); s.title = str(ctx.p.title, 60) || s.title; ctx.log('Структура переименована в «' + s.title + '»'); }
};

/* ---------- что видит конкретный пользователь ---------- */
function view(S, uid, now) {
  const me = U(S, uid);
  const staff = me && me.role !== 'player';
  const mine = x => x.pid === uid;
  const v = {
    now, me, roles: S.roles, structures: staff ? S.structures : [], tournaments: S.tournaments,
    regs: S.regs, results: S.results,
    users: S.users.map(u => staff ? { id: u.id, nick: u.nick, name: u.name, phone: u.phone, role: u.role, first: u.first, noTg: u.noTg, profileDone: u.profileDone } : { id: u.id, nick: u.nick, role: u.role }),
    ops: staff ? S.ops : S.ops.filter(mine),
    pays: staff ? S.pays : S.pays.filter(mine),
    debts: staff ? S.debts : S.debts.filter(mine),
    bonus: staff ? S.bonus : S.bonus.filter(mine),
    notes: S.notes.filter(mine).slice(0, 50),
    log: can(S, uid, 'reports') ? S.log.slice(0, 200) : []
  };
  return v;
}

const api = { MIN, DAY, mkLevels, STD_PAIRS, NICE, nextBB, lvNo, lastPlay, clone, TEMPLATES, PERMS, ROLE_TITLES, POINTS,
  initialState, U, nick, T, can, opsOf, issued, paid, due, regOf, regsOf, blocked, opName, fmt, rub, clockView, rating,
  apply, view, Refused };
if (typeof module !== 'undefined') module.exports = api;
if (typeof window !== 'undefined') window.CORE = api;
})();
