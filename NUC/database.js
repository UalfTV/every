/**
 * database.js — Capa de persistencia del bot de Haxball
 *
 * Estructura:
 *   · Dos pools independientes:
 *       - poolSala   → datos específicos de esta sala (players, records, backups, clanes, admins_auto).
 *       - poolGlobal → datos compartidos entre todas las salas (player_globals,
 *                      nombres_reservados, players_bans, bot_state).
 *   · Schema init idempotente (ensureSchema). Se llama una vez al arranque.
 *   · Toda query va parametrizada — nada de concatenación de strings.
 *   · Todos los accessors abren cliente, ejecutan y liberan en finally. Nada
 *     de conexiones colgadas.
 *   · El Logger escribe a logs/<file>.log con rotación por tamaño. NO reasigna
 *     console.* global — eso era un bug (recursión infinita, stack overflow).
 *
 * Convenciones de naming:
 *   · key del jugador → mismo valor que getPlayerKey() en index.js
 *                       (auth Haxball | anon_conn_X | anon_nombre).
 *   · roomId         → identificador de la sala (ej. "HA", "HA2").
 *   · data JSONB     → blob serializado del estado del jugador en index.js.
 */
require("dotenv").config({ path: process.env.ENV_FILE || ".env" });
const fs = require("fs").promises;
const fsSync = require("fs");
const path = require("path");
const { Pool } = require("pg");

// ============================================================
// CONFIG BÁSICA
// ============================================================
const LOG_DIR = process.env.LOG_DIR || "./logs";
const LOG_MAX_BYTES = 5 * 1024 * 1024;
const MAX_BATCH_SIZE = 500;
const BACKUP_DEFAULT_KEEP = 20;

// ============================================================
// LOGGER — arreglo crítico del bug de recursión infinita.
// El archivo original tenía:
//     const Logger = { info: (msg) => Logger.info(`[DB] ${msg}`) };
//     console.log = Logger.info;
// Lo cual producía stack overflow en el primer console.log. Ahora el Logger
// escribe directamente a archivo y NO toca console.* global.
// ============================================================
if (!fsSync.existsSync(LOG_DIR)) fsSync.mkdirSync(LOG_DIR, { recursive: true });

async function _writeLog(file, msg) {
    try {
        const fp = path.join(LOG_DIR, file);
        try {
            const st = await fs.stat(fp);
            if (st.size > LOG_MAX_BYTES) await fs.rename(fp, fp.replace(/\.log$/, ".old.log"));
        } catch (_) { /* archivo no existe todavía */ }
        await fs.appendFile(fp, `[${new Date().toISOString()}] ${msg}\n`);
    } catch (_) { /* si el log falla, no reventamos el caller */ }
}

const Logger = {
    info: (msg) => { _writeLog('db-info.log', msg); },
    warn: (msg) => { _writeLog('db-warn.log', `⚠️ ${msg}`); },
    error: (msg, error = null) => {
        const stack = error ? `\n${error.stack || error}` : '';
        _writeLog('db-errors.log', `❌ ${msg}${stack}`);
    },
    debug: (msg) => { if (process.env.DB_DEBUG === "1") _writeLog('db-debug.log', msg); },
};

// ============================================================
// POOLS
// ============================================================
const PG_CONFIG_BASE = {
    host: process.env.PGHOST || "127.0.0.1",
    port: Number(process.env.PGPORT) || 5432,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    max: Number(process.env.PG_MAX_CLIENTS) || 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 8_000,
    statement_timeout: 15_000,
    query_timeout: 15_000,
    ssl: process.env.PGSSL === "1" ? { rejectUnauthorized: false } : false,
    application_name: `haxbot-${process.env.ROOM_ID || "HA"}`,
};

const PG_CONFIG_SALA = {
    ...PG_CONFIG_BASE,
    database: process.env.PGDATABASE,
    application_name: `haxbot-sala-${process.env.ROOM_ID || "HA"}`,
};

