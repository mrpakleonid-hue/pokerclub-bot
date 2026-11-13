// Хранилище журнала через Neon SQL-over-HTTP (без драйверов). Используется в Neon Functions.
(function () {
'use strict';
function createHttpStore(connStr) {
  const host = new URL(connStr).hostname;
  async function q(query, params) {
    const r = await fetch('https://' + host + '/sql', {
      method: 'POST',
      headers: { 'Neon-Connection-String': connStr, 'Neon-Raw-Text-Output': 'true', 'Neon-Array-Mode': 'true', 'content-type': 'application/json' },
      body: JSON.stringify({ query, params: params || [] })
    });
    const text = await r.text(); let j = {}; try { j = JSON.parse(text); } catch (e) {}
    if (!r.ok) throw new Error('db ' + r.status + ' ' + (j.message || text.slice(0, 200)));
    return j.rows || [];
  }
  return {
    async init() {
      await q('CREATE TABLE IF NOT EXISTS events (seq BIGSERIAL PRIMARY KEY, id TEXT UNIQUE NOT NULL, ts BIGINT NOT NULL, uid TEXT, type TEXT NOT NULL, payload JSONB NOT NULL DEFAULT \'{}\'::jsonb)');
      await q('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)');
    },
    async since(seq) {
      const rows = await q('SELECT seq, id, ts, uid, type, payload::text FROM events WHERE seq > $1 ORDER BY seq', [String(seq || 0)]);
      return rows.map(r => ({ seq: Number(r[0]), id: r[1], ts: Number(r[2]), uid: r[3], type: r[4], payload: JSON.parse(r[5] || '{}') }));
    },
    async append(ev) { await q('INSERT INTO events (id, ts, uid, type, payload) VALUES ($1,$2,$3,$4,$5::jsonb) ON CONFLICT (id) DO NOTHING', [ev.id, String(ev.ts), ev.uid, ev.type, JSON.stringify(ev.payload || {})]); },
    async getKV(k) { const r = await q('SELECT v FROM kv WHERE k = $1', [k]); return r[0] ? r[0][0] : null; },
    async setKV(k, v) { await q('INSERT INTO kv (k, v) VALUES ($1,$2) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v', [k, v]); }
  };
}
if (typeof module !== 'undefined') module.exports = { createHttpStore };
globalThis.CASTLE = Object.assign(globalThis.CASTLE || {}, { createHttpStore });
})();
