'use strict';
// Хранилище журнала событий. На сервере — PostgreSQL (DATABASE_URL), локально — файл events.jsonl.
// Записи только добавляются, никогда не меняются и не удаляются.
const fs = require('fs');
const path = require('path');

const URL_ = process.env.DATABASE_URL;
let pool = null;
const FILE = path.join(__dirname, 'data', 'events.jsonl');

async function init() {
  if (URL_) {
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: URL_, ssl: /localhost|127\.0\.0\.1/.test(URL_) || process.env.PGSSL === 'off' ? false : { rejectUnauthorized: false }, max: 5 });
    await pool.query(`CREATE TABLE IF NOT EXISTS events (
      seq BIGSERIAL PRIMARY KEY,
      id TEXT UNIQUE NOT NULL,
      ts BIGINT NOT NULL,
      uid TEXT,
      type TEXT NOT NULL,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb
    )`);
  } else {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    if (!fs.existsSync(FILE)) fs.writeFileSync(FILE, '');
    console.log('DATABASE_URL не задан — журнал пишется в файл ' + FILE);
  }
}
async function all() {
  if (pool) {
    const r = await pool.query('SELECT id, ts, uid, type, payload FROM events ORDER BY seq');
    return r.rows.map(x => ({ id: x.id, ts: Number(x.ts), uid: x.uid, type: x.type, payload: x.payload }));
  }
  return fs.readFileSync(FILE, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
}
async function append(ev) {
  if (pool) {
    await pool.query('INSERT INTO events (id, ts, uid, type, payload) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING', [ev.id, ev.ts, ev.uid, ev.type, JSON.stringify(ev.payload || {})]);
  } else {
    fs.appendFileSync(FILE, JSON.stringify(ev) + '\n');
  }
}
module.exports = { init, all, append };