const PG_CONFIG_GLOBAL = {
    ...PG_CONFIG_BASE,
    database: process.env.PGDATABASE_GLOBAL || process.env.PGDATABASE,
    application_name: `haxbot-global-${process.env.ROOM_ID || "HA"}`,
};

let poolSala = null;
let poolGlobal = null;
let schemaListo = false;

function getPool() {
    if (!poolSala) {
        poolSala = new Pool(PG_CONFIG_SALA);
        poolSala.on("error", (e) => Logger.error(`Pool sala idle client error`, e));
    }
    return poolSala;
}

function getGlobalPool() {
    if (!poolGlobal) {
        poolGlobal = new Pool(PG_CONFIG_GLOBAL);
        poolGlobal.on("error", (e) => Logger.error(`Pool global idle client error`, e));
    }
    return poolGlobal;
}

// ============================================================
// HELPERS DE CONEXIÓN
// Los wrappers abren/liberan el cliente y propagan cualquier error.
// ============================================================
async function withClient(fn) {
    const client = await getPool().connect();
    try { return await fn(client); } finally { client.release(); }
}
async function withGlobalClient(fn) {
    const client = await getGlobalPool().connect();
    try { return await fn(client); } finally { client.release(); }
}

// Ejecuta un query con log de errores (no swallow silencioso).
async function safeQuery(client, sql, params = [], ctx = "query") {
    try {
        return await client.query(sql, params);
    } catch (e) {
        Logger.error(`Error en ${ctx}: ${e.message}`, e);
        throw e;
    }
}

// ============================================================
// SCHEMA INIT
// ============================================================
async function ensureSchema() {
    if (schemaListo) return;

    // --- Sala (poolSala) ---
    await withClient(async (c) => {
        await c.query(`CREATE TABLE IF NOT EXISTS players (
            key         TEXT PRIMARY KEY,
            data        JSONB NOT NULL,
            room_id     TEXT,
            updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );`);
        await c.query(`CREATE INDEX IF NOT EXISTS idx_players_room ON players(room_id);`);
        await c.query(`CREATE INDEX IF NOT EXISTS idx_players_updated ON players(updated_at DESC);`);
        await c.query(`CREATE INDEX IF NOT EXISTS idx_players_mmr ON players(((data->>'mmr')::int) DESC NULLS LAST);`);

        await c.query(`CREATE TABLE IF NOT EXISTS records (
            room_id     TEXT PRIMARY KEY,
            data        JSONB NOT NULL,
            updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );`);

        await c.query(`CREATE TABLE IF NOT EXISTS clanes (
            id          TEXT PRIMARY KEY,
            data        JSONB NOT NULL,
            room_id     TEXT,
            updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );`);
        await c.query(`CREATE INDEX IF NOT EXISTS idx_clanes_room ON clanes(room_id);`);

        await c.query(`CREATE TABLE IF NOT EXISTS backups (
            id          BIGSERIAL PRIMARY KEY,
            room_id     TEXT NOT NULL,
            data        JSONB NOT NULL,
            created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );`);
        await c.query(`CREATE INDEX IF NOT EXISTS idx_backups_room_date ON backups(room_id, created_at DESC);`);
    });

    // --- Global (poolGlobal) ---
    await withGlobalClient(async (c) => {
        await c.query(`CREATE TABLE IF NOT EXISTS player_globals (
            key                 TEXT PRIMARY KEY,
            monedas             BIGINT NOT NULL DEFAULT 0,
            badges              JSONB  NOT NULL DEFAULT '[]'::jsonb,
            vip                 BOOLEAN NOT NULL DEFAULT FALSE,
            vip_tortu           BOOLEAN NOT NULL DEFAULT FALSE,
            vip_perma           BOOLEAN NOT NULL DEFAULT FALSE,
            vip_expira          BIGINT,
            vip_tier            TEXT   NOT NULL DEFAULT 'vip',
            discord_verificado  BOOLEAN NOT NULL DEFAULT FALSE,
            discord_id          TEXT,
            discord_tag         TEXT,
            clan                TEXT,
            room_id             TEXT,
            updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );`);
        await c.query(`CREATE INDEX IF NOT EXISTS idx_pg_clan ON player_globals(clan);`);
        await c.query(`CREATE INDEX IF NOT EXISTS idx_pg_vip  ON player_globals(vip, vip_expira);`);

        await c.query(`CREATE TABLE IF NOT EXISTS nombres_reservados (
            nombre      TEXT PRIMARY KEY,
            owner_key   TEXT NOT NULL,
            room_id     TEXT,
            created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );`);
        await c.query(`CREATE INDEX IF NOT EXISTS idx_nr_owner ON nombres_reservados(owner_key);`);

        await c.query(`CREATE TABLE IF NOT EXISTS players_bans (
            key         TEXT PRIMARY KEY,
            ban_hasta   BIGINT NOT NULL DEFAULT 0,
            blacklisted BOOLEAN NOT NULL DEFAULT FALSE,
            room_id     TEXT,
            updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );`);
        await c.query(`CREATE INDEX IF NOT EXISTS idx_bans_activos ON players_bans(ban_hasta) WHERE ban_hasta > 0;`);
        await c.query(`CREATE INDEX IF NOT EXISTS idx_bans_blacklist ON players_bans(blacklisted) WHERE blacklisted = TRUE;`);

        await c.query(`CREATE TABLE IF NOT EXISTS admins_auto (
            auth        TEXT PRIMARY KEY,
            agregado_por TEXT,
            room_id     TEXT,
            created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );`);

        await c.query(`CREATE TABLE IF NOT EXISTS bot_state (
            key         TEXT PRIMARY KEY,
            value       TEXT,
            updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );`);
    });

    schemaListo = true;
    Logger.info("Schema verificado");
}

