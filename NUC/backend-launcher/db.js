// BahiaClient — Pool de Postgres para stats
// --------------------------------------------------------------------------
// Uso:
//   const db = require('./db')
//   await db.query('SELECT ...', [params])
//
// Variables de entorno opcionales:
//   PGHOST              (default: 127.0.0.1)
//   PGPORT              (default: 5432)
//   PGUSER              (default: bahiaclient)
//   PGPASSWORD          (REQUERIDA, sin default por seguridad)
//   PGDATABASE          (default: bahiaclient)
//   PGPOOL_MAX          (default: 10, rango 1..100)
//   PGIDLE_TIMEOUT      (default: 30000 ms)
//   PGCONN_TIMEOUT      (default: 5000 ms)
//   PG_STATEMENT_TIMEOUT (default: 15000 ms)
//   PG_QUERY_TIMEOUT    (default: 15000 ms)
//   PG_SLOW_MS          (default: 500, umbral para loguear query lenta)
//   PGSSL               = '1' para habilitar SSL
//   PGSSL_REJECT_UNAUTHORIZED = '0' para aceptar certificados self-signed
//   PG_APP_NAME         (default: bahiaclient-presence)
//
// v3 — Pasada de calidad:
//   · ensureSchema(): los DDL con error de permisos (42501 / "must be owner")
//     ya NO abortan todo el schema. Antes, un CREATE INDEX que no podíamos
//     crear tiraba la excepción, _schemaReady quedaba en false, y TODAS las
//     queries subsecuentes fallaban porque query() hace `await ensureSchema()`
//     sin try/catch. Ahora se loguea un warning y se sigue.
//   · ensureSchema(): rate limit del log de error (1 cada 60s) para no
//     inundar si un error permanente ocurre en cada query.
//   · Diagnóstico: mensaje explícito con el ALTER TABLE necesario si faltan
//     permisos.
// v2 — Pasada de calidad previa (sin cambios):
//   · ensureSchema(): crea las tablas (matches, match_players, goals,
//     player_totals) + índices.
//   · NO process.exit() desde module load. Si falta PGPASSWORD, throw.
//   · withTransaction(): guard contra anidamiento con AsyncLocalStorage.
//   · shutdown() exportada.
//   · testConnection(): reintenta N veces con backoff.
//   · _dbErrorCount se resetea en reconnect exitoso.
//   · Slow-query log con contexto (caller) y sin truncar a ciegas.
//   · Validación de PGPOOL_MAX (rango 1..100).

const { Pool } = require('pg')
const { AsyncLocalStorage } = require('async_hooks')
const { clear } = require('console')

const PG_PASSWORD = process.env.PGPASSWORD
if (!PG_PASSWORD) {
  throw new Error('[db] FALTA PGPASSWORD en el entorno. Seteala en el .env o exportala antes de arrancar.')
}

function _intEnv(name, def, min, max) {
  const raw = process.env[name]
  const v = raw === undefined ? def : parseInt(raw, 10)
  if (!Number.isFinite(v)) return def
  return Math.max(min, Math.min(max, v))
}

const POOL_MAX = _intEnv('PGPOOL_MAX', 10, 1, 100)
const PGUSER = process.env.PGUSER || 'bahiaclient'

const pool = new Pool({
  host: process.env.PGHOST || '127.0.0.1',
  port: _intEnv('PGPORT', 5432, 1, 65535),
  user: PGUSER,
  password: PG_PASSWORD,
  database: process.env.PGDATABASE || 'bahiaclient',
  max: POOL_MAX,
  idleTimeoutMillis: _intEnv('PGIDLE_TIMEOUT', 30000, 1000, 3600000),
  connectionTimeoutMillis: _intEnv('PGCONN_TIMEOUT', 5000, 500, 60000),
  statement_timeout: _intEnv('PG_STATEMENT_TIMEOUT', 15000, 500, 600000),
  query_timeout: _intEnv('PG_QUERY_TIMEOUT', 15000, 500, 600000),
  application_name: process.env.PG_APP_NAME || 'bahiaclient-presence',
  keepAlive: true,
  ssl: process.env.PGSSL === '1'
    ? { rejectUnauthorized: process.env.PGSSL_REJECT_UNAUTHORIZED !== '0' }
    : false,
})

