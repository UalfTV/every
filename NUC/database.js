"use strict";

/**
 * Capa de persistencia en PostgreSQL para el bot de Haxball.
 *
 * Reemplaza el viejo esquema de archivo JSON por:
 *   - tabla `players`      -> un row por jugador (STATE.baseDatos[key])
 *   - tabla `league_state` -> un único row con el resto de las colecciones
 *   - tabla `backups`      -> snapshots históricos para el Salón de la Fama
 *
 * Diseño:
 *   - Pool de conexiones único por proceso (getPool cachea la instancia).
 *   - Las credenciales SIEMPRE se arman con PGHOST/PGPORT/PGUSER/PGPASSWORD/
 *     PGDATABASE. Nunca se usa connectionString ni DATABASE_URL, para evitar
 *     ambigüedades entre ambas formas de configurar la conexión.
 *   - `saveDatabase` hace UPSERT por lotes dentro de una transacción, y no
 *     hace nada si STATE.isDirty es false (evita escrituras innecesarias).
 *   - Un guard evita que se solapen dos guardados simultáneos.
 *   - `loadDatabase` migra el esquema automáticamente si no existe.
 *   - El diff de jugadores cede el control al event loop cada YIELD_EVERY
 *     entradas (setImmediate), para no bloquear el tick físico ni la red
 *     mientras se serializa una base de jugadores grande. Esto es lo que
 *     evita los micro-stutters de ping durante el autosave.
 *
 * IMPORTANTE — soporte para 2+ salas corriendo al mismo tiempo:
 *   Cada sala (HA / H4) apunta a su propia PGDATABASE (ver HA.config.js /
 *   H4.config.js), pero comparten el mismo servidor de PostgreSQL. Cada
 *   proceso de Node abre su propio Pool hacia SU base, así que no hay
 *   colisión de datos entre salas ni necesidad de coordinar escrituras.
 *
 *   Además, todas las tablas incluyen una columna `room_id` (nullable, sin
 *   restricciones todavía) para poder migrar en el futuro a un esquema
 *   "una sola base para todas las salas, particionada por room_id" sin
 *   tener que tocar de nuevo la estructura ni perder datos existentes.
 *   Hoy no se usa para filtrar consultas: es sólo un campo informativo que
 *   se completa si el llamador pasa un roomId.
 */

const { Pool } = require("pg");
const crypto = require("crypto");


// ============================================
// Logger unificado para database
// ============================================
const Logger = {
    info: (msg) => Logger.info(`[DB] ${msg}`),
    warn: (msg) => Logger.warn(`[DB] ⚠️ ${msg}`),
    error: (msg, error = null) => {
        const stack = error ? `\n${error.stack}` : '';
        Logger.error(`[DB] ❌ ${msg}${stack}`);
    },
    debug: (msg) => {
        if (process.env.DEBUG_MODE) Logger.info(`[DB] 🐛 ${msg}`);
    }
};

// Reemplazar console por Logger
const originalConsoleLog = console.log;
const originalConsoleWarn = console.warn;
const originalConsoleError = console.error;
console.log = Logger.info;
console.warn = Logger.warn;
console.error = Logger.error;

const CHUNK_SIZE = 500;
const LEAGUE_STATE_ID = 1;

// Cada cuántas entradas de `players` se cede el control al event loop
// durante el diff de saveDatabase. Bajar este número reduce el stutter
// pero aumenta un poco la duración total del guardado; subirlo hace lo
// contrario. 100 es un buen punto de partida para salas de Haxball.
const YIELD_EVERY = 100;

// FIX #79: los advisory locks antes eran números hardcodeados
// (918273001/918273002). Si otro proceso Node usaba los mismos números
// contra el mismo cluster, se bloqueaban sin relación. Ahora se derivan
// de un hash del nombre de la app: si el nombre no cambia, los locks son
// idénticos entre reinicios, sigue funcionando igual que antes, pero el
// espacio de claves es propio.
const APP_NAMESPACE = process.env.PG_APP_NAMESPACE || "haxball_futsal";
function advisoryKey(nombre) {
    const h = crypto.createHash("sha1").update(`${APP_NAMESPACE}:${nombre}`).digest();
    return h.readInt32BE(0); // int32 con signo, dentro del rango de pg_advisory_lock
}
const LOCK_MIGRATE = advisoryKey("migrate");
const LOCK_MIGRATE_GLOBAL = advisoryKey("migrate_global");

// ── Pool único por proceso, creado con credenciales explícitas ──
// ⚠️ NO se usa connectionString/DATABASE_URL a propósito: todas las
// conexiones se arman con host/port/user/password/database explícitos,
// para que no haya ambigüedad sobre qué credenciales se están usando.
let poolInstance = null;
let poolClosing = null;

// ── Pool GLOBAL, separado del pool por-sala ──
// Apunta a PGDATABASE_GLOBAL (mismo servidor, host/user/password que el
// resto). Acá viven datos que deben ser IGUALES en todas las salas:
// baneos/blacklist, cuentas globales (monedas/VIP/badges), clanes y nombres
// reservados. Cada proceso (HA, H4) abre AMBOS pools: el suyo propio para
// lo competitivo, y este para lo global. Es intencional tener dos Pools por
// proceso en vez de uno: separa físicamente qué tabla vive en qué base, así
// nunca hay ambigüedad de a cuál conectarse.
let globalPoolInstance = null;
let globalPoolClosing = null;

// FIX #80: flag de proceso apagado. Si closePool() ya corrió, getPool() /
// getGlobalPool() NO deben reabrir un pool nuevo — antes cualquier timer
// que sobreviviera al shutdown (o una promesa pendiente) podía disparar
// una query y recrear el pool en medio del apagado. Con esto, un getPool()
// post-shutdown tira error en vez de abrir una conexión fantasma.
let procesoApagado = false;
function marcarProcesoApagado() { procesoApagado = true; }

/**
 * Arma la configuración de conexión leyendo únicamente PGHOST, PGPORT,
 * PGUSER, PGPASSWORD y PGDATABASE (nunca connectionString/DATABASE_URL).
 * `overrides` permite que cada sala use su propia PGDATABASE si así lo
 * define su archivo de configuración (HA.config.js / H4.config.js),
 * mantenido el resto de las credenciales compartidas.
 */
function buildPgConfig(overrides = {}) {
    const host = overrides.host || process.env.PGHOST || "localhost";
    const port = overrides.port || parseInt(process.env.PGPORT, 10) || 5432;
    const user = overrides.user || process.env.PGUSER || "postgres";
    const password = overrides.password || process.env.PGPASSWORD;
    const database = overrides.database || process.env.PGDATABASE || "haxball_league";

    if (!password) {
        Logger.warn("⚠️ PGPASSWORD no está definida en el entorno. Las conexiones pueden fallar.");
    }

    return {
        host,
        port,
        user,
        password,
        database,
        ssl: process.env.PGSSLMODE === "require" ? { rejectUnauthorized: false } : false,
        max: Number(process.env.PG_POOL_MAX || 10),
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000,
    };
}

/**
 * Devuelve el Pool único del proceso. Se crea una sola vez, usando la
 * configuración de la primera llamada (normalmente en el arranque del bot,
 * vía loadDatabase). Llamadas posteriores devuelven siempre la misma
 * instancia, así nunca hay dos pools abiertos al mismo tiempo.
 */
function getPool(overrides = {}) {
    // FIX #80: bloquear reapertura tras shutdown.
    if (procesoApagado) throw new Error("El proceso se está apagando; no se pueden abrir nuevas conexiones.");
    if (poolClosing) {
        // Evita reabrir un pool mientras se está cerrando (p.ej. durante un
        // shutdown que se solapa con un guardado en curso).
        throw new Error("El pool de PostgreSQL se está cerrando; no se pueden abrir nuevas conexiones.");
    }
    if (!poolInstance) {
        const cfg = buildPgConfig(overrides);
        Logger.info(`🔌 Creando pool de PostgreSQL (sala): ${cfg.user}@${cfg.host}:${cfg.port}/${cfg.database}`);

        poolInstance = new Pool(cfg);
        poolInstance.on("error", (err) => {
            log.error("Error en pool de conexiones", err);
                // Intentar reconectar después de 5 segundos
                setTimeout(() => { poolInstance = null; getPool().connect().catch(() => {}); }, 5000);
                Logger.error("❌ Error inesperado en el pool de PostgreSQL (sala):", err.message);
        });
    }
    return poolInstance;
}

