/* opengym-api — camada de armazenamento.
   Dois backends, escolhidos por variável de ambiente:
   - Postgres (Supabase, Railway Postgres, etc.) quando DATABASE_URL está definida
   - Arquivos JSON em DATA_DIR caso contrário (docker compose self-host, comportamento
     original: db.json, state-<uid>.json, audit.log, secret e vapid.json)

   Em modo Postgres, tabelas criadas automaticamente no primeiro boot:
     app_kv(key text primary key, value jsonb)            — documento db + secret + chaves VAPID
     user_state(uid text primary key, state jsonb, ...)   — estado por usuário (planos, treinos…)
     audit_events(id bigserial primary key, rec jsonb)    — log de atividade                          */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DATABASE_URL = process.env.DATABASE_URL || '';
export const USE_PG = !!DATABASE_URL;
const DATA = process.env.DATA_DIR || '/data';

let pg = null;          // lazy: módulo pg só é carregado em modo Postgres
let client = null;

/* ---------------- init ---------------- */
export async function init() {
  if (!USE_PG) {
    fs.mkdirSync(DATA, { recursive: true });
    return;
  }
  pg = (await import('pg')).default;
  // Supabase e outros provedores exigem TLS fora do localhost; sslmode=disable desliga.
  const needsSsl = !/(localhost|127\.0\.0\.1|\[::1\])/.test(DATABASE_URL) && !/sslmode=disable/i.test(DATABASE_URL);
  client = new pg.Client({
    connectionString: DATABASE_URL,
    connectionTimeoutMillis: 10000,   // falha rápido em vez de pendurar o boot
    ...(needsSsl ? { ssl: { rejectUnauthorized: false } } : {})
  });
  client.on('error', e => console.error('pg connection error', e.message));
  await client.connect();
  await client.query(`
    CREATE TABLE IF NOT EXISTS app_kv (
      key   text PRIMARY KEY,
      value jsonb NOT NULL
    );
    CREATE TABLE IF NOT EXISTS user_state (
      uid        text PRIMARY KEY,
      state      jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS audit_events (
      id  bigint PRIMARY KEY,
      rec jsonb NOT NULL
    );
  `);
}

/* ---------------- key/value interno (apenas modo Postgres) ---------------- */
async function kvGet(key) {
  const r = await client.query('SELECT value FROM app_kv WHERE key = $1', [key]);
  return r.rows.length ? r.rows[0].value : null;
}
async function kvSet(key, value) {
  await client.query(
    'INSERT INTO app_kv (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
    [key, JSON.stringify(value)]
  );
}

/* ---------------- secret da sessão ---------------- */
export async function getSecret() {
  if (!USE_PG) {
    const f = path.join(DATA, 'secret');
    if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
    return fs.readFileSync(f, 'utf8').trim();
  }
  let s = await kvGet('secret');
  if (!s) { s = crypto.randomBytes(32).toString('hex'); await kvSet('secret', s); }
  return s;
}

/* ---------------- chaves VAPID (push) ---------------- */
export async function getVapid() {
  if (!USE_PG) {
    try { return JSON.parse(fs.readFileSync(path.join(DATA, 'vapid.json'), 'utf8')); }
    catch { return null; }
  }
  return kvGet('vapid');
}
export async function setVapid(vapid) {
  if (!USE_PG) {
    atomicWrite(path.join(DATA, 'vapid.json'), JSON.stringify(vapid), { mode: 0o600 });
    return;
  }
  await kvSet('vapid', vapid);
}

/* ---------------- documento db (users, creds, subs, invites) ---------------- */
const DEFAULT_DB = { users: [], creds: [], subs: [], invites: [] };
const dbFile = () => path.join(DATA, 'db.json');

export async function loadDb() {
  if (!USE_PG) {
    try { return JSON.parse(fs.readFileSync(dbFile(), 'utf8')); } catch { return { ...DEFAULT_DB }; }
  }
  const doc = await kvGet('db');
  return doc && typeof doc === 'object' ? doc : { ...DEFAULT_DB };
}