// ============================================================
// CARGA / GUARDADO DE ESTADO
// ============================================================
async function loadDatabase(STATE, roomId) {
    await ensureSchema();

    // Players (data blob por key).
    const { rows: pRows } = await withClient(c => c.query(
        `SELECT key, data FROM players WHERE room_id = $1 OR room_id IS NULL;`,
        [roomId]
    ));
    STATE.baseDatos = {};
    for (const r of pRows) STATE.baseDatos[r.key] = r.data;

    // Records de la sala.
    const { rows: rRows } = await withClient(c => c.query(
        `SELECT data FROM records WHERE room_id = $1;`, [roomId]
    ));
    STATE.records = rRows[0]?.data || {};

    // Clanes de la sala.
    const { rows: cRows } = await withClient(c => c.query(
        `SELECT id, data FROM clanes WHERE room_id = $1 OR room_id IS NULL;`, [roomId]
    ));
    STATE.clanes = {};
    for (const r of cRows) STATE.clanes[r.id] = r.data;

    // Admins automáticos (locales a la sala).
    const { rows: aRows } = await withClient(c => c.query(
        `SELECT auth FROM admins_auto WHERE room_id = $1 OR room_id IS NULL;`, [roomId]
    ));
    STATE.adminsAutomaticos = new Set(aRows.map(r => r.auth));

    Logger.info(`Cargado — players=${pRows.length} clanes=${cRows.length} admins=${aRows.length}`);
    return { players: pRows.length, clanes: cRows.length };
}

/**
 * Guarda el estado a Postgres.
 * — Solo toca los keys marcados como dirty; si fullDiffPendiente está en true,
 *   hace full scan (para cuando se actualizó algo masivo: nueva temporada, etc).
 * — Batchea los players en chunks de MAX_BATCH_SIZE para no exceder el límite
 *   de parámetros de Postgres (65535 en la mayoría de builds).
 * — Limpia las marcas de dirty ANTES de escribir: si la escritura falla, los
 *   keys vuelven a quedar sucios en el catch. Este patrón evita perder updates
 *   si el proceso crashea a mitad de un batch grande.
 */