/**
 * Igual que getPool(), pero para la base GLOBAL compartida entre salas.
 * Usa PGDATABASE_GLOBAL (default "haxball_global") en vez de PGDATABASE.
 * Mismo host/user/password que el pool por-sala salvo que se pase override.
 */
function getGlobalPool(overrides = {}) {
    // FIX #80: mismo guard que el pool de sala.
    if (procesoApagado) throw new Error("El proceso se está apagando; no se pueden abrir nuevas conexiones.");
    if (globalPoolClosing) {
        throw new Error("El pool GLOBAL de PostgreSQL se está cerrando; no se pueden abrir nuevas conexiones.");
    }
    if (!globalPoolInstance) {
        const cfg = buildPgConfig({
            database: process.env.PGDATABASE_GLOBAL || "haxball_global",
            ...overrides,
        });
        Logger.info(`🔌 Creando pool de PostgreSQL (global): ${cfg.user}@${cfg.host}:${cfg.port}/${cfg.database}`);

        globalPoolInstance = new Pool(cfg);
        globalPoolInstance.on("error", (err) => {
            Logger.error("❌ Error inesperado en el pool de PostgreSQL (global):", err.message);
        });
    }
    return globalPoolInstance;
}

// ── Copias "última guardada con éxito" para poder diffear ──
let lastSavedPlayers = {};      // key -> JSON.stringify(data)
let lastSavedLeague = null;     // snapshot de league_state al último guardado
let lastSavedClanesGlobal = null; // snapshot de global_state.clanes al último guardado/carga

function snapshotLeague(STATE) {
    return {
        records: STATE.records || {},
        campeones: STATE.campeones || [],
        // clanes: ya NO va acá — es global desde ahora, vive en global_state
        // (ver saveClanesGlobal). Se deja la columna league_state.clanes en
        // el schema por compatibilidad, pero no se lee ni se escribe más.
        authRegistrados: STATE.authRegistrados || {},
        titulosExclusivos: STATE.titulosExclusivos || {},
        // FIX #15: STATE.titulosExclusivos se persiste acá. Antes vivía
        // solo en memoria y se perdía al reiniciar — el slot quedaba libre
        // pero los dueños seguían con titulo_custom seteado, así que el
        // próximo comprador no pisaba al anterior (quedaban dos dueños).
        temporadaActual: STATE.TEMPORADA_ACTUAL || 1,
        anuncioIndex: STATE.anuncioIndex || 0,
    };
}

const DEFAULT_LEAGUE_ROW = {
    records: {},
    campeones: [],
    clanes: {},
    auth_registrados: {},
    titulos_exclusivos: {},
    temporada_actual: 1,
    anuncio_index: 0,
};

/**
 * Migración del esquema POR-SALA (pool de sala). Envuelta en un advisory
 * lock de Postgres a propósito: si el mismo proceso se reinicia rápido dos
 * veces seguidas (ej: reintentos por un token de Haxball inválido, como ya
 * pasó), dos conexiones podrían ejecutar los CREATE TABLE IF NOT EXISTS casi
 * al mismo tiempo. Postgres NO garantiza que eso sea atómico entre sesiones
 * — puede tirar "duplicate key value violates unique constraint
 * pg_type_typname_nsp_index" (choque al crear el mismo tipo de tabla dos
 * veces en simultáneo). El lock hace que la segunda conexión espere a que la
 * primera termine de migrar, en vez de chocar. Se libera siempre, incluso si
 * migrate() tira una excepción a mitad de camino.
 */
async function migrate(client) {
    await client.query(`SELECT pg_advisory_lock($1);`, [LOCK_MIGRATE]);
    try {
        await migrateInterno(client);
    } finally {
        await client.query(`SELECT pg_advisory_unlock($1);`, [LOCK_MIGRATE]);
    }
}