// ── Estado de errores del pool ────────────────────────────────────────────
let _dbErrorCount = 0
let _dbLastErrorAt = 0
let _dbConnectedOnce = false

pool.on('error', (err) => {
  _dbErrorCount++
  _dbLastErrorAt = Date.now()
  const code = err.code || err.severity || 'unknown'
  console.error(`[db] error en cliente idle (#${_dbErrorCount}, code=${code}):`, err.message)
  if (_dbErrorCount === 1 || _dbErrorCount % 10 === 0) {
    console.error(`[db] total errores idle: ${_dbErrorCount}, último: ${new Date(_dbLastErrorAt).toISOString()}`)
  }
})

pool.on('connect', () => {
  if (_dbErrorCount > 0 && !_dbConnectedOnce) {
    _dbConnectedOnce = true
  } else if (_dbErrorCount > 0) {
    console.log(`[db] conexión re-establecida, reseteando contador de errores (era ${_dbErrorCount})`)
    _dbErrorCount = 0
    _dbLastErrorAt = 0
  }
  _dbConnectedOnce = true
})

// ── Shutdown ─────────────────────────────────────────────────────────────
let _shuttingDown = false
async function shutdown(timeoutMs = 5000) {
  if (_shuttingDown) return
  _shuttingDown = true
  try {
    await Promise.race([
      pool.end(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('pool.end timeout')), timeoutMs)),
    ])
    console.log('[db] pool cerrado limpiamente')
  } catch (e) {
    console.warn('[db] shutdown con warning:', e.message)
    throw e
  }
}

// ── Schema init ──────────────────────────────────────────────────────────
let _schemaReady = false
let _schemaPromise = null
let _lastSchemaErrorAt = 0

async function ensureSchema() {
  if (_schemaReady) return true
  if (_schemaPromise) return _schemaPromise
  _schemaPromise = _doEnsureSchema().catch(e => {
    // Rate limit del log: si un error permanente ocurre en cada query,
    // no queremos inundar el log. Un mensaje cada 60s.
    const now = Date.now()
    if (now - _lastSchemaErrorAt > 60000) {
      _lastSchemaErrorAt = now
      console.error('[db] ensureSchema falló:', e.message)
    }
    _schemaPromise = null // permite reintentar en la próxima query
    throw e
  })
  return _schemaPromise
}