async function saveDatabase(STATE, roomId) {
    await ensureSchema();

    const keysDirty = STATE.fullDiffPendiente
        ? Object.keys(STATE.baseDatos)
        : Array.from(STATE.dirtyPlayers || []);

    // Records
    await withClient(c => c.query(
        `INSERT INTO records (room_id, data, updated_at) VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (room_id) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at;`,
        [roomId, JSON.stringify(STATE.records || {})]
    ));

    // Clanes — un upsert por clan (bajo volumen, no hace falta batch).
    for (const [id, data] of Object.entries(STATE.clanes || {})) {
        await withClient(c => c.query(
            `INSERT INTO clanes (id, data, room_id, updated_at) VALUES ($1, $2::jsonb, $3, NOW())
             ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at;`,
            [id, JSON.stringify(data), roomId]
        ));
    }

    if (!keysDirty.length) {
        STATE.dirtyPlayers?.clear?.();
        STATE.fullDiffPendiente = false;
        STATE.isDirty = false;
        return 0;
    }

    // Players en chunks.
    let escritos = 0;
    for (let i = 0; i < keysDirty.length; i += MAX_BATCH_SIZE) {
        const chunk = keysDirty.slice(i, i + MAX_BATCH_SIZE);
        const rows = chunk.map(k => [k, JSON.stringify(STATE.baseDatos[k] || {}), roomId]);

        const values = rows.map((_, idx) => {
            const b = idx * 3;
            return `($${b + 1}, $${b + 2}::jsonb, $${b + 3})`;
        }).join(",");
        const params = rows.flat();

        try {
            await withClient(c => c.query(
                `INSERT INTO players (key, data, room_id, updated_at) VALUES ${values.replace(/\$(\d+)/g, (m, n) => `$${n}`)}, NOW()
                 ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW();`,
                params
            ));
            escritos += chunk.length;
        } catch (e) {
            Logger.error(`Falló batch de players (chunk ${i}..${i + chunk.length})`, e);
            // Dejamos esos keys como dirty para reintentar en el próximo ciclo.
            for (const k of chunk) STATE.dirtyPlayers?.add?.(k);
            throw e;
        }
    }

    STATE.dirtyPlayers?.clear?.();
    STATE.fullDiffPendiente = false;
    STATE.isDirty = false;
    return escritos;
}

/**
 * Backup completo del estado + poda de backups antiguos.
 * Guarda el blob entero (todos los players + records + clanes) como un único
 * JSON. Si el volumen crece mucho, cambiar por snapshot por tabla.
 */
async function backupDatabase(STATE, keep = BACKUP_DEFAULT_KEEP, roomId) {
    await ensureSchema();
    const snapshot = {
        baseDatos: STATE.baseDatos || {},
        records: STATE.records || {},
        clanes: STATE.clanes || {},
        campeones: STATE.campeones || [],
        temporada: STATE.TEMPORADA_ACTUAL || 1,
        fecha: new Date().toISOString(),
    };

    await withClient(c => c.query(
        `INSERT INTO backups (room_id, data) VALUES ($1, $2::jsonb);`,
        [roomId, JSON.stringify(snapshot)]
    ));

    // Poda: conservar los últimos `keep`.
    await withClient(c => c.query(
        `DELETE FROM backups WHERE id IN (
            SELECT id FROM backups WHERE room_id = $1
            ORDER BY created_at DESC OFFSET $2
        );`,
        [roomId, keep]
    ));

    Logger.info(`Backup guardado (keep=${keep})`);
    return true;
}

// ============================================================
// NOMBRES RESERVADOS
// ============================================================
async function reservarNombre(nombre, ownerKey, roomId) {
    await ensureSchema();
    const n = nombre.toLowerCase().trim();
    await withGlobalClient(c => c.query(
        `INSERT INTO nombres_reservados (nombre, owner_key, room_id, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (nombre) DO UPDATE
           SET owner_key = nombres_reservados.owner_key,
               updated_at = NOW()
         WHERE nombres_reservados.owner_key = EXCLUDED.owner_key;`,
        [n, ownerKey, roomId]
    ));
}