async function migrateInterno(client) {
    await client.query(`
    CREATE TABLE IF NOT EXISTS players (
        key         TEXT PRIMARY KEY,
        data        JSONB NOT NULL DEFAULT '{}'::jsonb,
        room_id     TEXT,
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    `);
    // Compatibilidad hacia adelante: si la tabla ya existía sin room_id, se
    // agrega ahora como columna nullable (no rompe filas existentes).
    await client.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS room_id TEXT;`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_players_updated_at ON players (updated_at);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_players_data_gin ON players USING GIN (data jsonb_path_ops);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_players_room_id ON players (room_id);`);

    await client.query(`
    CREATE TABLE IF NOT EXISTS league_state (
        id                  SMALLINT PRIMARY KEY DEFAULT 1,
        records             JSONB NOT NULL DEFAULT '{}'::jsonb,
        campeones           JSONB NOT NULL DEFAULT '[]'::jsonb,
        clanes              JSONB NOT NULL DEFAULT '{}'::jsonb,
        auth_registrados    JSONB NOT NULL DEFAULT '{}'::jsonb,
        titulos_exclusivos  JSONB NOT NULL DEFAULT '{}'::jsonb,
        temporada_actual    INTEGER NOT NULL DEFAULT 1,
        anuncio_index       INTEGER NOT NULL DEFAULT 0,
        room_id             TEXT,
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
                                             CHECK (id = 1)
    );
    `);
    // FIX #15: si la tabla ya existía sin titulos_exclusivos, se agrega
    // ahora como columna (no rompe filas existentes).
    await client.query(`ALTER TABLE league_state ADD COLUMN IF NOT EXISTS titulos_exclusivos JSONB NOT NULL DEFAULT '{}'::jsonb;`);
    await client.query(`ALTER TABLE league_state ADD COLUMN IF NOT EXISTS room_id TEXT;`);

    await client.query(`
    CREATE TABLE IF NOT EXISTS backups (
        id          SERIAL PRIMARY KEY,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
                                        snapshot    JSONB NOT NULL,
                                        room_id     TEXT
    );
    `);
    await client.query(`ALTER TABLE backups ADD COLUMN IF NOT EXISTS room_id TEXT;`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_backups_created_at ON backups (created_at DESC);`);

    // FIX #15 (parte 2): tabla chica de estado del bot (ej: message id del
    // live stats de Discord) — evita crear un mensaje nuevo en cada restart.
    await client.query(`
    CREATE TABLE IF NOT EXISTS bot_state (
        key         TEXT PRIMARY KEY,
        value       TEXT NOT NULL,
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    `);

    await client.query(
        `INSERT INTO league_state (id) VALUES ($1) ON CONFLICT (id) DO NOTHING;`,
                       [LEAGUE_STATE_ID]
    );
}

/**
 * Migración del esquema GLOBAL (pool separado, PGDATABASE_GLOBAL): todo lo
 * que tiene que ser IGUAL en HA y H4 —
 * player_bans (baneos/blacklist), player_globals (monedas, badges, VIP,
 * Discord) y global_state (clanes). Envuelta en su PROPIO advisory lock
 * (número distinto al de arriba, para que no se bloqueen entre sí sin
 * necesidad) — acá el caso típico es justo el que rompió: HA y H4 son DOS
 * PROCESOS DISTINTOS que arrancan casi al mismo tiempo contra la MISMA base
 * global, así que sin este lock la carrera es todavía más probable que en
 * migrate().
 */
async function migrateGlobal(client) {
    await client.query(`SELECT pg_advisory_lock($1);`, [LOCK_MIGRATE_GLOBAL]);
    try {
        await migrateGlobalInterno(client);
    } finally {
        await client.query(`SELECT pg_advisory_unlock($1);`, [LOCK_MIGRATE_GLOBAL]);
    }
}

async function migrateGlobalInterno(client) {
    // NOTA: acá se creaba la tabla `conn_identities` del sistema
    // Anti-Duplicate User (conn -> último nombre usado). El sistema se
    // eliminó por completo el 2026-07-13, así que la tabla ya no se crea ni
    // se lee. La tabla existente en Postgres queda huérfana pero inofensiva;
    // si se quiere liberar el espacio: DROP TABLE conn_identities;

    // Baneos/blacklist GLOBALES: un jugador baneado en HA tiene que estar
    // baneado en H4 también, y viceversa. `key` es el mismo getPlayerKey()
    // que usa `players` (auth, o anon_<nombre> si no tiene cuenta). Se lee
    // al arrancar cada sala y se sobre-escribe encima de STATE.baseDatos.
    await client.query(`
    CREATE TABLE IF NOT EXISTS player_bans (
        key         TEXT PRIMARY KEY,
        ban_hasta   BIGINT NOT NULL DEFAULT 0,
        blacklisted BOOLEAN NOT NULL DEFAULT false,
        room_id     TEXT,
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_player_bans_updated_at ON player_bans (updated_at);`);

    // Cuenta global: monedas, badges, VIP y verificación de Discord, iguales
    // en HA y H4. `monedas` se reconcilia sólo al arrancar cada proceso
    // (política "el mayor de los dos", ver loadDatabase) — NO en el polling
    // en vivo, a propósito: a diferencia de badges/VIP/discord, las monedas
    // también bajan (compras), y mergear con MAX en vivo podría "revivir"
    // saldo ya gastado en la otra sala. El resto de los campos de acá sí son
    // monótonos (sólo se ganan, nunca se "pierden" solos) y se sincronizan
    // en vivo sin problema.
    await client.query(`
    CREATE TABLE IF NOT EXISTS player_globals (
        key                 TEXT PRIMARY KEY,
        monedas             BIGINT NOT NULL DEFAULT 0,
        badges              JSONB NOT NULL DEFAULT '[]'::jsonb,
        vip                 BOOLEAN NOT NULL DEFAULT false,
        vip_tortu           BOOLEAN NOT NULL DEFAULT false,
        vip_perma           BOOLEAN NOT NULL DEFAULT false,
        vip_expira          BIGINT,
        vip_tier            TEXT NOT NULL DEFAULT 'vip',
        discord_verificado  BOOLEAN NOT NULL DEFAULT false,
        discord_id          TEXT,
        discord_tag         TEXT,
        clan                TEXT,
        room_id             TEXT,
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    `);
    // player_globals ya existe en producción desde el bloque de hoy, así que
    // CREATE TABLE IF NOT EXISTS de arriba no le suma la columna `clan`
    // nueva sola — hace falta el ALTER explícito.
    await client.query(`ALTER TABLE player_globals ADD COLUMN IF NOT EXISTS clan TEXT;`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_player_globals_updated_at ON player_globals (updated_at);`);

    // Clanes GLOBALES: una sola lista de clanes para HA y H4 (decisión de
    // producto). Fila única (igual patrón que league_state), con merge de
    // 3 vías en cada guardado (ver saveClanesGlobal) para que crear un clan
    // en una sala y unirse en la otra no se pisen entre sí.
    await client.query(`
    CREATE TABLE IF NOT EXISTS global_state (
        id          SMALLINT PRIMARY KEY DEFAULT 1,
        clanes      JSONB NOT NULL DEFAULT '{}'::jsonb,
        room_id     TEXT,
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
                                             CHECK (id = 1)
    );
    `);
    await client.query(
        `INSERT INTO global_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;`
    );

    // Nombres RESERVADOS: un nombre le pertenece para siempre a la primera
    // identidad (key: auth o anon_conn_) que lo usó, sin importar si esa
    // persona está online ahora o no. Esto es DISTINTO del anti-dupe de conn
    // (que sólo corta conexiones simultáneas) y de la migración de
    // anon_<nombre> (que protege los DATOS viejos) — esto protege el NOMBRE
    // en sí, para siempre, para cualquier key. Primera vez que alguien usa
    // un nombre, se reserva a su key; si otra key distinta intenta usar ese
    // mismo nombre después (esté quien lo reservó online o no), se rechaza.
    await client.query(`
    CREATE TABLE IF NOT EXISTS nombres_reservados (
        nombre      TEXT PRIMARY KEY,
        owner_key   TEXT NOT NULL,
        room_id     TEXT,
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_nombres_reservados_owner ON nombres_reservados (owner_key);`);

    // Admins AUTOMÁTICOS por auth: lista de Public IDs que reciben admin
    // nativo de Haxball apenas se conectan, en cualquiera de las 2 salas,
    // sin importar el nombre que usen. Es GLOBAL a propósito (misma tabla
    // que baneos/nombres reservados) — un admin de confianza lo es en toda
    // la comunidad, no sala por sala.
    await client.query(`
    CREATE TABLE IF NOT EXISTS admins_automaticos (
        auth          TEXT PRIMARY KEY,
        agregado_por  TEXT,
        room_id       TEXT,
        fecha         TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    `);
}

/**
 * Carga toda la base de datos a memoria (STATE) en el arranque del bot.
 * `roomId` es opcional y sólo se usa para dejar constancia de qué sala hizo
 * la carga (columna informativa); no filtra los datos, ya que cada sala usa
 * su propia PGDATABASE. Los datos GLOBALES (baneos, cuentas, clanes,
 * nombres reservados) se leen aparte, del pool global (PGDATABASE_GLOBAL).
 */
async function loadDatabase(STATE, roomId = null) {
    const client = await getPool().connect();
    let playerRows = [];
    try {
        await migrate(client);

        const res = await client.query(`SELECT key, data FROM players;`);
        playerRows = res.rows;
        STATE.baseDatos = {};
        for (const row of playerRows) {
            STATE.baseDatos[row.key] = row.data;
        }

        const { rows: leagueRows } = await client.query(
            `SELECT * FROM league_state WHERE id = $1;`,
            [LEAGUE_STATE_ID]
        );
        const league = leagueRows[0] || DEFAULT_LEAGUE_ROW;

        STATE.records = league.records || {};
        STATE.campeones = league.campeones || [];
        // STATE.clanes NO se setea acá: se carga más abajo desde global_state
        // (bloque del pool global), que es la fuente de verdad ahora.
        STATE.authRegistrados = league.auth_registrados || {};
        STATE.titulosExclusivos = league.titulos_exclusivos || {}; // FIX #15
        STATE.TEMPORADA_ACTUAL = league.temporada_actual ?? 1;
        STATE.anuncioIndex = league.anuncio_index ?? 0;

        // Baseline para el diff
        lastSavedPlayers = {};
        for (const row of playerRows) lastSavedPlayers[row.key] = JSON.stringify(row.data);
        lastSavedLeague = snapshotLeague(STATE);
    } catch (e) {
        Logger.error("❌ Error cargando la base de datos desde PostgreSQL:", e.message);
        STATE.baseDatos = STATE.baseDatos || {};
        STATE.records = STATE.records || {};
        STATE.campeones = STATE.campeones || [];
        STATE.clanes = STATE.clanes || {};
        STATE.authRegistrados = STATE.authRegistrados || {};
        STATE.titulosExclusivos = STATE.titulosExclusivos || {};
        lastSavedPlayers = {};
        lastSavedLeague = null;
    } finally {
        client.release();
    }

    // ── Datos GLOBALES: pool separado, no tiene nada que ver con el catch
    // de arriba. Si esto falla, la sala igual arranca, sólo se loguea el error.
    try {
        const gClient = await getGlobalPool().connect();
        try {
            await migrateGlobal(gClient);

            // Baneos/blacklist globales: se pisan encima de STATE.baseDatos
            // para que esta sala herede lo que pasó en la otra. Sólo pisa si
            // el valor global es "más severo" (fecha de ban más lejana, o
            // blacklisted=true) — nunca desbanea localmente algo que la
            // propia sala haya baneado con una duración mayor.
            const { rows: banRows } = await gClient.query(`SELECT key, ban_hasta, blacklisted FROM player_bans;`);
            for (const row of banRows) {
                const local = STATE.baseDatos[row.key];
                if (!local) continue;
                const banHastaNum = Number(row.ban_hasta) || 0;
                if (banHastaNum > (local.ban_hasta || 0)) local.ban_hasta = banHastaNum;
                if (row.blacklisted) local.blacklisted = true;
            }

            // Cuenta global (monedas, badges, VIP, Discord): monedas usa
            // "el mayor de los dos" SOLO acá, al arrancar el proceso — es la
            // única vez que se reconcilia, justamente para no pisar un gasto
            // legítimo hecho después en la otra sala (ver comentario en
            // migrateGlobal). Badges/VIP/Discord sí seguirán mergeándose en
            // vivo vía el polling (pollGlobalesJugadores en index.js).
            const { rows: globalRows } = await gClient.query(`SELECT * FROM player_globals;`);
            for (const row of globalRows) {
                const local = STATE.baseDatos[row.key];
                if (!local) continue;
                local.monedas = Math.max(local.monedas || 0, Number(row.monedas) || 0);
                local.badges = Array.from(new Set([...(local.badges || []), ...(row.badges || [])]));
                local.vip = !!local.vip || !!row.vip;
                local.vip_tortu = !!local.vip_tortu || !!row.vip_tortu;
                local.vip_perma = !!local.vip_perma || !!row.vip_perma;
                local.vip_expira = Math.max(local.vip_expira || 0, Number(row.vip_expira) || 0) || local.vip_expira || null;
                local.vip_tier = local.vip_tier || row.vip_tier || "vip";
                local.discord_verificado = !!local.discord_verificado || !!row.discord_verificado;
                local.discord_id = local.discord_id || row.discord_id || null;
                local.discord_tag = local.discord_tag || row.discord_tag || null;
                local.clan = local.clan || row.clan || null;
            }

            // Clanes globales: fuente de verdad es global_state, no
            // league_state (que quedó como fallback si esto falla).
            const { rows: gsRows } = await gClient.query(`SELECT clanes FROM global_state WHERE id = 1;`);
            STATE.clanes = (gsRows[0] && gsRows[0].clanes) || STATE.clanes || {};
            lastSavedClanesGlobal = STATE.clanes;

            // Nombres reservados: mapa nombre -> key dueña, para que el
            // chequeo en onPlayerJoin sea instantáneo (sin ir a Postgres en
            // cada conexión). Se refresca en vivo con el polling de
            // index.js (pollNombresReservados).
            //
            // SEMBRADO (backfill) antes de leer: cualquier jugador de ESTA
            // sala que ya tenga Public ID real (key sin prefijo "anon_") se
            // reserva automáticamente con el nombre que tenía guardado —
            // ON CONFLICT DO NOTHING, así que si dos jugadores reales
            // distintos alguna vez tuvieron el mismo nombre_actual en algún
            // momento de la historia, gana el primero que se procese acá
            // (no importa mucho el orden, es un caso raro). Esto es lo que
            // evita la ventana de robo: sin este paso, un jugador viejo con
            // auth real (como Rodri) quedaba tan "sin proteger" como
            // cualquier anónimo hasta que se reconectara — un impostor podía
            // ganarle de mano. Corre en CADA restart (no sólo la primera
            // vez), pero ON CONFLICT DO NOTHING lo hace barato y seguro de
            // repetir.
            const jugadoresConAuth = playerRows.filter(r => r.key && !r.key.startsWith("anon_") && r.data && r.data.nombre_actual);
            if (jugadoresConAuth.length) {
                const values = jugadoresConAuth.map((r, i) => `($${i * 2 + 1}, $${i * 2 + 2})`).join(",");
                const params = jugadoresConAuth.flatMap(r => [r.data.nombre_actual.toLowerCase().trim(), r.key]);
                await gClient.query(
                    `INSERT INTO nombres_reservados (nombre, owner_key, room_id, updated_at)
                    SELECT nombre, owner_key, $${params.length + 1}, now()
                    FROM (VALUES ${values}) AS t(nombre, owner_key)
                    ON CONFLICT (nombre) DO NOTHING;`,
                                    [...params, roomId]
                );
            }

            const { rows: nombreRows } = await gClient.query(`SELECT nombre, owner_key FROM nombres_reservados;`);
            STATE.nombresReservados = new Map(nombreRows.map(r => [r.nombre, r.owner_key]));

            const { rows: adminRows } = await gClient.query(`SELECT auth FROM admins_automaticos;`);
            STATE.adminsAutomaticos = new Set(adminRows.map(r => r.auth));

            Logger.info(`✅ Postgres${roomId ? ` [${roomId}]` : ""}: ${playerRows.length} jugadores · ${banRows.length} baneos · ${globalRows.length} cuentas globales · ${nombreRows.length} nombres reservados · ${adminRows.length} admins automáticos (${jugadoresConAuth.length} nuevos)`);
        } finally {
            gClient.release();
        }
    } catch (e) {
        Logger.error("❌ Error cargando datos globales desde PostgreSQL:", e.message);
    }
}

function chunk(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
}

async function upsertPlayersBatch(client, entries, roomId) {
    for (const batch of chunk(entries, CHUNK_SIZE)) {
        const values = [];
        const params = [];
        batch.forEach(([key, data], i) => {
            const base = i * 3;
            values.push(`($${base + 1}, $${base + 2}::jsonb, $${base + 3}, now())`);
            params.push(key, JSON.stringify(data), roomId);
        });
        await client.query(
            `INSERT INTO players (key, data, room_id, updated_at)
            VALUES ${values.join(", ")}
            ON CONFLICT (key) DO UPDATE
            SET data = EXCLUDED.data,
            room_id = COALESCE(EXCLUDED.room_id, players.room_id),
                           updated_at = EXCLUDED.updated_at;`,
                           params
        );
    }
}

/**
 * Borra DEFINITIVAMENTE la fila de un jugador de `players` (esta sala). A
 * diferencia de `delete STATE.baseDatos[key]` en index.js (que sólo borra
 * en memoria — el guardado normal nunca emite un DELETE, sólo INSERT/UPDATE,
 * así que una fila "borrada" en RAM sigue viva en Postgres y VUELVE en el
 * próximo restart), esto sí la saca de la base de una. Se usa para el
 * comando de recuperación de identidad robada (!recuperaridentidad): el que
 * se coló con el nombre de otro tiene que perder los datos de verdad, no
 * sólo hasta el próximo `pm2 restart`.
 */
async function deletePlayerLocal(key) {
    if (!key) return;
    try {
        const client = await getPool().connect();
        try {
            await client.query(`DELETE FROM players WHERE key = $1;`, [key]);
            // FIX #78: limpiar el baseline del diff. Sin esto, si la key se
            // vuelve a crear con contenido IDÉNTICO (raro pero posible),
            // saveDatabase puede pensar "no cambió" y nunca reinsertarla.
            delete lastSavedPlayers[key];
        } finally {
            client.release();
        }
    } catch (e) {
        Logger.error("❌ Error borrando jugador de PostgreSQL (sala):", e.message);
    }
}

/**
 * Versión batch de deletePlayerLocal: borra N filas en UNA sola query
 * (WHERE key = ANY($1)). La usa limpiarBaseDatos() de index.js, que puede
 * llegar a borrar cientos de perfiles inactivos en una corrida — hacerlo de
 * a uno serían cientos de round-trips y conexiones del pool al pedo.
 * Nunca lanza (mismo contrato que deletePlayerLocal): si falla, las filas
 * quedan y se reintenta naturalmente en el próximo arranque.
 */
async function deletePlayersLocalBatch(keys) {
    if (!keys || !keys.length) return;
    try {
        const client = await getPool().connect();
        try {
            await client.query(`DELETE FROM players WHERE key = ANY($1);`, [keys]);
            // FIX #78: limpiar baseline para todas las keys borradas.
            for (const k of keys) delete lastSavedPlayers[k];
        } finally {
            client.release();
        }
    } catch (e) {
        Logger.error("❌ Error borrando jugadores en batch de PostgreSQL (sala):", e.message);
    }
}

/**
 * Igual que deletePlayerLocal pero para la fila espejo en player_globals
 * (monedas/VIP/badges/clan globales) — mismo motivo, mismo comando.
 */
async function deletePlayerGlobalRow(key) {
    if (!key) return;
    try {
        const client = await getGlobalPool().connect();
        try {
            await client.query(`DELETE FROM player_globals WHERE key = $1;`, [key]);
        } finally {
            client.release();
        }
    } catch (e) {
        Logger.error("❌ Error borrando jugador de PostgreSQL (global):", e.message);
    }
}

/**
 * FIX #4 / #12: merge de diccionarios con soporte de BORRADOS.
 * Antes sólo copiaba hacia el resultado las claves que estaban en `local`
 * y habían cambiado respecto a `previo`. Si una sala BORRABA una entrada
 * (clan eliminado, título exclusivo liberado, record removido), esa clave
 * simplemente no estaba en `local` — y el loop la ignoraba, dejando la
 * versión vieja del remoto intacta. Ahora hay un segundo loop que detecta
 * "estaba en previo, ya no está en local, y el remoto no lo tocó desde
 * entonces" y lo borra del resultado.
 */
function mergeDiccionario(remotoDict, localDict, previoDict) {
    const remoto = remotoDict || {};
    const local = localDict || {};
    const previo = previoDict || {};
    const resultado = { ...remoto };
    for (const k of Object.keys(local)) {
        if (JSON.stringify(local[k]) !== JSON.stringify(previo[k])) resultado[k] = local[k];
    }
    // FIX #12: propagar borrados locales.
    for (const k of Object.keys(previo)) {
        if (!(k in local) && JSON.stringify(remoto[k]) === JSON.stringify(previo[k])) {
            delete resultado[k];
        }
    }
    return resultado;
}

function mergeCampeones(remotoArr, localArr, previoArr) {
    const remoto = remotoArr || [];
    const local = localArr || [];
    const previo = previoArr || [];
    const nuevosLocales = local.filter(c => !previo.some(p => JSON.stringify(p) === JSON.stringify(c)));
    const aAgregar = nuevosLocales.filter(c => !remoto.some(r => JSON.stringify(r) === JSON.stringify(c)));
    return remoto.concat(aAgregar);
}

// Cede el control al event loop (usa setImmediate, que corre después de
// I/O y antes que setTimeout: es la forma más barata de "hacer una pausa"
// sin agregar latencia innecesaria). Esto es lo que evita que serializar
// muchos jugadores de una sentada bloquee el tick físico de Haxball.
function yieldToEventLoop() {
    return new Promise(resolve => setImmediate(resolve));
}

let guardadoEnCurso = null;
let savesDesdeFullDiff = 0;
// Red de seguridad: aunque todos los call sites de markDirty() ya pasen la
// clave, cada tanto se hace un full-diff igual (por si algo tocó baseDatos
// directamente sin pasar por markDirty, o por un save que falló a mitad).
// ~10 min con el intervalo de 15s por defecto.
const FULL_DIFF_CADA_N_SAVES = 40;

/**
 * Persiste STATE en PostgreSQL. No hace nada si no hay cambios pendientes
 * (STATE.isDirty === false) y evita que dos guardados corran en paralelo.
 * `roomId` es opcional; se guarda como metadato en `room_id` para las filas
 * que este proceso modifica, sin afectar la compatibilidad con datos ya
 * existentes que no lo tengan.
 */
async function saveDatabase(STATE, roomId = null) {
    if (guardadoEnCurso) return guardadoEnCurso;
    if (!STATE.isDirty) return;

    guardadoEnCurso = (async () => {
        STATE.isDirty = false;
        const client = await getPool().connect();
        let dirtyTomados = null;
        try {
            await client.query("BEGIN");

            // ── Jugadores ──
            // Camino rápido: si hay claves marcadas dirty y no toca full-diff,
            // se serializa SOLO esos jugadores (JSON.stringify de unos pocos
            // objetos en vez de la base entera) -> el spike periódico del
            // autosave desaparece en el caso típico (pocos jugadores tocados
            // cada 15s). Camino lento (full diff): primera vez, llamadas
            // legacy a markDirty() sin clave, o cada FULL_DIFF_CADA_N_SAVES
            // como red de seguridad.
            const entriesLocales = Object.entries(STATE.baseDatos || {});
            const usarFullDiff = STATE.fullDiffPendiente || savesDesdeFullDiff >= FULL_DIFF_CADA_N_SAVES || Object.keys(lastSavedPlayers).length === 0;

            let cambiados = [];
            const serializados = {};

            if (!usarFullDiff && STATE.dirtyPlayers && STATE.dirtyPlayers.size > 0) {
                // Swap del set: lo que se marque dirty DURANTE este guardado
                // (p.ej. un gol que entra mientras se está guardando) queda
                // para el próximo ciclo en vez de perderse.
                dirtyTomados = STATE.dirtyPlayers;
                STATE.dirtyPlayers = new Set();
                for (const key of dirtyTomados) {
                    if (STATE.baseDatos[key] !== undefined) {
                        const data = STATE.baseDatos[key];
                        cambiados.push([key, data]);
                        serializados[key] = JSON.stringify(data);
                    }
                }
                savesDesdeFullDiff++;
            } else if (!usarFullDiff && (!STATE.dirtyPlayers || STATE.dirtyPlayers.size === 0)) {
                // isDirty estaba en true pero no hay claves puntuales ni full-diff
                // pendiente (p.ej. sólo cambió league_state) -> no hay nada que
                // comparar en players, se sigue directo a league_state.
                savesDesdeFullDiff++;
            } else {
                STATE.fullDiffPendiente = false;
                savesDesdeFullDiff = 0;
                for (let i = 0; i < entriesLocales.length; i++) {
                    const [key, data] = entriesLocales[i];
                    const serializado = JSON.stringify(data);
                    serializados[key] = serializado;
                    if (lastSavedPlayers[key] !== serializado) cambiados.push([key, data]);

                    if (i > 0 && i % YIELD_EVERY === 0) {
                        await yieldToEventLoop();
                    }
                }
            }
            if (cambiados.length) await upsertPlayersBatch(client, cambiados, roomId);

            // ── league_state: fila única compartida (por-sala; clanes ya NO
            // vive acá, ver saveClanesGlobal para eso) ──
            const { rows } = await client.query(`SELECT * FROM league_state WHERE id = $1 FOR UPDATE;`, [LEAGUE_STATE_ID]);
            const remoto = rows[0] || DEFAULT_LEAGUE_ROW;
            const previo = lastSavedLeague || snapshotLeague(STATE);
            const local = snapshotLeague(STATE);

            const recordsFinal = mergeDiccionario(remoto.records, local.records, previo.records);
            const authFinal = mergeDiccionario(remoto.auth_registrados, local.authRegistrados, previo.authRegistrados);
            const titulosFinal = mergeDiccionario(remoto.titulos_exclusivos, local.titulosExclusivos, previo.titulosExclusivos); // FIX #15: merge normal, sin blacklist
            const campeonesFinal = mergeCampeones(remoto.campeones, local.campeones, previo.campeones);

            const temporadaCambioLocal = local.temporadaActual !== previo.temporadaActual;
            const anuncioCambioLocal = local.anuncioIndex !== previo.anuncioIndex;
            const temporadaFinal = temporadaCambioLocal ? local.temporadaActual : (remoto.temporada_actual ?? local.temporadaActual);
            const anuncioFinal = anuncioCambioLocal ? local.anuncioIndex : (remoto.anuncio_index ?? local.anuncioIndex);

            await client.query(
                `UPDATE league_state SET
                records = $2::jsonb,
                campeones = $3::jsonb,
                auth_registrados = $4::jsonb,
                titulos_exclusivos = $5::jsonb,
                temporada_actual = $6,
                anuncio_index = $7,
                room_id = COALESCE($8, room_id),
                               updated_at = now()
                               WHERE id = $1;`,
                               [
                                   LEAGUE_STATE_ID,
                               JSON.stringify(recordsFinal),
                               JSON.stringify(campeonesFinal),
                               JSON.stringify(authFinal),
                               JSON.stringify(titulosFinal),
                               temporadaFinal,
                               anuncioFinal,
                               roomId,
                               ]
            );

            await client.query("COMMIT");

            // Actualizar copias de último guardado y STATE con lo que haya en la base
            for (const key of Object.keys(serializados)) lastSavedPlayers[key] = serializados[key];

            STATE.records = recordsFinal;
            STATE.authRegistrados = authFinal;
            STATE.titulosExclusivos = titulosFinal;
            STATE.campeones = campeonesFinal;
            STATE.TEMPORADA_ACTUAL = temporadaFinal;
            STATE.anuncioIndex = anuncioFinal;
            lastSavedLeague = snapshotLeague(STATE);
        } catch (e) {
            await client.query("ROLLBACK").catch(() => {});
            Logger.error("❌ Error guardando en PostgreSQL:", e.message);
            STATE.isDirty = true;
            // Si el guardado falló a mitad de camino, las claves que se habían
            // tomado del set dirty (y ya se habían vaciado de STATE.dirtyPlayers)
            // se devuelven para no perder el cambio en el próximo intento.
            if (dirtyTomados) {
                for (const k of dirtyTomados) STATE.dirtyPlayers.add(k);
            }
            STATE.fullDiffPendiente = true; // fuerza full diff en el próximo intento, por las dudas
            // Invalidar caché para forzar reintento en próximo ciclo
            lastSavedPlayers = {};
            lastSavedLeague = null;
            throw e;
        } finally {
            client.release();
        }
    })();

    try {
        await guardadoEnCurso;
    } finally {
        guardadoEnCurso = null;
    }
}

// Guard de reentrancia para backupDatabase — mismo motivo que
// `guardadoEnCurso` en saveDatabase: si el intervalo programado dispara un
// backup mientras el anterior todavía no terminó (carga alta, backup manual
// de admin superpuesto con el automático, etc.), sin este guard se abrirían
// dos transacciones en paralelo compitiendo por el mismo DELETE ... OFFSET
// keep — no corrompe datos pero gasta conexiones del pool y hace trabajo
// doble.
let backupEnCurso = null;

/**
 * Guarda un snapshot completo como fila de la tabla `backups` y elimina los
 * más viejos que excedan `keep`.
 *
 * FIX #77: el llamador (index.js) ya fuerza un saveDatabase() antes de
 * llamar acá, así que el snapshot que arma la query leyendo de `players`
 * está al día. Este archivo no puede forzar el save desde adentro porque
 * no tiene acceso a STATE — el contrato es "el caller se asegura".
 */
async function backupDatabase(STATE, keep = 20, roomId = null) {
    if (backupEnCurso) return backupEnCurso;
    backupEnCurso = backupDatabaseInterno(STATE, keep, roomId);
    try {
        await backupEnCurso;
    } finally {
        backupEnCurso = null;
    }
}

async function backupDatabaseInterno(STATE, keep, roomId) {
    const client = await getPool().connect();
    try {
        // OJO: antes acá se armaba `baseDatos` copiando STATE.baseDatos entero
        // y se le hacía JSON.stringify() de un solo saque en Node. Con una
        // base de jugadores grande eso bloqueaba el event loop (y con él el
        // tick físico) el tiempo suficiente para notarse como spike de
        // ping/fps, porque a diferencia de saveDatabase() esta serialización
        // no cedía el control en ningún punto.
        //
        // Ahora el bloque de jugadores lo arma Postgres directo desde la
        // tabla `players` (que ya está al día por el último saveDatabase) con
        // jsonb_object_agg: el trabajo pesado de serializar se hace en la
        // base, no en el proceso de Node que corre la física de la sala.
        // Sólo las colecciones chicas (records, clanes, etc.) se siguen
        // stringifyeando en JS porque su tamaño es despreciable.
        const metaSnapshot = {
            records: STATE.records,
            campeones: STATE.campeones,
            clanes: STATE.clanes,
            authRegistrados: STATE.authRegistrados,
            titulosExclusivos: STATE.titulosExclusivos, // FIX #15: incluirlo en backups
            temporadaActual: STATE.TEMPORADA_ACTUAL,
            anuncioIndex: STATE.anuncioIndex,
            timestamp: Date.now(),
        };

        await client.query("BEGIN");
        await client.query(
            `INSERT INTO backups (snapshot, room_id)
            SELECT jsonb_set(
                $1::jsonb,
                '{baseDatos}',
                COALESCE((SELECT jsonb_object_agg(key, data) FROM players), '{}'::jsonb)
            ), $2;`,
            [JSON.stringify(metaSnapshot), roomId]
        );
        await client.query(
            `DELETE FROM backups
            WHERE id IN (
                SELECT id FROM backups ORDER BY created_at DESC OFFSET $1
            );`,
            [keep]
        );
        await client.query("COMMIT");
        Logger.info(`💾 Backup guardado en PostgreSQL${roomId ? ` [${roomId}]` : ""}.`);
    } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        Logger.error("❌ Error creando backup en PostgreSQL:", e.message);
    } finally {
        client.release();
    }
}

/**
 * Reserva un nombre para una key, PERO SÓLO si no está reservado ya a otra
 * key distinta — ON CONFLICT DO NOTHING a propósito: el primer dueño de un
 * nombre lo es para siempre, esta función nunca "roba" una reserva ajena
 * (para eso está liberarNombreReservado, uso explícito de admin). Se llama
 * desde onPlayerJoin cada vez que alguien entra, así que si ya está
 * reservado a esa misma key es simplemente un no-op barato.
 */
async function reservarNombre(nombre, ownerKey, roomId = null) {
    if (!nombre || !ownerKey) return;
    try {
        const client = await getGlobalPool().connect();
        try {
            await client.query(
                `INSERT INTO nombres_reservados (nombre, owner_key, room_id, updated_at)
                VALUES ($1, $2, $3, now())
                ON CONFLICT (nombre) DO NOTHING;`,
                               [nombre, ownerKey, roomId]
            );
        } finally {
            client.release();
        }
    } catch (e) {
        Logger.error("❌ Error reservando nombre en PostgreSQL:", e.message);
    }
}

/**
 * Libera un nombre reservado (lo borra de la tabla) — para el comando de
 * admin que resuelve reservas hechas por error o por mala fe.
 */
async function liberarNombreReservado(nombre) {
    if (!nombre) return;
    try {
        const client = await getGlobalPool().connect();
        try {
            await client.query(`DELETE FROM nombres_reservados WHERE nombre = $1;`, [nombre]);
        } finally {
            client.release();
        }
    } catch (e) {
        Logger.error("❌ Error liberando nombre reservado en PostgreSQL:", e.message);
    }
}

/**
 * FIX #25: limpia reservas huérfanas. Cuando limpiarBaseDatos() borra
 * perfiles inactivos, esas keys ya no existen — pero si esa key era dueña
 * de un nombre reservado, la fila queda en nombres_reservados apuntando a
 * un perfil muerto. Esto libera todas las reservas cuyo owner_key NO esté
 * en el set de keys vivas. Se llama al final de limpiarBaseDatos() en
 * index.js.
 */
async function liberarReservasHuerfanas(keysVivas) {
    if (!keysVivas || !keysVivas.length) return;
    try {
        const client = await getGlobalPool().connect();
        try {
            const res = await client.query(
                `DELETE FROM nombres_reservados WHERE owner_key != ALL($1::text[]);`,
                [keysVivas]
            );
            if (res.rowCount > 0) Logger.info(`🧹 ${res.rowCount} reservas de nombres huérfanas liberadas`);
        } finally {
            client.release();
        }
    } catch (e) {
        Logger.error("❌ Error liberando reservas huérfanas:", e.message);
    }
}

/**
 * Combina en UNA sola conexión lo que antes eran 2 llamadas separadas
 * (fetchPlayerBans + fetchNombresReservados) — ambas se piden en el MISMO
 * ciclo de polling de 60s desde index.js, así que no tenía sentido pedir
 * 2 conexiones del pool y hacer 2 round-trips cuando 1 conexión alcanza
 * para las 2 queries. Se agrega esta función nueva sin tocar las 2
 * originales (siguen existiendo, algún otro caller las puede seguir usando
 * sueltas si hace falta).
 */
async function fetchGlobalSyncData() {
    const client = await getGlobalPool().connect();
    try {
        const bans = await client.query(`SELECT key, ban_hasta, blacklisted FROM player_bans;`);
        const nombres = await client.query(`SELECT nombre, owner_key FROM nombres_reservados;`);
        return { bans: bans.rows, nombres: nombres.rows };
    } finally {
        client.release();
    }
}

async function fetchNombresReservados() {
    const client = await getGlobalPool().connect();
    try {
        const { rows } = await client.query(`SELECT nombre, owner_key FROM nombres_reservados;`);
        return rows;
    } finally {
        client.release();
    }
}

/**
 * Agrega un auth a la lista de admins automáticos. ON CONFLICT DO NOTHING
 * (no UPDATE) a propósito — si ya estaba, no hace falta tocar nada; si se
 * quiere registrar quién lo agregó de nuevo, se usa !deladmin + !addadmin.
 */
async function agregarAdminAuto(auth, agregadoPor, roomId = null) {
    if (!auth) return;
    try {
        const client = await getGlobalPool().connect();
        try {
            await client.query(
                `INSERT INTO admins_automaticos (auth, agregado_por, room_id, fecha)
                VALUES ($1, $2, $3, now())
                ON CONFLICT (auth) DO NOTHING;`,
                               [auth, agregadoPor, roomId]
            );
        } finally {
            client.release();
        }
    } catch (e) {
        Logger.error("❌ Error agregando admin automático en PostgreSQL:", e.message);
    }
}

async function quitarAdminAuto(auth) {
    if (!auth) return;
    try {
        const client = await getGlobalPool().connect();
        try {
            await client.query(`DELETE FROM admins_automaticos WHERE auth = $1;`, [auth]);
        } finally {
            client.release();
        }
    } catch (e) {
        Logger.error("❌ Error quitando admin automático en PostgreSQL:", e.message);
    }
}

async function fetchAdminsAuto() {
    const client = await getGlobalPool().connect();
    try {
        const { rows } = await client.query(`SELECT auth, agregado_por, fecha FROM admins_automaticos ORDER BY fecha ASC;`);
        return rows;
    } finally {
        client.release();
    }
}

/**
 * Lee toda la tabla player_bans de un saque. La usa el polling periódico de
 * index.js (ver aplicarPollingBaneos) para enterarse de baneos puestos por
 * la OTRA sala sin tener que esperar a un restart. Es una tabla chica
 * (un row por jugador baneado alguna vez, no por jugador total), así que
 * traerla entera cada minuto es barato.
 */
async function fetchPlayerBans() {
    const client = await getGlobalPool().connect();
    try {
        const { rows } = await client.query(`SELECT key, ban_hasta, blacklisted FROM player_bans;`);
        return rows;
    } finally {
        client.release();
    }
}

/**
 * Sobre-escribe (force overwrite, NO merge) la cuenta global de un jugador
 * con sus valores locales actuales. Se llama desde el autosave de index.js
 * para cada key que se guardó ese ciclo — así no hace falta tocar cada
 * comando que da/saca monedas, badges, etc.: en cuanto ese comando ya hace
 * markDirty() (como ya hacían todos), el próximo autosave (15s) empuja el
 * cambio a la base global sola.
 *
 * A propósito NO usa GREATEST/OR acá (a diferencia de upsertPlayerBan): acá
 * el valor local YA es la verdad más reciente para esa sala, así que pisar
 * directo es lo correcto — si hiciera merge conservador, un gasto de
 * monedas nunca podría bajar el número global.
 */
async function upsertPlayerGlobals(key, fields, roomId = null) {
    if (!key) return;
    try {
        const client = await getGlobalPool().connect();
        try {
            await client.query(
                `INSERT INTO player_globals (
                    key, monedas, badges, vip, vip_tortu, vip_perma, vip_expira,
                    vip_tier, discord_verificado, discord_id, discord_tag, clan, room_id, updated_at
                ) VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now())
                ON CONFLICT (key) DO UPDATE SET
                monedas = EXCLUDED.monedas,
                badges = EXCLUDED.badges,
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
                               updated_at = now();`,
                               [
                                   key,
                               fields.monedas || 0,
                               JSON.stringify(fields.badges || []),
                               !!fields.vip,
                               !!fields.vip_tortu,
                               !!fields.vip_perma,
                               fields.vip_expira || null,
                               fields.vip_tier || "vip",
                               !!fields.discord_verificado,
                               fields.discord_id || null,
                               fields.discord_tag || null,
                               fields.clan || null,
                               roomId,
                               ]
            );
        } finally {
            client.release();
        }
    } catch (e) {
        Logger.error("❌ Error guardando player_globals en PostgreSQL:", e.message);
    }
}

/**
 * Lee toda la tabla player_globals de un saque. La usa el polling de
 * index.js (pollGlobalesJugadores) para enterarse en vivo de badges/VIP/
 * Discord ganados en la OTRA sala. Adrede NO se usa para monedas en el
 * polling (sólo al cargar, ver loadDatabase) — ver comentario en
 * migrateGlobal sobre por qué.
 */
async function fetchPlayerGlobals() {
    const client = await getGlobalPool().connect();
    try {
        const { rows } = await client.query(`SELECT * FROM player_globals;`);
        return rows;
    } finally {
        client.release();
    }
}

/**
 * Sincroniza STATE.clanes con la fila única de global_state, en las DOS
 * direcciones: empuja los cambios locales Y trae los cambios que haya hecho
 * la otra sala, usando el mismo merge de 3 vías (remoto/local/previo) que
 * ya se usaba para league_state — así crear un clan en HA y que alguien se
 * una en H4 casi al mismo tiempo no se pisa. Se llama en cada ciclo de
 * autosave (15s) desde index.js, así que clanes queda casi en tiempo real.
 */
async function saveClanesGlobal(STATE, roomId = null) {
    const client = await getGlobalPool().connect();
    try {
        await client.query("BEGIN");
        const { rows } = await client.query(`SELECT clanes FROM global_state WHERE id = 1 FOR UPDATE;`);
        const remoto = (rows[0] && rows[0].clanes) || {};
        const previo = lastSavedClanesGlobal || remoto;
        const local = STATE.clanes || {};
        const final = mergeDiccionario(remoto, local, previo);

        await client.query(
            `UPDATE global_state SET clanes = $1::jsonb, room_id = COALESCE($2, room_id), updated_at = now() WHERE id = 1;`,
                           [JSON.stringify(final), roomId]
        );
        await client.query("COMMIT");
        STATE.clanes = final;
        lastSavedClanesGlobal = final;
    } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        Logger.error("❌ Error sincronizando clanes globales:", e.message);
    } finally {
        client.release();
    }
}

