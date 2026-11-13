// Сквозной тест логики: целый вечер турнира через журнал событий + проверка повторного проигрывания.
const assert = require('assert');
const C = require('../core');
let S = C.initialState(); let n = 0; let t0 = Date.parse('2026-11-20T16:00:00Z');
const evs = [];
function ev(uid, type, payload, dt) { t0 += (dt || 1000); const e = { id: 'e' + String(++n).padStart(8, '0'), ts: t0, uid, type, payload }; const tmp = structuredClone(S); const r = C.apply(tmp, e); S = tmp; evs.push(e); return r; }
function refused(fn, msg) { try { fn(); } catch (e) { assert(e instanceof C.Refused, e); if (msg) assert(e.message.includes(msg), e.message); return; } throw new Error('ожидался отказ'); }
const users = ['owner', 'man', 'deal', 'p1', 'p2', 'p3'];
users.forEach(u => { ev(null, 'user_new', { uid: u, tg_id: 1, nick: u, name: u }); ev(u, 'profile', { name: u, nick: u.toUpperCase(), phone: '+7900000000' + users.indexOf(u), dob: '1990-01-01' }); });
assert.equal(C.U(S, 'owner').role, 'owner'); assert.equal(C.U(S, 'p1').role, 'player');
refused(() => ev('p1', 'profile', { name: 'x', nick: 'kid', phone: '1', dob: '2015-01-01' }), '18');
ev('owner', 'set_role', { uid: 'man', role: 'manager' }); ev('owner', 'set_role', { uid: 'deal', role: 'dealer' });
refused(() => ev('deal', 'tour_create', { tpl: 'bounty', date: '2026-11-20' }), 'прав');
ev('man', 'tour_create', { tpl: 'bounty', date: '2026-11-20', time: '19:00' });
const t = S.tournaments[0];
['p1', 'p2', 'p3'].forEach(p => ev(p, 'reg', { tid: t.id }));
ev('man', 'tour_start', { tid: t.id });
['p1', 'p2', 'p3'].forEach(p => ev('man', 'checkin', { tid: t.id, pid: p, table: '1', paidNow: p !== 'p3', method: 'Карта' }));
assert.equal(C.due(S, t.id, 'p1'), 0, 'первый вход бесплатно');
ev('p2', 'req', { tid: t.id, type: 'rebuy', mult: 2 });
const rq = S.ops.find(o => o.status === 'requested');
ev('deal', 'issue_req', { opId: rq.id });
assert.equal(C.due(S, t.id, 'p2'), 1000);
ev('deal', 'issue', { tid: t.id, pid: 'p1', type: 'addon' });
const ad = S.ops.find(o => o.type === 'addon');
ev('deal', 'cancel_op', { opId: ad.id, reason: 'ошибка' }, 60000);
refused(() => ev('deal', 'cancel_op', { opId: S.ops.find(o => o.type === 'rebuy').id, reason: 'x' }, 6 * 60000), '5 минут');
ev('man', 'pay', { tid: t.id, pid: 'p2', amount: 500, method: 'Наличные' });
refused(() => ev('man', 'pay', { tid: t.id, pid: 'p2', amount: 5000 }), 'больше');
// таймер и структура
ev('man', 'st_speed', { tk: 't', sid: t.id, m: 5, scope: 'cur' });
assert(C.clockView(S.tournaments[0], t0).rem <= 5 * C.MIN);
ev('man', 'go_lvl', { tid: t.id, i: S.tournaments[0].levels.length - 1 });
refused(() => ev('man', 'clk_next', { tid: t.id }), 'последний');
ev('man', 'st_auto', { tk: 't', sid: t.id });
ev('man', 'clk_next', { tid: t.id });
ev('man', 'st_lvl', { tk: 't', sid: t.id, i: 'new', sb: 50000, bb: 100000, ante: 100000, dur: 5 });
refused(() => ev('deal', 'st_speed', { tk: 's', sid: 'std', m: 5 }), 'прав');
ev('man', 'close_reg', { tid: t.id });
assert.equal(S.debts.filter(d => d.status === 'open').length, 1, 'p2 должен 500');
refused(() => ev('p2', 'reg', { tid: t.id }), '');
ev('man', 'tour_create', { tpl: 'deep', date: '2026-11-22' });
const t2 = S.tournaments[1];
refused(() => ev('p2', 'reg', { tid: t2.id }), 'долг');
refused(() => ev('man', 'approve_debt', { debtId: S.debts[0].id, until: '2026-11-25', reason: 'ок' }), 'прав');
ev('owner', 'approve_debt', { debtId: S.debts[0].id, until: '2026-11-25', reason: 'оплатит в пятницу' });
ev('p2', 'reg', { tid: t2.id });
ev('man', 'results', { tid: t.id, places: { p1: 2, p2: 1, p3: 3 } });
assert.equal(C.rating(S)[0].pid, 'p2');
ev('man', 'pay', { tid: t.id, pid: 'p2', amount: 500 });
assert.equal(S.debts[0].status, 'closed');
ev('man', 'new_player', { nick: 'Гость', phone: '+79281112233', adult: true });
const g = S.users.find(u => u.noTg);
const lc = ev('man', 'login_code', { pid: g.id, code: '123456' });
assert.equal(lc.extra.code, '123456');
ev('owner', 'set_perm', { role: 'dealer', perm: 'clock', on: true });
assert(C.can(S, 'deal', 'clock'));
ev('man', 'bonus', { pid: 'p1', amount: 300, reason: 'др' });
// повторное проигрывание журнала даёт то же состояние
let R = C.initialState(); evs.forEach(e => C.apply(R, e));
assert.deepStrictEqual(JSON.parse(JSON.stringify(R)), JSON.parse(JSON.stringify(S)));
// вид игрока не содержит чужих операций и телефонов
const v = C.view(S, 'p1', t0);
assert(v.ops.every(o => o.pid === 'p1')); assert(v.users.every(u => !u.phone)); assert.equal(v.log.length, 0);
console.log('OK: событий ' + evs.length + ', всё сходится');