async function liberarNombreReservado(nombre) {
    await ensureSchema();
    const n = nombre.toLowerCase().trim();
    await withGlobalClient(c => c.query(
        `DELETE FROM nombres_reservados WHERE nombre = $1;`, [n]
    ));
}

/**
 * Libera reservas huérfanas: entradas en nombres_reservados cuyo owner_key
 * ya no existe en players. Se llama al arranque.
 */
async function liberarReservasHuerfanas(keysVivas) {
    await ensureSchema();
    if (!Array.isArray(keysVivas) || !keysVivas.length) return 0;
    const { rowCount } = await withGlobalClient(c => c.query(
        `DELETE FROM nombres_reservados WHERE owner_key <> ALL($1::text[]);`,
        [keysVivas]
    ));
    return rowCount || 0;
}

// ============================================================
// SYNC GLOBAL (bans + reservas)
// ============================================================
async function fetchGlobalSyncData() {
    await ensureSchema();
    const [bans, nombres] = await Promise.all([
        withGlobalClient(c => c.query(
            `SELECT key, ban_hasta, blacklisted FROM players_bans
             WHERE ban_hasta > 0 OR blacklisted = TRUE;`
        )).then(r => r.rows),
        withGlobalClient(c => c.query(
            `SELECT nombre, owner_key FROM nombres_reservados;`
        )).then(r => r.rows),
    ]);
    return { bans, nombres };
}

// ============================================================
// ADMINS AUTO
// ============================================================
async function agregarAdminAuto(auth, agregadoPor, roomId) {
    await ensureSchema();
    await withClient(c => c.query(
        `INSERT INTO admins_auto (auth, agregado_por, room_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (auth) DO UPDATE
           SET agregado_por = EXCLUDED.agregado_por, room_id = EXCLUDED.room_id;`,
        [auth, agregadoPor || null, roomId]
    ));
}

async function quitarAdminAuto(auth) {
    await ensureSchema();
    await withClient(c => c.query(
        `DELETE FROM admins_auto WHERE auth = $1;`, [auth]
    ));
}

async function fetchAdminsAuto(roomId) {
    await ensureSchema();
    const { rows } = await withClient(c => c.query(
        `SELECT auth FROM admins_auto WHERE room_id = $1 OR room_id IS NULL;`,
        [roomId]
    ));
    return rows.map(r => r.auth);
}

// ============================================================
// BANS
// ============================================================
async function upsertPlayerBan(key, datos, roomId, _isIpBan = false) {
    await ensureSchema();
    const ban_hasta = Number(datos?.ban_hasta) || 0;
    const blacklisted = !!datos?.blacklisted;
    await withGlobalClient(c => c.query(
        `INSERT INTO players_bans (key, ban_hasta, blacklisted, room_id, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (key) DO UPDATE
           SET ban_hasta = EXCLUDED.ban_hasta,
               blacklisted = EXCLUDED.blacklisted,
               room_id = EXCLUDED.room_id,
               updated_at = NOW();`,
        [key, ban_hasta, blacklisted, roomId]
    ));
}

/**
 * FIX A: upsert parcial de ban.
 * Solo actualiza las columnas pasadas en `campos`. Antes este método no
 * existía y index.js lo llamaba desde quitarBanGlobal/setBlacklistGlobal,
 * pero sólo podía hacerse vía upsertPlayerBan (que sobrescribe ambos campos).
 * Resultado: liberar un ban borraba la blacklist y viceversa.
 *
 * Whitelist de columnas permitidas para evitar SQL injection por nombre de
 * columna (los valores ya van parametrizados).
 */