/**
 * Persiste (o actualiza) el ban/blacklist global de un jugador.
 * Fire-and-forget: no bloquea el evento que lo dispara, errores sólo se
 * loguean.
 *
 * `force=false` (default, usar para PONER un ban o blacklist nuevo): hace
 * merge no-destructivo contra lo que ya haya en la base — se queda con el
 * ban_hasta más lejano (GREATEST) y con blacklisted=true si cualquiera de
 * las dos salas lo puso. Así nunca un ban nuevo "acorta" sin querer uno más
 * largo que ya existía puesto desde la otra sala.
 *
 * `force=true` (usar para SACAR un ban o blacklist): pisa directo, sin
 * comparar, porque ahí sí la intención es explícitamente anular el valor
 * anterior sin importar cuál sea.
 *
 * ⚠️ OJO: este upsert con force=true pisa AMBAS columnas. Para escrituras
 * que sólo quieren tocar UNA columna (ej: desbanear sin tocar blacklist),
 * usar upsertPlayerBanParcial de abajo — ver FIX #5.
 */
async function upsertPlayerBan(key, { ban_hasta = 0, blacklisted = false } = {}, roomId = null, force = false) {
    if (!key) return;
    try {
        const client = await getGlobalPool().connect();
        try {
            if (force) {
                await client.query(
                    `INSERT INTO player_bans (key, ban_hasta, blacklisted, room_id, updated_at)
                    VALUES ($1, $2, $3, $4, now())
                    ON CONFLICT (key) DO UPDATE
                    SET ban_hasta = EXCLUDED.ban_hasta,
                    blacklisted = EXCLUDED.blacklisted,
                    room_id = COALESCE(EXCLUDED.room_id, player_bans.room_id),
                                   updated_at = now();`,
                                   [key, ban_hasta, blacklisted, roomId]
                );
            } else {
                await client.query(
                    `INSERT INTO player_bans (key, ban_hasta, blacklisted, room_id, updated_at)
                    VALUES ($1, $2, $3, $4, now())
                    ON CONFLICT (key) DO UPDATE
                    SET ban_hasta = GREATEST(player_bans.ban_hasta, EXCLUDED.ban_hasta),
                                   blacklisted = player_bans.blacklisted OR EXCLUDED.blacklisted,
                                   room_id = COALESCE(EXCLUDED.room_id, player_bans.room_id),
                                   updated_at = now();`,
                                   [key, ban_hasta, blacklisted, roomId]
                );
            }
        } finally {
            client.release();
        }
    } catch (e) {
        Logger.error("❌ Error guardando player_ban en PostgreSQL:", e.message);
    }
}

