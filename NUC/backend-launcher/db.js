// BahiaClient — Pool de Postgres para stats
// --------------------------------------------------------------------------
// Uso:
//   const db = require('./db')
//   await db.query('SELECT ...', [params])
//
// Variables de entorno opcionales:
//   PGHOST      (default: 127.0.0.1)
//   PGPORT      (default: 5432)
//   PGUSER      (default: postgres)
//   PGPASSWORD  (default: null)
//   PGDATABASE  (default: bahiaclient)

const { Pool } = require('pg')

const PG_PASSWORD = process.env.PGPASSWORD
if (!PG_PASSWORD) {
  console.error('[db] FALTA PGPASSWORD en el entorno. Abortando para no conectar con un default inseguro.')
  process.exit(1)
}

const pool = new Pool({
  host: process.env.PGHOST || '127.0.0.1',
  port: parseInt(process.env.PGPORT || '5432', 10),
  user: process.env.PGUSER || 'bahiaclient',
  password: PG_PASSWORD,
  database: process.env.PGDATABASE || 'bahiaclient',
  max: parseInt(process.env.PGPOOL_MAX || '10', 10),
  idleTimeoutMillis: parseInt(process.env.PGIDLE_TIMEOUT || '30000', 10),
  connectionTimeoutMillis: parseInt(process.env.PGCONN_TIMEOUT || '5000', 10),
  statement_timeout: parseInt(process.env.PG_STATEMENT_TIMEOUT || '15000', 10),
  query_timeout: parseInt(process.env.PG_QUERY_TIMEOUT || '15000', 10),
  application_name: 'bahiaclient-presence',
  keepAlive: true,
  ssl: process.env.PGSSL === '1'
    ? { rejectUnauthorized: process.env.PGSSL_REJECT_UNAUTHORIZED !== '0' }
    : false,
})

let _dbErrorCount = 0
let _dbLastErrorAt = 0
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
  // Descomentar para debug de conexiones nuevas
  // console.log('[db] nueva conexión al pool')
})

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
    console.warn('[db] shutdown forzado:', e.message)
    process.exit(1)
  }
}

async function query(sql, params) {
  const start = Date.now()
  if (typeof sql !== 'string' || !sql.length) {
    throw new Error('[db] query() requiere un string SQL válido')
  }
  try {
    const res = await pool.query(sql, params)
    const ms = Date.now() - start
    const SLOW_MS = parseInt(process.env.PG_SLOW_MS || '500', 10)
    if (ms > SLOW_MS) {
      // Solo primeras 80 chars, y colapsar whitespace para no inundar logs
      const compactSql = sql.replace(/\s+/g, ' ').slice(0, 80)
      console.warn(`[db] query lenta (${ms}ms):`, compactSql)
    }
    return res
  } catch (e) {
    console.error('[db] error en query:', e.message, '|', sql.slice(0, 100))
    throw e
  }
}

async function testConnection() {
  try {
    const r = await query('SELECT NOW() AS now, version() AS version')
    const row = r.rows[0]
    const versionShort = String(row.version || '').split(' ').slice(0, 2).join(' ')
    console.log(`[db] conectado a postgres (${versionShort}) @ ${row.now}`)
    return true
  } catch (e) {
    const code = e.code || 'unknown'
    const hints = {
      '28P01': 'password incorrecta (revisá PGPASSWORD)',
      '3D000': 'database no existe (revisá PGDATABASE)',
      'ECONNREFUSED': 'postgres no está corriendo en ese host:port',
      'ENOTFOUND': 'hostname no resuelve (revisá PGHOST)',
      'ETIMEDOUT': 'timeout de conexión (¿firewall?)',
    }
    console.error(`[db] no se pudo conectar (code=${code}):`, hints[code] || e.message)
    return false
  }
}

async function withTransaction(fn) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (e) {
    try { await client.query('ROLLBACK') } catch (_) {}
    throw e
  } finally {
    client.release()
  }
}

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
    }
  } catch (e) {
    return { ok: false, error: e.message, total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount }
  }
}

module.exports = { pool, query, withTransaction, healthCheck, testConnection }