const BAN_COLS_PERMITIDAS = Object.freeze(new Set(["ban_hasta", "blacklisted"]));
async function upsertPlayerBanParcial(key, campos, roomId) {
    await ensureSchema();
    const entries = Object.entries(campos || {}).filter(([k]) => BAN_COLS_PERMITIDAS.has(k));
    if (!entries.length) return;

    const cols = entries.map(([k]) => k);
    const vals = entries.map(([, v]) => v);

    // Construye: INSERT ... ON CONFLICT DO UPDATE SET col = EXCLUDED.col
    const insertCols = ["key", ...cols, "room_id", "updated_at"];
    const insertVals = ["$1", ...cols.map((_, i) => `$${i + 2}`), `$${cols.length + 2}`, "NOW()"];
    const updateSet = [...cols.map(c => `${c} = EXCLUDED.${c}`), "room_id = EXCLUDED.room_id", "updated_at = NOW()"].join(", ");

    await withGlobalClient(c => c.query(
        `INSERT INTO players_bans (${insertCols.join(", ")})
         VALUES (${insertVals.join(", ")})
         ON CONFLICT (key) DO UPDATE SET ${updateSet};`,
        [key, ...vals, roomId]
    ));
}

// ============================================================
// PLAYER GLOBALS
// ============================================================
async function upsertPlayerGlobals(key, datos, roomId) {
    await ensureSchema();
    const d = datos || {};
    await withGlobalClient(c => c.query(
        `INSERT INTO player_globals
           (key, monedas, badges, vip, vip_tortu, vip_perma, vip_expira, vip_tier,
            discord_verificado, discord_id, discord_tag, clan, room_id, updated_at)
         VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())
         ON CONFLICT (key) DO UPDATE SET
            monedas = EXCLUDED.monedas,
            badges  = EXCLUDED.badges,
            vip = EXCLUDED.vip,
            vip_tortu = EXCLUDED.vip_tortu,
            vip_perma = EXCLUDED.vip_perma,
            vip_expira = EXCLUDED.vip_expira,
            vip_tier = EXCLUDED.vip_tier,
            discord_verificado = EXCLUDED.discord_verificado,
            discord_id = EXCLUDED.discord_id,
            discord_tag = EXCLUDED.discord_tag,
            clan = EXCLUDED.clan,
            room_id = COALESCE(EXCLUDED.room_id, player_globals.room_id),
            updated_at = NOW();`,
        [
            key,
            Math.max(0, Math.floor(Number(d.monedas) || 0)),
            JSON.stringify(d.badges || []),
            !!d.vip,
            !!d.vip_tortu,
            !!d.vip_perma,
            d.vip_expira || null,
            d.vip_tier || "vip",
            !!d.discord_verificado,
            d.discord_id || null,
            d.discord_tag || null,
            d.clan || null,
            roomId,
        ]
    ));
}

async function fetchPlayerGlobals() {
    await ensureSchema();
    const { rows } = await withGlobalClient(c => c.query(
        `SELECT key, monedas, badges, vip, vip_tortu, vip_perma, vip_expira, vip_tier,
                discord_verificado, discord_id, discord_tag, clan
           FROM player_globals;`
    ));
    return rows;
}

// ============================================================
// CLANES GLOBAL
// ============================================================
/**
 * FIX B: antes `lastSavedClanesGlobal` guardaba una referencia al objeto
 * STATE.clanes. Si el objeto mutaba in-place (que es lo que pasa siempre),
 * la comparación `JSON.stringify(actual) !== JSON.stringify(snapshot)` daba
 * false siempre (los dos apuntaban al mismo objeto). Resultado: los clanes
 * nunca se persistían después de la primera vez.
 *
 * Ahora guardamos un snapshot serializado (string) para forzar comparación
 * por valor. Se mantiene en un módulo-level var porque cada sala tiene su
 * propia instancia de index.js → su propio require de database.js.
 */
let _lastSavedClanes = null;
async function saveClanesGlobal(STATE, roomId) {
    await ensureSchema();
    const clanes = STATE.clanes || {};
    const serializado = JSON.stringify(clanes);
    if (serializado === _lastSavedClanes) return 0;

    const ids = Object.keys(clanes);
    let n = 0;
    for (const id of ids) {
        await withClient(c => c.query(
            `INSERT INTO clanes (id, data, room_id, updated_at) VALUES ($1, $2::jsonb, $3, NOW())
             ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, room_id = EXCLUDED.room_id, updated_at = NOW();`,
            [id, JSON.stringify(clanes[id]), roomId]
        ));
        n++;
    }

    _lastSavedClanes = serializado;
    return n;
}