/**
 * FIX #5 (parte 2): upsert PARCIAL de player_bans. Sólo toca las columnas
 * que vienen en `campos`. El caso que motivó esto: quitarBanGlobal en
 * index.js hacía upsertPlayerBan(..., force=true) con TODOS los valores
 * locales — si la otra sala había puesto blacklisted=true hace un rato y
 * esta sala todavía no se había enterado (poll cada 60s), el force=true
 * sobreescribía blacklisted con el valor viejo local (false), borrando el
 * blacklist de la otra sala. Con upsert parcial, sólo se pisa la columna
 * que realmente se quiere cambiar.
 */
async function upsertPlayerBanParcial(key, campos, roomId = null) {
    if (!key || !campos) return;
    const sets = [];
    const vals = [key];
    let idx = 2;
    if (campos.ban_hasta !== undefined) { sets.push(`ban_hasta = $${idx++}`); vals.push(campos.ban_hasta); }
    if (campos.blacklisted !== undefined) { sets.push(`blacklisted = $${idx++}`); vals.push(campos.blacklisted); }
    if (!sets.length) return;
    vals.push(roomId);
    try {
        const client = await getGlobalPool().connect();
        try {
            await client.query(
                `INSERT INTO player_bans (key, ban_hasta, blacklisted, room_id, updated_at)
                VALUES ($1, COALESCE($2, 0), COALESCE($3, false), $${idx}, now())
                ON CONFLICT (key) DO UPDATE SET ${sets.join(", ")}, room_id = COALESCE($${idx}, player_bans.room_id), updated_at = now();`,
                [key, campos.ban_hasta ?? null, campos.blacklisted ?? null, roomId]
            );
        } finally {
            client.release();
        }
    } catch (e) {
        Logger.error("❌ Error guardando player_ban parcial en PostgreSQL:", e.message);
    }
}