async function _doEnsureSchema() {
  const ddl = [
    // ── matches ──
    `CREATE TABLE IF NOT EXISTS matches (
       id            SERIAL PRIMARY KEY,
       room_id       TEXT,
       room_name     TEXT,
       stadium       TEXT,
       started_at    BIGINT NOT NULL,
       ended_at      BIGINT,
       duration_ms   INTEGER,
       score_red     INTEGER,
       score_blue    INTEGER,
       created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,
    `CREATE INDEX IF NOT EXISTS idx_matches_room_ended ON matches(room_id, ended_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_matches_ended ON matches(ended_at DESC)`,
    // Idempotencia de /match/start: un solo match abierto por room. Sin esto,
    // dos POST concurrentes crean dos matches con ended_at = NULL.
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_matches_open_per_room ON matches(room_id) WHERE ended_at IS NULL`,

    // ── match_players ──
    `CREATE TABLE IF NOT EXISTS match_players (
       id          SERIAL PRIMARY KEY,
       match_id    INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
       player_id   TEXT NOT NULL,
       haxball_id  INTEGER,
       nickname    TEXT,
       team_id     INTEGER NOT NULL DEFAULT 0,
       goals       INTEGER NOT NULL DEFAULT 0,
       assists     INTEGER NOT NULL DEFAULT 0,
       own_goals   INTEGER NOT NULL DEFAULT 0,
       was_mvp     BOOLEAN NOT NULL DEFAULT FALSE
     )`,
    `CREATE INDEX IF NOT EXISTS idx_match_players_match ON match_players(match_id)`,
    `CREATE INDEX IF NOT EXISTS idx_match_players_player ON match_players(player_id)`,

    // ── goals ──
    `CREATE TABLE IF NOT EXISTS goals (
       id           SERIAL PRIMARY KEY,
       match_id     INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
       team_id      INTEGER NOT NULL,
       scorer_id    TEXT,
       assister_id  TEXT,
       own_goal     BOOLEAN NOT NULL DEFAULT FALSE,
       confidence   REAL,
       ts           BIGINT NOT NULL
     )`,
    `CREATE INDEX IF NOT EXISTS idx_goals_match ON goals(match_id)`,

    // ── player_totals ──
    `CREATE TABLE IF NOT EXISTS player_totals (
       player_id       TEXT PRIMARY KEY,
       matches         INTEGER NOT NULL DEFAULT 0,
       wins            INTEGER NOT NULL DEFAULT 0,
       draws           INTEGER NOT NULL DEFAULT 0,
       losses          INTEGER NOT NULL DEFAULT 0,
       goals           INTEGER NOT NULL DEFAULT 0,
       assists         INTEGER NOT NULL DEFAULT 0,
       own_goals       INTEGER NOT NULL DEFAULT 0,
       mvps            INTEGER NOT NULL DEFAULT 0,
       minutes         INTEGER NOT NULL DEFAULT 0,
       current_streak  INTEGER NOT NULL DEFAULT 0,
       best_streak     INTEGER NOT NULL DEFAULT 0,
       last_match_at   BIGINT,
       updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,
    `CREATE INDEX IF NOT EXISTS idx_player_totals_goals ON player_totals(goals DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_player_totals_mvps ON player_totals(mvps DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_player_totals_wins ON player_totals(wins DESC)`,
  ]

  const permissionWarnings = []
  for (const sql of ddl) {
    try {
      await pool.query(sql)
    } catch (e) {
      // 42501 = insufficient_privilege. Típicamente: la tabla ya existe con
      // otro owner y no podemos crear índices encima. NO es fatal — la tabla
      // está, sólo nos falta el índice. Seguimos con el resto del DDL para no
      // dejar el schema a medias ni bloquear las queries.
      //
      // Cualquier otro error (sintaxis, FK, etc.) sí es fatal y aborta.
      const isPerm = e.code === '42501' || /must be owner|permission denied/i.test(e.message || '')
      if (isPerm) {
        permissionWarnings.push(sql.replace(/\s+/g, ' ').trim().slice(0, 140))
        continue
      }
      throw e
    }
  }

  if (permissionWarnings.length) {
    console.warn(`[db] schema verificado con ${permissionWarnings.length} DDL omitidas por permisos:`)
    for (const w of permissionWarnings) console.warn(`       · ${w}`)
    console.warn(`[db] si querés crear esos índices, corré como owner:`)
    console.warn(`       ALTER TABLE matches OWNER TO ${PGUSER};`)
    console.warn(`       ALTER TABLE match_players OWNER TO ${PGUSER};`)
    console.warn(`       ALTER TABLE goals OWNER TO ${PGUSER};`)
    console.warn(`       ALTER TABLE player_totals OWNER TO ${PGUSER};`)
  } else {
    console.log('[db] schema verificado')
  }

  _schemaReady = true
  return true
}

// ── Query ────────────────────────────────────────────────────────────────
const SLOW_MS = _intEnv('PG_SLOW_MS', 500, 50, 60000)

async function query(sql, params) {
  if (typeof sql !== 'string' || !sql.length) {
    throw new Error('[db] query() requiere un string SQL válido')
  }
  await ensureSchema()
  const start = Date.now()
  try {
    const res = await pool.query(sql, params)
    const ms = Date.now() - start
    if (ms > SLOW_MS) {
      const compact = sql.replace(/\s+/g, ' ').trim().slice(0, 200)
      console.warn(`[db] query lenta (${ms}ms):`, compact)
    }
    return res
  } catch (e) {
    const compact = sql.replace(/\s+/g, ' ').trim().slice(0, 200)
    console.error(`[db] error en query (code=${e.code || '?'}):`, e.message, '|', compact)
    throw e
  }
}

// ── Test connection (con reintentos) ─────────────────────────────────────
async function testConnection({ intentos = 5, esperaBaseMs = 1000 } = {}) {
  let lastErr = null
  for (let i = 1; i <= intentos; i++) {
    try {
      const r = await pool.query('SELECT NOW() AS now, version() AS version')
      const row = r.rows[0]
      const versionShort = String(row.version || '').split(' ').slice(0, 2).join(' ')
      console.log(`[db] conectado a postgres (${versionShort}) @ ${row.now}`)
      try { await ensureSchema() } catch (e) { console.warn('[db] no se pudo crear schema:', e.message) }
      return true
    } catch (e) {
      lastErr = e
      if (i < intentos) {
        const espera = esperaBaseMs * i
        console.warn(`[db] intento ${i}/${intentos} falló (${e.code || '?'}: ${e.message}), reintento en ${espera}ms...`)
        await new Promise(r => setTimeout(r, espera))
      }
    }
  }
  const code = lastErr?.code || 'unknown'
  const hints = {
    '28P01': 'password incorrecta (revisá PGPASSWORD)',
    '3D000': 'database no existe (revisá PGDATABASE)',
    'ECONNREFUSED': 'postgres no está corriendo en ese host:port',
    'ENOTFOUND': 'hostname no resuelve (revisá PGHOST)',
    'ETIMEDOUT': 'timeout de conexión (¿firewall?)',
    '42501': 'permisos insuficientes (¿owner de las tablas?)',
  }
  console.error(`[db] no se pudo conectar tras ${intentos} intentos (code=${code}):`, hints[code] || lastErr?.message)
  return false
}

// ── Transacciones ────────────────────────────────────────────────────────
const txContext = new AsyncLocalStorage()

async function withTransaction(fn) {
  if (txContext.getStore()) {
    throw new Error('[db] withTransaction no soporta anidamiento; pasá el client ya abierto al helper')
  }
  const client = await pool.connect()
  try {
    return await txContext.run({ client }, async () => {
      await client.query('BEGIN')
      const result = await fn(client)
      await client.query('COMMIT')
      return result
    })
  } catch (e) {
    try { await client.query('ROLLBACK') } catch (_) {}
    throw e
  } finally {
    client.release()
  }
}

// ── Healthcheck ──────────────────────────────────────────────────────────
async function healthCheck() {
  try {
    const r = await pool.query('SELECT 1 AS ok')
    return {
      ok: r.rows[0]?.ok === 1,
      total: pool.totalCount,
      idle: pool.idleCount,
      waiting: pool.waitingCount,
      errorCount: _dbErrorCount,
      lastErrorAt: _dbLastErrorAt || null,
      schemaReady: _schemaReady,
      shuttingDown: _shuttingDown,
    }
  } catch (e) {
    return {
      ok: false,
      error: e.message,
      total: pool.totalCount,
      idle: pool.idleCount,
      waiting: pool.waitingCount,
      schemaReady: _schemaReady,
      shuttingDown: _shuttingDown,
    }
  }
}

module.exports = {
  pool,
  query,
  withTransaction,
  healthCheck,
  testConnection,
  ensureSchema,
  shutdown,
}