// ============================================================
// BORRADO DE JUGADORES
// ============================================================
async function deletePlayerLocal(key) {
    await ensureSchema();
    await withClient(c => c.query(`DELETE FROM players WHERE key = $1;`, [key]));
}

async function deletePlayersLocalBatch(keys) {
    await ensureSchema();
    if (!Array.isArray(keys) || !keys.length) return 0;
    // Chunks para no exceder el límite de parámetros.
    let total = 0;
    for (let i = 0; i < keys.length; i += MAX_BATCH_SIZE) {
        const chunk = keys.slice(i, i + MAX_BATCH_SIZE);
        const placeholders = chunk.map((_, idx) => `$${idx + 1}`).join(",");
        const { rowCount } = await withClient(c => c.query(
            `DELETE FROM players WHERE key IN (${placeholders});`, chunk
        ));
        total += rowCount || 0;
    }
    return total;
}

async function deletePlayerGlobalRow(key) {
    await ensureSchema();
    await withGlobalClient(c => c.query(`DELETE FROM player_globals WHERE key = $1;`, [key]));
}

// ============================================================
// BOT STATE
// ============================================================
async function setBotState(key, value) {
    await ensureSchema();
    await withGlobalClient(c => c.query(
        `INSERT INTO bot_state (key, value, updated_at) VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();`,
        [key, String(value)]
    ));
}

async function getBotState(key) {
    await ensureSchema();
    const { rows } = await withGlobalClient(c => c.query(
        `SELECT value FROM bot_state WHERE key = $1;`, [key]
    ));
    return rows[0]?.value ?? null;
}

/**
 * Marca el proceso como apagado en bot_state. Se llama desde shutdown() en
 * index.js para que un supervisor externo (pm2/systemd) sepa que fue un
 * cierre ordenado y no un crash.
 */
async function marcarProcesoApagado() {
    try {
        await setBotState(`proceso_${process.env.ROOM_ID || "HA"}`, `apagado_${Date.now()}`);
    } catch (e) {
        Logger.warn(`No se pudo marcar proceso apagado: ${e.message}`);
    }
}

// ============================================================
// CIERRE
// ============================================================
async function closePool() {
    const tareas = [];
    if (poolSala) tareas.push(poolSala.end().catch(e => Logger.warn(`Error cerrando poolSala: ${e.message}`)));
    if (poolGlobal) tareas.push(poolGlobal.end().catch(e => Logger.warn(`Error cerrando poolGlobal: ${e.message}`)));
    await Promise.all(tareas);
    poolSala = null;
    poolGlobal = null;
    Logger.info("Pools cerrados");
}

// ============================================================
// EXPORTS
// ============================================================
module.exports = {
    // Ciclo de vida
    loadDatabase,
    saveDatabase,
    backupDatabase,
    ensureSchema,
    closePool,
    getPool,
    getGlobalPool,

    // Nombres reservados
    reservarNombre,
    liberarNombreReservado,
    liberarReservasHuerfanas,
    fetchGlobalSyncData,

    // Admins
    agregarAdminAuto,
    quitarAdminAuto,
    fetchAdminsAuto,

    // Bans
    upsertPlayerBan,
    upsertPlayerBanParcial,

    // Player globals
    upsertPlayerGlobals,
    fetchPlayerGlobals,

    // Clanes
    saveClanesGlobal,

    // Delete
    deletePlayerLocal,
    deletePlayersLocalBatch,
    deletePlayerGlobalRow,

    // Bot state
    setBotState,
    getBotState,
    marcarProcesoApagado,

    // Logger (exportado por si index.js quiere reusar)
    Logger,
};