/**
 * FIX #15 (parte 3): helpers para bot_state. Guardan y leen el message id
 * del live stats (o cualquier otra key puntual de estado del bot) para no
 * crear un mensaje nuevo en Discord en cada reinicio de pm2.
 */
async function setBotState(key, value) {
    if (!key) return;
    try {
        const client = await getPool().connect();
        try {
            await client.query(
                `INSERT INTO bot_state (key, value, updated_at) VALUES ($1, $2, now())
                 ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();`,
                [key, String(value)]
            );
        } finally {
            client.release();
        }
    } catch (e) {
        Logger.error("❌ Error guardando bot_state:", e.message);
    }
}

async function getBotState(key) {
    if (!key) return null;
    try {
        const client = await getPool().connect();
        try {
            const { rows } = await client.query(`SELECT value FROM bot_state WHERE key = $1 LIMIT 1;`, [key]);
            return rows[0]?.value ?? null;
        } finally {
            client.release();
        }
    } catch (e) {
        return null;
    }
}

/**
 * Cierra AMBOS pools de conexiones (sala + global) de forma segura. Es
 * idempotente: si ya están cerrados, o si se llama dos veces en paralelo
 * (p.ej. doble señal de shutdown), no revienta ni intenta cerrar dos veces
 * el mismo pool. Se cierran en paralelo porque son independientes entre sí.
 * FIX #80: marca procesoApagado al principio para que ningún timer que
 * sobreviva pueda reabrir un pool nuevo mientras se cierra.
 */