// Write-through assíncrono: o servidor muta o objeto em memória e persiste sem bloquear.
export function saveDb(db) {
  // gravações serializadas para nunca persistir versões fora de ordem
  dbQueue = dbQueue.then(() => kvOrFileSave(db)).catch(e => console.error('db save failed', e.message));
}
let dbQueue = Promise.resolve();
async function kvOrFileSave(db) {
  if (!USE_PG) { atomicWrite(dbFile(), JSON.stringify(db, null, 2)); return; }
  await kvSet('db', db);
}

/* ---------------- estado por usuário ---------------- */
const uidSafe = uid => String(uid).replace(/[^a-zA-Z0-9_-]/g, '');
const stateFile = uid => path.join(DATA, 'state-' + uidSafe(uid) + '.json');

export async function readState(uid) {
  if (!USE_PG) {
    try { return JSON.parse(fs.readFileSync(stateFile(uid), 'utf8')); } catch { return null; }
  }
  const r = await client.query('SELECT state FROM user_state WHERE uid = $1', [uid]);
  return r.rows.length ? r.rows[0].state : null;
}

export async function writeState(uid, state) {
  if (!USE_PG) { atomicWrite(stateFile(uid), JSON.stringify(state)); return; }
  await client.query(
    `INSERT INTO user_state (uid, state, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (uid) DO UPDATE SET state = EXCLUDED.state, updated_at = now()`,
    [uid, JSON.stringify(state)]
  );
}

/* ---------------- log de auditoria ---------------- */
const auditFile = () => path.join(DATA, 'audit.log');

// Append serializado: mantém a ordem dos eventos mesmo com chamadas concorrentes.
let auditQueue = Promise.resolve();

export function auditAppend(rec) {
  auditQueue = auditQueue.then(() => doAuditAppend(rec)).catch(e => console.error('audit write failed', e.message));
  return auditQueue;
}
async function doAuditAppend(rec) {
  if (!USE_PG) { atomicAppend(auditFile(), JSON.stringify(rec) + '\n'); return; }
  await client.query('INSERT INTO audit_events (id, rec) VALUES ($1, $2)', [rec.id, JSON.stringify(rec)]);
}

export async function auditAll() {
  if (!USE_PG) {
    let text;
    try { text = fs.readFileSync(auditFile(), 'utf8'); } catch { return []; }
    const rows = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      try { const r = JSON.parse(line); if (r && r.id && r.ev) rows.push(r); } catch { /* linha truncada */ }
    }
    return rows;
  }
  const r = await client.query('SELECT rec FROM audit_events ORDER BY id ASC');
  return r.rows.map(x => x.rec).filter(r => r && r.id && r.ev);
}

// Substitui o log inteiro pelos eventos retidos (compactação).
export async function auditRewrite(rows) {
  if (!USE_PG) {
    atomicWrite(auditFile(), rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
    return;
  }
  const ids = rows.map(r => Number(r.id)).filter(Number.isFinite);
  if (ids.length === rows.length && rows.length) {
    await client.query('DELETE FROM audit_events WHERE NOT (id = ANY($1::bigint[]))', [ids]);
  } else {
    await client.query('DELETE FROM audit_events');
    for (const r of rows) {
      if (Number.isFinite(Number(r.id))) {
        await client.query('INSERT INTO audit_events (id, rec) VALUES ($1, $2)', [Number(r.id), JSON.stringify(r)]);
      }
    }
  }
}

export async function auditClear() {
  if (!USE_PG) { try { fs.unlinkSync(auditFile()); } catch { /* nada logado ainda */ } return; }
  await client.query('DELETE FROM audit_events');
}

export async function auditMaxId() {
  if (!USE_PG) return 0;                       // semeado pela leitura do arquivo em compactAudit()
  const r = await client.query('SELECT COALESCE(MAX(id), 0)::bigint AS m FROM audit_events');
  return Number(r.rows[0].m);
}

/* ---------------- helpers de arquivo (modo JSON apenas) ---------------- */
function atomicWrite(file, content, opts) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, content, opts);
  fs.renameSync(tmp, file);
}
function atomicAppend(file, content) {
  fs.appendFileSync(file, content);
}
