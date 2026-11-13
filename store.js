'use strict';
// Хранилище журнала для обычного Node-сервера: PostgreSQL через pg (DATABASE_URL) или файл data/ (локально).
const fs = require('fs');
const path = require('path');
function createStore() {
  const URL_ = process.env.DATABASE_URL;
  if (URL_ && process.env.DB_DRIVER === 'http') return require('./store-http').createHttpStore(URL_);
  if (URL_) {
    let pool;
    return {
      async init() {
        const { Pool } = require('pg');
        pool = new Pool({ connectionString: URL_, ssl: /localhost|127\.0\.0\.1/.test(URL_) ? false : { rejectUnauthorized: false }, max: 5 });
        await pool.query("CREATE TABLE IF NOT EXISTS events (seq BIGSERIAL PRIMARY KEY, id TEXT UNIQUE NOT NULL, ts BIGINT NOT NULL, uid TEXT, type TEXT NOT NULL, payload JSONB NOT NULL DEFAULT '{}'::jsonb)");
        await pool.query('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)');
      },
      async since(seq) { const r = await pool.query('SELECT seq, id, ts, uid, type, payload FROM events WHERE seq > $1 ORDER BY seq', [seq || 0]); return r.rows.map(x => ({ seq: Number(x.seq), id: x.id, ts: Number(x.ts), uid: x.uid, type: x.type, payload: x.payload })); },
      async append(ev) { await pool.query('INSERT INTO events (id, ts, uid, type, payload) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING', [ev.id, ev.ts, ev.uid, ev.type, JSON.stringify(ev.payload || {})]); },
      async getKV(k) { const r = await pool.query('SELECT v FROM kv WHERE k=$1', [k]); return r.rows[0] ? r.rows[0].v : null; },
      async setKV(k, v) { await pool.query('INSERT INTO kv (k,v) VALUES ($1,$2) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v', [k, v]); }
    };
  }
  const dir = path.join(__dirname, 'data'), F = path.join(dir, 'events.jsonl'), KV = path.join(dir, 'kv.json');
  return {
    async init() { fs.mkdirSync(dir, { recursive: true }); if (!fs.existsSync(F)) fs.writeFileSync(F, ''); if (!fs.existsSync(KV)) fs.writeFileSync(KV, '{}'); },
    async since(seq) { return fs.readFileSync(F, 'utf8').split('\n').filter(Boolean).map((l, i) => Object.assign(JSON.parse(l), { seq: i + 1 })).filter(e => e.seq > (seq || 0)); },
    async append(ev) { const all = await this.since(0); if (all.some(e => e.id === ev.id)) return; fs.appendFileSync(F, JSON.stringify(ev) + '\n'); },
    async getKV(k) { return JSON.parse(fs.readFileSync(KV, 'utf8'))[k] ?? null; },
    async setKV(k, v) { const o = JSON.parse(fs.readFileSync(KV, 'utf8')); o[k] = v; fs.writeFileSync(KV, JSON.stringify(o)); }
  };
}
module.exports = { createStore };