async function closePool() {
    marcarProcesoApagado();
    await Promise.all([closeRoomPool(), closeGlobalPool()]);
}

async function closeRoomPool() {
    if (poolClosing) return poolClosing;
    if (!poolInstance) {
        Logger.info("⚠️ Pool de sala ya estaba cerrado o no existía.");
        return;
    }
    const instanciaACerrar = poolInstance;
    poolInstance = null; // evita que nuevas llamadas a getPool() reciban esta instancia
    poolClosing = (async () => {
        try {
            await instanciaACerrar.end();
            Logger.info("🔒 Pool de PostgreSQL (sala) cerrado.");
        } catch (e) {
            Logger.error("❌ Error cerrando el pool de PostgreSQL (sala):", e.message);
        }
    })();
    try {
        await poolClosing;
    } finally {
        poolClosing = null;
    }
}

async function closeGlobalPool() {
    if (globalPoolClosing) return globalPoolClosing;
    if (!globalPoolInstance) {
        Logger.info("⚠️ Pool global ya estaba cerrado o no existía.");
        return;
    }
    const instanciaACerrar = globalPoolInstance;
    globalPoolInstance = null;
    globalPoolClosing = (async () => {
        try {
            await instanciaACerrar.end();
            Logger.info("🔒 Pool de PostgreSQL (global) cerrado.");
        } catch (e) {
            Logger.error("❌ Error cerrando el pool de PostgreSQL (global):", e.message);
        }
    })();
    try {
        await globalPoolClosing;
    } finally {
        globalPoolClosing = null;
    }
}

// Exportar solo las funciones necesarias.
// NOTA: ya no se exporta `pool` como valor estático (evaluado en el momento
// del require), porque eso creaba una conexión al importar el módulo aunque
// nunca se usara, y quedaba desincronizado si el pool se cerraba y se volvía
// a abrir. Si se necesita acceso directo, usar getPool() / getGlobalPool().
module.exports = {
    loadDatabase,
    saveDatabase,
    backupDatabase,
    reservarNombre,
    liberarNombreReservado,
    liberarReservasHuerfanas,       // FIX #25
    fetchNombresReservados,
    fetchGlobalSyncData,
    agregarAdminAuto,
    quitarAdminAuto,
    fetchAdminsAuto,
    upsertPlayerBan,
    upsertPlayerBanParcial,          // FIX #5
    fetchPlayerBans,
    upsertPlayerGlobals,
    fetchPlayerGlobals,
    saveClanesGlobal,
    deletePlayerLocal,
    deletePlayersLocalBatch,
    deletePlayerGlobalRow,
    setBotState,                     // FIX #15
    getBotState,                     // FIX #15
    closePool,
    getPool,
    getGlobalPool,
    marcarProcesoApagado,            // FIX #80
};