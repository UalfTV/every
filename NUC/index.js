require("dotenv").config({ path: process.env.ENV_FILE || ".env" });
const HaxballJS = require("haxball.js").default;
const fs = require("fs").promises;
const fsSync = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");

const ROOM_CONFIG_FILE = process.env.ROOM_CONFIG_FILE || "./HA.config.js";
const ROOM_CONFIG = require(ROOM_CONFIG_FILE);
if (ROOM_CONFIG.PG_OVERRIDES && ROOM_CONFIG.PG_OVERRIDES.database) process.env.PGDATABASE = ROOM_CONFIG.PG_OVERRIDES.database;

// ============================================
// SISTEMAS CENTRALIZADOS - EMOJIS Y COLORES
// ============================================

const EMOJIS = {
    success: "\u2705", error: "\u274c", warning: "\u26a0\ufe0f", info: "\ud83d\udca1",
    soccer: "\u26bd", goal: "\u26bd", trophy: "\ud83c\udfc6",
    coins: "\ud83d\udcb0", money: "\ud83d\udcb5", shop: "\ud83d\udecd", gift: "\ud83c\udf81",
    red: "\ud83d\udd34", blue: "\ud83d\udd35", vs: "\u2694\ufe0f",
    fire: "\ud83d\udd25", star: "\u2605", sparkles: "\u2728", crown: "\ud83d\udc51",
    person: "\ud83d\udc64", people: "\ud83d\udc65", clock: "\u23f1\ufe0f",
    message: "\ud83d\udcac", megaphone: "\ud83d\udce3", checkered: "\ud83c\udf1f",
    shield: "\ud83d\udee1\ufe0f", arrow_right: "\u27a1", arrow_left: "\u25c0",
    bronze: "\ud83e\udd49", silver: "\ud83e\udd48", gold: "\ud83e\udd47", platinum: "\ud83d\udc8e", diamond: "\ud83d\udd37",
    master: "\ud83d\udc51", grand_master: "\ud83d\udc51", legend: "\ud83c\udf1f"
};

const COLORES = {
    blanco: 0xFFFFFF, negro: 0x000000, gris: 0x808080,
    rojo: 0xFF3366, azul: 0x00BFFF, verde: 0x00FF88,
    amarillo: 0xFFD700, naranja: 0xFFAA00, morado: 0x9B59B6,
    exito: 0x00FF88, error: 0xFF3366, advertencia: 0xFFAA00, info: 0x00BFFF,
    equipo_rojo: 0xFF3366, equipo_azul: 0x00BFFF,
    vip: 0x3B82F6, super_vip: 0x22D3EE, ultra_vip: 0xFF6B00,
    bronce: 0xCD7F32, plata: 0xC0C0C0, oro: 0xFFD700,
    platino: 0x87CEEB, diamante: 0x1E90FF, maestro: 0x9400D3,
    gran_maestro: 0x6A0DAD, leyenda: 0xFF4500
};

const {
    loadDatabase: loadDatabaseFromPg, saveDatabase: saveDatabaseToPg, backupDatabase: backupDatabaseToPg,
    reservarNombre, liberarNombreReservado, fetchGlobalSyncData, agregarAdminAuto, quitarAdminAuto, fetchAdminsAuto,
    upsertPlayerBan, upsertPlayerBanParcial, upsertPlayerGlobals, fetchPlayerGlobals, saveClanesGlobal,
    deletePlayerLocal, deletePlayersLocalBatch, deletePlayerGlobalRow, liberarReservasHuerfanas,
    closePool, getPool, getGlobalPool, setBotState, getBotState, marcarProcesoApagado,
} = require("./db/database.js");

const HTTP_AGENT = new http.Agent({ keepAlive: true, maxSockets: 4 });
const HTTPS_AGENT = new https.Agent({ keepAlive: true, maxSockets: 4 });
const DISCORD_CB = { fallos: 0, abiertoHasta: 0, UMBRAL: 3, COOLDOWN_MS: 60000 };

const CONFIG = {
    ADMIN_PASSWORD: process.env.ADMIN_PASSWORD,
    HB_TOKEN: process.env.HB_TOKEN,
    OWNER_AUTH: process.env.OWNER_AUTH || null,
    LOG_DIR: "./logs",
    BACKUP_DIR: "./backups",

    POWERSHOT_TICKS: 90, POWERSHOT_CANCEL_DISTANCE: 35, POWERSHOT_BALL_INVMASS: 2,
    POWERSHOT_BALL_BCOEF: 0.75, POWERSHOT_BALL_DAMPING: 0.996,
    POWERSHOT_COLOR_INICIAL: "FFFFFF", POWERSHOT_COLOR_CARGA: "FF0000",
    POWERSHOT_COLOR_DELAY_TICKS: 10, POWERSHOT_FLASH_TICKS: 4, POWERSHOT_MAX_TICKS_CARGADO: 180,
    BALL_MAX_SPEED: 45, VELOCIDAD_PX_POR_METRO: 75, FESTEJO_VEL_MAX: 11,
    POWERSHOT_TIMEOUT_ABSOLUTO_MS: 6000,

    // ── Curva (perpendicular, por ROTACIÓN de velocidad) ──
    // Antes se sumaba una fuerza perpendicular cada tick. El damping del
    // motor (~0.96) disipaba esa fuerza antes de que se acumule — por eso
    // "no se notaba un carajo". Ahora se ROTA el vector velocidad por
    // CURVA_ANGULO_POR_TICK radianes por tick: la dirección cambia de forma
    // acumulativa y el arco total es la suma de todos los ticks. Es lo que
    // hace el efecto Magnus real. Angulo total ≈ suma de decay * angulo.
    CURVA_TICKS: 150,
    // Ángulo por tick y decay para que el arco TOTAL sea notorio.
    // Con 0.022 rad/tick * sum(decay) da ~1.7 rad ≈ 95° de comba total,
    // concentrada en el primer segundo (decay pow > 1) que es cuando el
    // tiro va rápido y el desplazamiento lateral por tick se ve mejor.
    CURVA_ANGULO_POR_TICK: 0.022,
    CURVA_DECAY_POW: 1.2,
    CURVA_GRACE_TICKS: 2,
    CURVA_COLOR_A: "00FFC8", CURVA_COLOR_B: "FFFFFF",

    // ── Rainbow jersey ──
    RAINBOW_GOL_VELOCIDAD: 4,
    RAINBOW_GOL_INTERVALO_TICKS: 2,

    POWERSHOT_VIP_COLOR_A: "00B3B3", POWERSHOT_VIP_COLOR_B: "59FFFF", POWERSHOT_VIP_GRADIENT_SPEED: 0.22,
    POWERSHOT_NORMAL_PALETA_ROJO: ["C41E3A", "FF3B30", "FF7A59", "FF9E80"],
    POWERSHOT_NORMAL_PALETA_AZUL: ["0047AB", "1E90FF", "4FC3F7", "80D8FF"],
    POWERSHOT_NORMAL_GRADIENT_SPEED: 0.12,
    VIP_BALL_TRAIL_MS: 1000,

    VIP_TIERS: {
        vip: { nombre: "🥉 VIP", emoji: "🥉", min: 1, max: 22, chatColor: 0x3B82F6, paleta: ["0EA5E9", "38BDF8", "22AFF5", "2563EB"], gradA: "0EA5E9", gradB: "2563EB", gradSpeed: 0.075, trailMs: 1000, festejoVelMult: 1.6, festejoGradSpeed: 0.10, festejoAvatarIntervalo: 10, festejoDuracionTicks: 150 },
        super_vip: { nombre: "🥈 Super VIP", emoji: "🥈", min: 1, max: 25, chatColor: 0x22D3EE, paleta: ["00F5A0", "00D9F5", "06B6D4", "14B8A6"], gradA: "00F5A0", gradB: "14B8A6", gradSpeed: 0.08, trailMs: 1450, festejoVelMult: 1.8, festejoGradSpeed: 0.13, festejoAvatarIntervalo: 8, festejoDuracionTicks: 165 },
        ultra_vip: { nombre: "👑 Ultra VIP", emoji: "👑", min: 1, max: 30, chatColor: 0xFF6B00, paleta: ["FFB000", "FF6B00", "FF2D00", "B71C1C"], gradA: "FFB000", gradB: "B71C1C", gradSpeed: 0.10, trailMs: 1900, festejoVelMult: 2.0, festejoGradSpeed: 0.16, festejoAvatarIntervalo: 6, festejoDuracionTicks: 180 },
    },

    FESTEJO_VIP_DURACION_TICKS: 150, FESTEJO_VIP_DURACION_MAX_MS: 4000, FESTEJO_VIP_VELOCIDAD_MULT: 1.8,
    FESTEJO_VIP_TRAIL_COLORES: ["FF4500", "FF8C00", "FFD700", "FF6600"],
    FESTEJO_VIP_RGB_COLORES: ["FF0000", "FFFF00", "00FF00", "00FFFF", "0000FF", "FF00FF"],
    FESTEJO_VIP_RGB_VELOCIDAD: 0.08,

    GOAL_GROW_MAX_SIZE: 90, GOAL_GROW_DURATION_MS: 400, GOAL_GROW_HOLD_MS: 900,
    GK_SIZE_BONUS: 2, GK_WARN_DISTANCE: 220, GK_WARN_COOLDOWN_MS: 4000,
    GK_SUGERIR_ZONA_DISTANCIA: 150, GK_SUGERIR_TIEMPO_MS: 40000, GK_SUGERIR_COOLDOWN_MS: 90000,
    CAPITAN_AVATAR: "Ⓒ", CAPITAN_SIZE_BONUS: 0,
    REQUIRE_AUTH_TO_PLAY: false, BAN_POLL_INTERVAL_MS: 60000,
    CAJA_PROBABILIDAD: 0.07, CAJA_MONEDAS_MIN: 75, CAJA_MONEDAS_MAX: 350,
    MVP_XP: 50, MVP_MONEDAS: 75, TIP_INTERVALO_MS: 240000,

    MIN_PLAYERS_VOTE: 4, PORCENTAJE_VOTOS: 50, COOLDOWN_VOTE: 60000,
    AFK_DETECT_MS: 90000, AFK_KICK_MS: 20000, AFK_WARN_MS: 10000,

    // ── Cooldowns AFK (anti-abuso) ──
    // AFK_MIN_DURACION_MS: mínimo que tenés que estar AFK antes de poder
    // volver por tu cuenta (evita el "!afk → sale → !afk → entra" instantáneo
    // que se usaba como teletransporte al arco).
    AFK_MIN_DURACION_MS: 10000,
    // AFK_REINGRESO_COOLDOWN_MS: después de volver de AFK (por comando o
    // por detección automática), cuánto tiempo no podés usar !jugar.
    AFK_REINGRESO_COOLDOWN_MS: 20000,
    // AFK_TOGGLE_COOLDOWN_MS: entre dos usos de !afk durante partido, para
    // que no se pueda ir-y-volver en el mismo segundo.
    AFK_TOGGLE_COOLDOWN_MS: 10000,

    JUGAR_COOLDOWN_MS: 60000,
    MAX_APUESTA: 1000, MAX_DUELO: 500, MAX_RULETA: 500, CUOTA_APUESTA: 1.9,
    MAX_TOQUES_RECIENTES: 20, CACHE_TTL: 60000, ASISTENCIA_VENTANA_MS: 5000,
    ATAJADA_MIN_KMH: 35, ATAJADA_ZONA_DISTANCIA: 220, ATAJADA_VENTANA_MS: 1500,

    ELO_K_NOVATO: 40, ELO_K_INTERMEDIO: 28, ELO_K_VETERANO: 20, ELO_K_TOP: 16, ELO_TOP_UMBRAL: 1800,
    RIVALIDAD_MIN_PARTIDOS: 5, ELO_CAMBIO_MAX: 35, ELO_CAMBIO_MIN_GANANDO: 3, ELO_CAMBIO_MIN_PERDIENDO: 3,
    ELO_PERF_MULT_MAX: 0.20, ELO_PERF_MULT_MIN: -0.20,
    ELO_RACHA_3: 0.02, ELO_RACHA_5: 0.05, ELO_RACHA_10: 0.08,
    ELO_MVP_BONUS: 0.05, ELO_RECONEXION_GRACIA_MS: 45000, ELO_PENALIZACION_ABANDONO: 8,
    ANTISMURF_PARTIDOS_MAX: 15, ANTISMURF_RACHA_MIN: 8, ANTISMURF_WINRATE_MIN: 0.90,

    TIEMPO_ENTRENAMIENTO: 0, GOLES_ENTRENAMIENTO: 0,
    TIEMPO_FUTSAL_X2: 3, GOLES_FUTSAL_X2: 3, TIEMPO_FUTSAL_X3: 3, GOLES_FUTSAL_X3: 3,
    TIEMPO_FUTSAL_X4: 4, GOLES_FUTSAL_X4: 3, TIEMPO_FUTSAL_X5: 5, GOLES_FUTSAL_X5: 5,
    TIEMPO_FUTSAL_X6: 8, GOLES_FUTSAL_X6: 4, TIEMPO_FUTSAL_X7: 10, GOLES_FUTSAL_X7: 4,
    TIEMPO_AUTOMATIZADO: 3, GOLES_AUTOMATIZADO: 0,
    TAMANO_DEFAULT: 15, TAMANO_MIN: 1, TAMANO_MAX: 30,
    MUTE_DEFAULT_MIN: 5, FLOOD_MAX_MENSAJES: 10, FLOOD_VENTANA_MS: 10000, FLOOD_MUTE_MS: 30000,
    OWNER_NAME: "joacardo",
    AUTOMATED_MODE_DEFAULT: false, AUTOMATED_MODE_ANNOUNCE: true, AUTOMATED_MODE_ANNOUNCE_IDLE_MS: 600000,

    BOT_HTTP_URL: process.env.BOT_HTTP_URL || "http://127.0.0.1:8789/evento",
    BOT_HTTP_SECRETO: process.env.BOT_HTTP_SECRETO, BOT_HTTP_TIMEOUT_MS: 5000,
    NOMBRE_SALA: process.env.NOMBRE_SALA || "Sala 1", MAX_JUGADORES_SALA: 15,
    LIVE_STATS_INTERVALO_MS: 60000, LLAMARADMIN_COOLDOWN_MS: 60000,
    DISCORD_INVITE: "https://discord.gg/wSmWkKQ7u3",

    VERIFICACION_CANAL: "#verificacion-hax", VERIFICACION_EXPIRA_MS: 900000,
    VERIFICACION_RECOMPENSA_MONEDAS: 200,
    VERIFICACION_HTTP_PUERTO: process.env.VERIFICACION_HTTP_PUERTO || 8788,
    VERIFICACION_HTTP_SECRETO: process.env.VERIFICACION_HTTP_SECRETO,

    BAN_DIAS_NORMAL: 3, BAN_DIAS_LOW: 1, WARN_MAX: 3,
    VOTEKICK_MIN_VOTOS: 20, VOTEKICK_DURACION_MS: 1800000, VOTEMUTE_DURACION_MS: 1800000,
    BACKUP_INTERVAL_MS: 1800000, BACKUPS_A_CONSERVAR: 20,
    MISION_GOLES_OBJETIVO: 3, MISION_RECOMPENSA_MONEDAS: 100, MISION_RECOMPENSA_XP: 75,
    MISION_SEMANAL_PARTIDOS_OBJETIVO: 10, MISION_SEMANAL_RECOMPENSA_MONEDAS: 400, MISION_SEMANAL_RECOMPENSA_XP: 200,
    MAX_MONEDA: 750, MAX_BLACKJACK: 500,
    CLAN_CREAR_COSTO: 300, CLAN_MAX_MIEMBROS: 8, CLAN_XP_POR_VICTORIA: 15, CLAN_XP_BASE_NIVEL: 200,
    STREAK_BONUS_MONEDAS: 25, STREAK_BONUS_MAX_DIAS: 10,
    CMD_COOLDOWN_MS: 300, CLAN_INVITACION_TTL_MS: 300000,
    RULETA_VERDE_PAYOUT: 33, RULETA_ROJO_NEGRO_PAYOUT: 2,
};

Object.assign(CONFIG, ROOM_CONFIG.CONFIG_OVERRIDES || {});
console.log("CONFIG FINAL:", CONFIG.NOMBRE_SALA, CONFIG.MAX_JUGADORES_SALA);
const ROOM_ID = ROOM_CONFIG.ROOM_ID || "HA";
if (!CONFIG.OWNER_AUTH) console.warn("⚠️ OWNER_AUTH no seteado — esOwner() depende solo del nombre.");

const TIENDA_ITEMS = {
    escudo_mmr: { nombre: "🛡️ Escudo Anti-ELO", precio: 500, desc: "Tu próximo partido no suma ni resta ELO", categoria: "Boost" },
    titulo_custom: { nombre: "🎨 Título Custom", precio: 1000, desc: "Creá tu propio título (!tienda comprar titulo_custom [texto])", categoria: "Cosmético" },
    revivir_racha: { nombre: "🔥 Revivir Racha", precio: 200, desc: "Recuperás tu mejor racha al instante", categoria: "Boost" },
    boost_xp: { nombre: "⚡ Boost XP x2", precio: 400, desc: "Doble XP en tu próximo partido", categoria: "Boost" },
    festejo_fuego: { nombre: "🔥 Festejo VIP", precio: 250, desc: "Estela de fuego + súper velocidad en tu próximo gol", categoria: "Cosmético" }
};
const TITULOS_EXCLUSIVOS = {
    rey_cancha: { nombre: "👑 El Rey de la Cancha", precio: 5000, color: 0xFFD700 },
    goat: { nombre: "🐐 El GOAT", precio: 7500, color: 0x00FFFF },
    intocable: { nombre: "🛡️ El Intocable", precio: 6000, color: 0xFF3366 }
};
const TITULOS = {
    bronce1: { nombre: "🥉 Bronce I", color: 0xCD7F32, req: 0 }, bronce2: { nombre: "🥉 Bronce II", color: 0xCD7F32, req: 900 },
    plata1: { nombre: "🥈 Plata I", color: 0xC0C0C0, req: 1000 }, plata2: { nombre: "🥈 Plata II", color: 0xC0C0C0, req: 1060 },
    oro1: { nombre: "🥇 Oro I", color: 0xFFD700, req: 1120 }, oro2: { nombre: "🥇 Oro II", color: 0xFFD700, req: 1180 },
    platino1: { nombre: "💎 Platino I", color: 0x87CEEB, req: 1250 }, platino2: { nombre: "💎 Platino II", color: 0x87CEEB, req: 1320 },
    diamante1: { nombre: "🔷 Diamante I", color: 0x1E90FF, req: 1400 }, diamante2: { nombre: "🔷 Diamante II", color: 0x1E90FF, req: 1480 },
    maestro: { nombre: "👑 Maestro", color: 0x9400D3, req: 1570 }, gran_maestro: { nombre: "👑 Gran Maestro", color: 0x6A0DAD, req: 1680 },
    leyenda: { nombre: "🌟 Leyenda", color: 0xFF4500, req: 1800 },
};
const BADGES = {
    primer_gol: "⚽", goleador_10: "🎯", goleador_50: "⚡", goleador_100: "💥", asistencia_10: "🎁", asistencia_50: "🎀", asistencia_100: "🎗️",
    hat_trick: "🎩", poker: "🃏", mvp_5: "🌟", mvp_20: "✨", portero_muro: "🧱", racha_5: "🔥", racha_10: "💥",
    atajador_10: "🧤", atajador_50: "🥅", veterano_50: "⭐", veterano_100: "🏛️", anti_ragequit: "🚪", fair_play: "🤝",
    campeon: "🏆", powershot_king: "👑", clan_leader: "⚔️", nivel_10: "🎖️", nivel_25: "🏅", streak_7: "📅", streak_30: "🗓️",
    duelista: "⚔️", apostador: "🎰", gol_distancia: "🌍", gol_misilazo: "🚀", atajada_powershot: "🥅🔥",
    heroe_1v3: "⚔️✨", gol_relampago: "⏱️", remontada: "😈", gol_agonico: "💓", arquero_heroe: "🛡️", doblete_veloz: "⚡⚡",
};
const BADGE_NOMBRES = {
    primer_gol: "Primer gol", goleador_10: "10 goles", goleador_50: "50 goles", goleador_100: "100 goles",
    asistencia_10: "10 asistencias", asistencia_50: "50 asistencias", asistencia_100: "100 asistencias",
    hat_trick: "Hat-trick", poker: "Póker de goles", mvp_5: "5 veces MVP", mvp_20: "20 veces MVP",
    portero_muro: "Muro invicto", racha_5: "5 victorias seguidas", racha_10: "10 victorias seguidas",
    atajador_10: "10 atajadas", atajador_50: "50 atajadas", veterano_50: "50 partidos", veterano_100: "100 partidos",
    anti_ragequit: "Nunca abandonó", fair_play: "Fair play", campeon: "Campeón", powershot_king: "Rey del powershot",
    clan_leader: "Líder de clan", nivel_10: "Nivel 10", nivel_25: "Nivel 25", streak_7: "7 días seguidos",
    streak_30: "30 días seguidos", duelista: "Duelista", apostador: "Apostador", gol_distancia: "Gol desde lejos",
    gol_misilazo: "Misilazo", atajada_powershot: "Atajó un powershot", heroe_1v3: "Héroe 1 vs 3", gol_relampago: "Gol relámpago",
    remontada: "Remontada", gol_agonico: "Gol agónico", arquero_heroe: "Arquero héroe", doblete_veloz: "Doblete veloz",
};
const CAMISETAS = [
    { name: "BELLA VISTA", angle: 140, colors: [0x000000, 0xFFFFFF, 0x22800B, 0xFFFFFF] },
    { name: "TIRO FEDERAL", angle: 0, colors: [0x000000, 0x730FBF, 0xF7FF0A, 0x7B10CC] },
    { name: "VM", angle: 0, colors: [0x191919, 0x23700B, 0xFFFFFF, 0x000000] },
    { name: "OLIMPO", angle: 0, colors: [0xFFFFFF, 0x000000, 0xD4DB14, 0x000000] },
    { name: "PUERTO COMERCIAL", angle: 0, colors: [0x000000, 0x32A110, 0xC5CC13, 0x32A110] },
    { name: "LIBERTAD", angle: 0, colors: [0x000000, 0x0A4BA1, 0xFFFFFF, 0x0A4BA1] },
    { name: "ROSARIO PUERTO BELGRANO", angle: 0, colors: [0xFCFCFC, 0x0A4BA1, 0xFF0F0F, 0x0A4BA1] },
    { name: "SPORTING", angle: 0, colors: [0xFCFCFC, 0x000000, 0xFF0F0F] },
    { name: "SANSINENA", angle: 0, colors: [0x000000, 0xFFFFFF, 0xFF0F0F, 0xFFFFFF] },
    { name: "HURACAN", angle: 0, colors: [0xFF1717, 0xFFFFFF, 0xFFFFFF, 0xFFFFFF] },
    { name: "SAN FRANCISCO", angle: 0, colors: [0xFFFFFF, 0x0ABEFF] },
    { name: "LINIERS", angle: 0, colors: [0x242424, 0xFFFFFF, 0x000000, 0xFFFFFF] },
    { name: "LA ARMONIA", angle: 60, colors: [0x000000, 0xFFFFFF, 0x0558FF, 0xFFFFFF] },
    { name: "PACIFICO", angle: 60, colors: [0xFFFFFF, 0x063803] },
    { name: "DUBLIN", angle: 60, colors: [0xFFFFFF, 0xFF1212] },
    { name: "JUVENTUD UNIDA", angle: 60, colors: [0x000000, 0xFFFFFF, 0xFF0000, 0xFFFFFF] },
    { name: "PACIFICO DE CABILDO", angle: 60, colors: [0xFFFFFF, 0x098C00] }
];
const ANUNCIOS = [
    "💡 ¿Sos nuevo? Escribí !tutorial y arrancás en un toque", "🛒 Tenés monedas juntadas, revisá la !tienda",
    "⚔️ ¿Te la creés? Retá a alguien con !duelo [jugador] [cantidad]", "👑 !tienda exclusivo tiene títulos únicos",
    "🎰 !ruleta [cantidad] para probar tu suerte", "🚷 !expulsar [ID] arranca una votación",
    "💤 !afk si te vas a alejar un rato", "🎮 t [mensaje] para hablar solo con tu equipo",
    "📨 @@[nombre] [mensaje] para un privado", "⚔️ !clan crear [nombre] y fundá tu propio clan",
    "🎯 !misiones te muestra el objetivo del día", "📜 !records para revisar el Salón de la Fama",
    "🪙 !moneda [cantidad], probá el casino", "🎁 !enviar [jugador] [cantidad] para compartir",
    "⚔️ c [mensaje] para hablar solo con tu clan", "🧤 !gk te reserva como arquero",
];
const ANUNCIOS_DISCORD = [
    `${EMOJIS.checkered} Unite a nuestro Discord: ${CONFIG.DISCORD_INVITE}`,
    `🔗 Verificá tu cuenta: !verificacion y entrá al canal #verificacion-hax`,
];
const TIPS_SALA = [
    "💡 Al final del partido se elige MVP automáticamente.", "💡 Hay logros secretos. Mirá los tuyos con !perfil",
    "💡 Terminás un partido y puede caerte una caja.", "💡 Armá tu clan con !clan.",
    "💡 Atajá un powershot y desbloqueás un logro.", "💡 !top para ver los rankings.",
    "💡 Tu nombre queda tuyo para siempre.", "💡 !perfil te muestra tus stats.",
    "💡 Ganá un 1 vs 3 y te llevás un logro secreto.", "💡 Gastá las monedas en !tienda",
];
const FRASES_GOL_TITULOS = [
    `${EMOJIS.soccer} ${EMOJIS.sparkles} GOOOL!`, `${EMOJIS.soccer} ${EMOJIS.fire} GOLAZO!`, "🥅 ¡A LA RED!", "🎯 ¡DEFINICIÓN PERFECTA!", "💥 ¡MISIL AL ARCO!",
    "🚀 ¡IMPOSIBLE PARA EL ARQUERO!", "🔥 ¡QUÉ GOL!", "🌟 ¡BRILLANTE DEFINICIÓN!", "🎉 ¡SE ABRE EL MARCADOR!",
    "⚡ ¡NO PERDONÓ!", "💣 ¡BOMBAZO!", "🎊 ¡EL ESTADIO EXPLOTA!", "🏆 ¡OTRO MÁS PARA LA CUENTA!", "📣 ¡GRÍTALO!",
    "💫 ¡OBRA DE ARTE!", "🐐 ¡GRAN DEFINICIÓN!", "🧉 ¡GOLAZO DE CALIDAD!", "🔥 ¡QUÉ ZURDAZO!",
    "🎆 ¡SE PRENDIÓ FUEGO LA CANCHA!", "🥶 ¡FRÍO, MUY FRÍO PARA EL ARQUERO!",
];
const FRASES_ARRANQUE_PARTIDO = ["🏟️ Comienza el partido", `${EMOJIS.soccer} Kickoff`, "🏁 Arrancamos", "🎬 Rodando la pelota", "🔥 En marcha"];
const MAPAS_BASE = { entrenamiento: `{"name":"Entrenamiento","width":865,"height":450,"bg":{"type":"grass","color":"434343"},"vertexes":[{"x":-417,"y":-225,"bCoef":0.5},{"x":417,"y":-225,"bCoef":0.5},{"x":417,"y":225,"bCoef":0.5},{"x":-417,"y":225,"bCoef":0.5}],"segments":[{"v0":0,"v1":1,"color":"555555"},{"v0":1,"v1":2,"color":"555555"},{"v0":2,"v1":3,"color":"555555"},{"v0":3,"v1":0,"color":"555555"}],"goals":[{"p0":[-417,-70],"p1":[-417,70],"team":"red"},{"p0":[417,-70],"p1":[417,70],"team":"blue"}]}` };
const MAPAS = { ...MAPAS_BASE, ...require("./mapas") };

const STATE = {
    room: null, baseDatos: {}, records: {}, campeones: [], clanes: {}, authRegistrados: {}, TEMPORADA_ACTUAL: 1,
    partidoEnCurso: false, inicioPartido: 0, ultimoMarcadorConocido: null,
    matchStats: {}, toquesRecientes: [], liveStatsMessageId: null, liveStatsTimer: null, historialTimer: null,
    powershotActivado: false, powershotID: 0, powershotTrigger: false, powershotCounter: 0, powershotChargeStartTime: null,
    powershotKickLockId: null, powershotKickLockTs: 0,
    curvaActivado: false, curvaEnCurso: null,
    festejosVipActivos: {}, salidasVoluntarias: new Set(), powershotBallDefaults: null,
    rainbowEquipoActivo: null,          // { team, hueTick, startTs, colorOriginal }
    jueganTodosActivo: false, maxPlayersPerTeam: 2, automatizadoActivado: CONFIG.AUTOMATED_MODE_DEFAULT,
    configuracionActual: null, bracketFijo: null, limitesCancha: null, cambioMapaPendiente: null,
    verificacionesPendientes: {}, votaciones: { expulsar: null }, votos: { expulsar: {} }, votacionTokenSeq: 0,
    afkPlayers: new Set(), playerPositions: {}, playerLastMove: {}, afkDesde: {}, afkAvisado30s: new Set(),
    afkCooldown: new Map(),       // key -> ts hasta el cual no puede !jugar
    ultimoToggleAfk: {},          // id -> ts del último !afk (anti-teletransporte)
    ultimoJugar: {},
    mutesTemporales: [], bansTemporales: [], mensajesRecientes: {},
    apuestas: {}, duelosActivos: [], reportes: [], ultimoLlamadoAdmin: 0, titulosExclusivos: {},
    blackjackActivo: {}, fairPlayActivo: true, ganaSigueActivo: false, golDeOroActivo: false,
    equipoRojoPosesion: 0, equipoAzulPosesion: 0,
    ArqueroRED: null, ArqueroBLUE: null, anuncioIndex: 0, anuncioDiscordIndex: 0, isDirty: false,
    dirtyPlayers: new Set(), fullDiffPendiente: false,
    caches: { titulos: new Map(), badges: new Map(), timestamps: new Map() },
    clanInvitaciones: {}, gkReservado: { 1: null, 2: null }, gkUltimoWarn: {},
    zonaArcoDesde: {}, zonaArcoUltimoAviso: {}, capitanes: { 1: null, 2: null },
    nombresReservados: new Map(), adminsAutomaticos: new Set(), abandonos: new Map(),
    authPorId: new Map(), connPorId: new Map(), radioJugadorCache: new Map(), rivalidadDelPartido: null,
    animacionGolTokenPorId: new Map(), animacionGolActiva: new Set(), animacionGolIntervalos: new Map(),
    BOT_ID: 0, tiroPeligroso: null, eventoGolX2Activo: false, eventoTimer: null,
    vipBallColorTimeout: null, colorPelotaDefault: null, tipIndex: -1, cooldownsCmd: new Map(),
    ultimoEquipoInicial: 1,
    siguienteIdPermanente: 1,
};

const RETRY_QUEUE = [];
function encolarReintento(fn, descripcion = "op", intentosMax = 3) { RETRY_QUEUE.push({ fn, descripcion, intentos: 0, intentosMax, ts: 0 }); }

let ultimoColorPelotaEnviado = null;
function setColorPelota(color) {
    if (color === ultimoColorPelotaEnviado) return;
    ultimoColorPelotaEnviado = color;
    // Si es un hex string (gradientes/efectos) va con 0x prefijo.
    // Si es el valor crudo del engine (ej. -1 = color nativo), se manda tal cual.
    const val = typeof color === "string" ? `0x${color}` : color;
    safeOperation(() => STATE.room.setDiscProperties(0, { color: val }));
}
function cuantizarTickColor(tick) { return Math.floor(tick / 2) * 2; }
function sendAnnouncement(text, targetId, color, style, sound) {
    if (!STATE.room) return;
    try { STATE.room.sendAnnouncement(text, targetId, color, style, sound); } catch (e) { }
}
let mapaCache = { str: null, parsed: null };
function getMapaParseado() {
    const str = STATE.configuracionActual?.mapa || null;
    if (str !== mapaCache.str) { let p = null; try { p = str ? JSON.parse(str) : null; } catch (e) { } mapaCache = { str, parsed: p }; }
    return mapaCache.parsed;
}
function getAnchoCancha() { return getMapaParseado()?.width || 800; }
function computarLimitesCancha(mapaStr) {
    if (!mapaStr) return null;
    try {
        const mapa = JSON.parse(mapaStr);
        const vs = Array.isArray(mapa.vertexes) ? mapa.vertexes : [];
        let maxX = 0, maxY = 0;
        for (const v of vs) { if (typeof v.x === "number") maxX = Math.max(maxX, Math.abs(v.x)); if (typeof v.y === "number") maxY = Math.max(maxY, Math.abs(v.y)); }
        if (maxX === 0 && mapa.width) maxX = mapa.width / 2;
        if (maxY === 0 && mapa.height) maxY = mapa.height / 2;
        if (maxX === 0 || maxY === 0) return null;
        let goalMaxY = 0;
        for (const g of (Array.isArray(mapa.goals) ? mapa.goals : [])) for (const p of [g?.p0, g?.p1]) if (Array.isArray(p) && typeof p[1] === "number") goalMaxY = Math.max(goalMaxY, Math.abs(p[1]));
        return { maxX, maxY, goalMaxY };
    } catch (e) { return null; }
}
function getLimitesCancha() { if (STATE.limitesCancha) return STATE.limitesCancha; STATE.limitesCancha = computarLimitesCancha(STATE.configuracionActual?.mapa); return STATE.limitesCancha; }
const MARGEN_SEGURIDAD_MURO = 25;
function mantenerPelotaEnCancha(ballPosition) {
    if (!STATE.partidoEnCurso || !ballPosition) return;
    const lim = getLimitesCancha(); if (!lim) return;
    const limX = lim.maxX + MARGEN_SEGURIDAD_MURO, limY = lim.maxY + MARGEN_SEGURIDAD_MURO;
    const enBoca = lim.goalMaxY > 0 && Math.abs(ballPosition.y) < lim.goalMaxY;
    const fueraX = !enBoca && Math.abs(ballPosition.x) > limX;
    const fueraY = Math.abs(ballPosition.y) > limY;
    if (!fueraX && !fueraY) return;
    const props = safeOperation(() => STATE.room.getDiscProperties(0)); if (!props) return;
    const nx = fueraX ? Math.sign(ballPosition.x) * limX * 0.9 : ballPosition.x;
    const ny = fueraY ? Math.sign(ballPosition.y) * limY * 0.9 : ballPosition.y;
    safeOperation(() => STATE.room.setDiscProperties(0, { x: nx, y: ny, xspeed: fueraX ? -props.xspeed * 0.8 : props.xspeed * 0.95, yspeed: fueraY ? -props.yspeed * 0.8 : props.yspeed * 0.95 }));
    // Usar finalizarCurva() en vez de null manual: garantiza que el color
    // se restaure al valor base del mapa incluso si ultimoColorPelotaEnviado
    // quedó desincronizado por un powershot previo.
    if (STATE.curvaEnCurso) finalizarCurva();
    logMsg('errors.log', `[${ROOM_ID}] Pelota fuera corregida en (${ballPosition.x.toFixed(0)}, ${ballPosition.y.toFixed(0)})`);
}
function msgBox(t, l, c = COLORES.blanco, s = "small", so = 2, ti = null) { sendAnnouncement([`${t}`, "─────────────", ...l].join("\n"), ti, c, s, so); }
function anchoVisual(t) { let a = 0; for (const ch of Array.from(t)) a += ch.codePointAt(0) >= 0x1100 ? 2 : 1; return a; }
function msgCaja(t, l, c = COLORES.blanco, s = "small-bold", so = 1, ti = null) {
    const am = Math.max(anchoVisual(t), ...l.map(anchoVisual));
    const ab = Math.min(64, Math.max(20, am));
    const B = "─".repeat(ab);
    sendAnnouncement([`┌${B}┐`, t, `├${B}┤`, ...l, `└${B}┘`].join("\n"), ti, c, s, so);
}
function msgSmall(t, ti = null, c = COLORES.blanco, s = "small", so = 0) { sendAnnouncement(`✦ ${t}`, ti, c, s, so); }
function msgMini(t, ti = null, c = COLORES.blanco, so = 0) { sendAnnouncement(t, ti, c, "small", so); }
function msgArrow(t, l, ti = null, c = COLORES.blanco, so = 1) { sendAnnouncement(`${t}\n   ╰→ ${l}`, ti, c, "small-bold", so); }
function anunciarGol(t, team, gn, an, vk, sc, fl = null) {
    const mt = sc ? `${sc.red}-${sc.blue}` : "";
    const tt = sc ? `[${formatTime(sc.time)}] ` : "";
    const d = [an ? `asistió ${an}` : null, vk !== null ? `${vk.toFixed(0)} km/h` : null, fl].filter(Boolean).join(" · ");
    const ls = [`${tt}${t} ${gn} · ${mt}`]; if (d) ls.push(`↳ ${d}`);
    sendAnnouncement(ls.join("\n"), null, team === 1 ? COLORES.equipo_rojo : COLORES.equipo_azul, "bold", 2);
}
function msgError(t, ti = null) { sendAnnouncement(`❌ ${t}`, ti, COLORES.error, "small", 0); }
function msgSuccess(t, ti = null) { sendAnnouncement(`✅ ${t}`, ti, COLORES.exito, "small", 1); }
function msgWarn(t, ti = null) { sendAnnouncement(`⚠️ ${t}`, ti, COLORES.advertencia, "small", 0); }
function msgInfo(t, ti = null) { sendAnnouncement(`💡 ${t}`, ti, COLORES.info, "small", 0); }
function msgGame(t, ti = null, c = COLORES.blanco, so = 1) { sendAnnouncement(`⚽ ${t}`, ti, c, "small", so); }
function footerRanking() { return `📊 Sobre ${Object.keys(STATE.baseDatos).length} jugadores`; }
function validarCantidad(c, min = 0, max = Infinity) { return !isNaN(c) && c >= min && c <= max; }
    try { return op(); } catch (e) { logMsg('errors.log', `[${ROOM_ID}] SafeOp: ${e.message}`); return fb; }function limpiarCache() {
    const now = Date.now();
    for (const [k, ts] of STATE.caches.timestamps.entries()) if (now - ts > CONFIG.CACHE_TTL) { STATE.caches.titulos.delete(k); STATE.caches.badges.delete(k); STATE.caches.timestamps.delete(k); }
}
function getPlayerKey(p) {
    const a = STATE.authPorId.get(p.id); if (a) return a;
    if (p.auth) return p.auth;
    const c = STATE.connPorId.get(p.id); if (c) return `anon_conn_${c}`;
    if (p.conn) return `anon_conn_${p.conn}`;
    return `anon_${p.name.toLowerCase().trim().replace(/\s+/g, "_")}`;
}
function esKeyAnonima(k) { return typeof k === "string" && k.startsWith("anon_"); }
function esOwner(p) {
    if (CONFIG.OWNER_AUTH && p?.auth) return p.auth === CONFIG.OWNER_AUTH;
    return !!p?.name && p.name.trim().toLowerCase() === CONFIG.OWNER_NAME.toLowerCase();
}
function enCooldown(k, cmd) {
    const kk = `${k}:${cmd}`, ahora = Date.now();
    const e = STATE.cooldownsCmd.get(kk) || 0;
    if (e > ahora) return true;
    STATE.cooldownsCmd.set(kk, ahora + CONFIG.CMD_COOLDOWN_MS); return false;
}
function discordCBAbierto() { return Date.now() < DISCORD_CB.abiertoHasta; }
function discordCBFallo() { DISCORD_CB.fallos++; if (DISCORD_CB.fallos >= DISCORD_CB.UMBRAL) { DISCORD_CB.abiertoHasta = Date.now() + DISCORD_CB.COOLDOWN_MS; DISCORD_CB.fallos = 0; logMsg('errors.log', `[${ROOM_ID}] CB Discord abierto ${DISCORD_CB.COOLDOWN_MS/1000}s`); } }
function discordCBExito() { DISCORD_CB.fallos = 0; }
function auditLog(actor, accion, target, detalles = "") { logMsg('audit.log', `[${ROOM_ID}] ${actor?.name || "?"} → ${accion} → ${target || "—"}${detalles ? ` (${detalles})` : ""}`); }

async function pollGlobalSync() {
    try {
        const { bans, nombres } = await fetchGlobalSyncData();
        for (const r of nombres) if (!STATE.nombresReservados.has(r.nombre)) STATE.nombresReservados.set(r.nombre, r.owner_key);
        for (const r of bans) {
            const l = STATE.baseDatos[r.key]; if (!l) continue;
            const bh = Number(r.ban_hasta) || 0;
            let c = false;
            if (bh !== (l.ban_hasta || 0)) { l.ban_hasta = bh; c = true; }
            if (!!r.blacklisted !== !!l.blacklisted) { l.blacklisted = !!r.blacklisted; c = true; }
            if (!c) continue;
            markDirty(r.key);
            if (!STATE.room) continue;
            const on = STATE.room.getPlayerList().find(p => getPlayerKey(p) === r.key);
            if (!on || esOwner(on)) continue;
            if (l.blacklisted) STATE.room.kickPlayer(on.id, "🚫 Lista negra", false);
            else if (l.ban_hasta && Date.now() < l.ban_hasta) STATE.room.kickPlayer(on.id, `⛔ Te banearon en la otra sala`, false);
        }
    } catch (e) { logMsg('errors.log', `[${ROOM_ID}] Error pollGlobalSync: ${e.message}`); }
}
async function pollGlobalesJugadores() {
    try {
        const rows = await fetchPlayerGlobals();
        for (const r of rows) {
            const l = STATE.baseDatos[r.key]; if (!l) continue;
            let c = false;
            const br = r.badges || [];
            if (br.some(b => !l.badges?.includes(b))) { l.badges = Array.from(new Set([...(l.badges || []), ...br])); c = true; }
            const vv = !!r.vip && (!r.vip_expira || Date.now() < Number(r.vip_expira));
            if (vv && !l.vip) { l.vip = true; c = true; }
            if (r.vip_tortu && !l.vip_tortu) { l.vip_tortu = true; c = true; }
            if (r.vip_perma && !l.vip_perma) { l.vip_perma = true; c = true; }
            const ve = Number(r.vip_expira) || 0;
            if (ve > (l.vip_expira || 0) && ve > Date.now()) { l.vip_expira = ve; c = true; }
            if (r.discord_verificado && !l.discord_verificado) { l.discord_verificado = true; l.discord_id = l.discord_id || r.discord_id || null; l.discord_tag = l.discord_tag || r.discord_tag || null; c = true; }
            if (r.clan && !l.clan && STATE.clanes[r.clan]) { l.clan = r.clan; c = true; }
            if (c) markDirty(r.key);
        }
    } catch (e) { logMsg('errors.log', `[${ROOM_ID}] Error pollGlobalesJugadores: ${e.message}`); }
}
function findPlayerKeyByName(name) {
    const t = name.toLowerCase().trim();
    const ent = Object.entries(STATE.baseDatos);
    const ex = ent.find(([k, s]) => s.nombre_actual.toLowerCase() === t || k === t);
    if (ex) return ex[0];
    const par = ent.filter(([, s]) => s.nombre_actual.toLowerCase().includes(t));
    return par.length === 1 ? par[0][0] : null;
}
function findOnlinePlayer(name) {
    const t = name.toLowerCase().trim();
    const ps = STATE.room.getPlayerList();
    const pi = ps.find(x => x.id.toString() === t); if (pi) return pi;
    const ex = ps.filter(x => x.name.toLowerCase() === t); if (ex.length === 1) return ex[0];
    const par = ps.filter(x => x.name.toLowerCase().includes(t)); return par.length === 1 ? par[0] : null;
}
function resolverJugadorYResto(args) {
    if (args.length && /^#\d+$/.test(args[0])) {
        const id = parseInt(args[0].slice(1), 10);
        const e = Object.entries(STATE.baseDatos).find(([, s]) => s.id_permanente === id);
        if (e) { const [key] = e; const target = STATE.room.getPlayerList().find(p => getPlayerKey(p) === key) || null; return { target, key, resto: args.slice(1) }; }
    }
    for (let i = args.length; i >= 1; i--) {
        const pn = args.slice(0, i).join(" ");
        const t = findOnlinePlayer(pn); if (t) return { target: t, key: getPlayerKey(t), resto: args.slice(i) };
        const k = findPlayerKeyByName(pn); if (k) return { target: null, key: k, resto: args.slice(i) };
    }
    return { target: null, key: null, resto: args };
}
function tierVipDe(s) { return CONFIG.VIP_TIERS[s?.vip_tier] || CONFIG.VIP_TIERS.vip; }
function pointDistance(a, b) { return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2); }
function interpolarColorHex(ini, fin, prog) {
    const p = Math.max(0, Math.min(1, prog));
    const a = parseInt(ini, 16), b = parseInt(fin, 16);
    const r = Math.round(((a >> 16) & 0xFF) + (((b >> 16) & 0xFF) - ((a >> 16) & 0xFF)) * p);
    const g = Math.round(((a >> 8) & 0xFF) + (((b >> 8) & 0xFF) - ((a >> 8) & 0xFF)) * p);
    const bl = Math.round((a & 0xFF) + ((b & 0xFF) - (a & 0xFF)) * p);
    return ((r << 16) | (g << 8) | bl).toString(16).padStart(6, "0").toUpperCase();
}
function textoContrasteCamiseta(c) {
    const r = (c >> 16) & 0xFF, g = (c >> 8) & 0xFF, b = c & 0xFF;
    return ((0.299 * r + 0.587 * g + 0.114 * b) / 255) > 0.6 ? 0x000000 : 0xFFFFFF;
}
function hueAHex(hue) {
    const h = ((hue % 360) + 360) % 360;
    const c = 255, x = Math.round((1 - Math.abs((h / 60) % 2 - 1)) * 255);
    let r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; b = 0; } else if (h < 120) { r = x; g = c; b = 0; }
    else if (h < 180) { r = 0; g = c; b = x; } else if (h < 240) { r = 0; g = x; b = c; }
    else if (h < 300) { r = x; g = 0; b = c; } else { r = c; g = 0; b = x; }
    return ((r << 16) | (g << 8) | b).toString(16).padStart(6, "0").toUpperCase();
}
function barridoPaleta(tick, paleta, vel) { const n = paleta.length; const pos = ((tick * vel) % n + n) % n; const i = Math.floor(pos), f = pos - i; return interpolarColorHex(paleta[i], paleta[(i + 1) % n], f); }
function gradientePowershotNormal(t, team) { return barridoPaleta(t, team === 1 ? CONFIG.POWERSHOT_NORMAL_PALETA_ROJO : CONFIG.POWERSHOT_NORMAL_PALETA_AZUL, CONFIG.POWERSHOT_NORMAL_GRADIENT_SPEED); }
function gradienteVipTier(t, tier) {
    const p = (tier?.paleta && tier.paleta.length >= 2) ? tier.paleta : [tier?.gradA || CONFIG.POWERSHOT_VIP_COLOR_A, tier?.gradB || CONFIG.POWERSHOT_VIP_COLOR_B];
    return barridoPaleta(t, p, tier?.gradSpeed || CONFIG.POWERSHOT_VIP_GRADIENT_SPEED);
}
function colorPelotaAHex(c) {
    if (typeof c === "string") { const l = c.replace(/^0x/i, ""); return /^[0-9A-Fa-f]{6}$/.test(l) ? l.toUpperCase() : CONFIG.POWERSHOT_COLOR_INICIAL; }
    if (typeof c === "number" && c >= 0) return (c & 0xFFFFFF).toString(16).padStart(6, "0").toUpperCase();
    return CONFIG.POWERSHOT_COLOR_INICIAL;
}
function shuffleArray(arr) { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function formatTime(s) { const m = Math.floor(s / 60), sec = Math.floor(s % 60); return `${m}:${sec.toString().padStart(2, '0')}`; }
function parseDuracion(t) { if (!t) return null; const m = String(t).match(/^(\d+)(s|m|h)?$/i); if (!m) return null; const c = parseInt(m[1]), u = (m[2] || "m").toLowerCase(); if (u === "s") return c * 1000; if (u === "h") return c * 3600000; return c * 60000; }
function formatDuracion(ms) { if (ms >= 3600000) return `${Math.round(ms / 3600000)}h`; if (ms >= 60000) return `${Math.round(ms / 60000)}min`; return `${Math.round(ms / 1000)}s`; }
function markDirty(k = null) { STATE.isDirty = true; if (k) STATE.dirtyPlayers.add(k); else STATE.fullDiffPendiente = true; }

async function upsertPlayerGlobalsBatch(entries, roomId = null) {
    if (!entries.length) return;
    const client = await getGlobalPool().connect();
    try {
        await client.query(
            `INSERT INTO player_globals (key, monedas, badges, vip, vip_tortu, vip_perma, vip_expira, vip_tier, discord_verificado, discord_id, discord_tag, clan, room_id, updated_at)
             SELECT * FROM UNNEST($1::text[], $2::bigint[], $3::jsonb[], $4::bool[], $5::bool[], $6::bool[], $7::bigint[], $8::text[], $9::bool[], $10::text[], $11::text[], $12::text[], $13::text[], $14::timestamptz[])
             ON CONFLICT (key) DO UPDATE SET
                monedas = EXCLUDED.monedas, badges = EXCLUDED.badges, vip = EXCLUDED.vip, vip_tortu = EXCLUDED.vip_tortu,
                vip_perma = EXCLUDED.vip_perma, vip_expira = EXCLUDED.vip_expira, vip_tier = EXCLUDED.vip_tier,
                discord_verificado = EXCLUDED.discord_verificado, discord_id = EXCLUDED.discord_id, discord_tag = EXCLUDED.discord_tag,
                clan = EXCLUDED.clan, room_id = COALESCE(EXCLUDED.room_id, player_globals.room_id), updated_at = EXCLUDED.updated_at;`,
            [entries.map(e => e.key), entries.map(e => Math.max(0, Math.floor(e.monedas))), entries.map(e => JSON.stringify(e.badges || [])),
             entries.map(e => !!e.vip), entries.map(e => !!e.vip_tortu), entries.map(e => !!e.vip_perma), entries.map(e => e.vip_expira || null),
             entries.map(e => e.vip_tier || "vip"), entries.map(e => !!e.discord_verificado), entries.map(e => e.discord_id || null),
             entries.map(e => e.discord_tag || null), entries.map(e => e.clan || null), entries.map(() => roomId), entries.map(() => new Date())]
        );
    } finally { client.release(); }
}
async function saveDatabase() {
    const kA = STATE.fullDiffPendiente ? Object.keys(STATE.baseDatos) : Array.from(STATE.dirtyPlayers || []);
    const r = await saveDatabaseToPg(STATE, ROOM_ID);
    const kD = Array.from(STATE.dirtyPlayers || []);
    const keys = Array.from(new Set([...kA, ...kD]));
    const entries = [];
    for (const k of keys) { const s = STATE.baseDatos[k]; if (!s) continue; entries.push({ key: k, monedas: s.monedas || 0, badges: s.badges || [], vip: !!s.vip, vip_tortu: !!s.vip_tortu, vip_perma: !!s.vip_perma, vip_expira: s.vip_expira || null, vip_tier: s.vip_tier || "vip", discord_verificado: !!s.discord_verificado, discord_id: s.discord_id || null, discord_tag: s.discord_tag || null, clan: s.clan || null }); }
    if (entries.length) {
        try { await upsertPlayerGlobalsBatch(entries, ROOM_ID); }
        catch (e) { logMsg('errors.log', `[${ROOM_ID}] Error upsert batch: ${e.message}`); const snap = entries.map(e => ({ ...e })); encolarReintento(() => upsertPlayerGlobalsBatch(snap, ROOM_ID), `pg_globals[${snap.length}]`); }
    }
    saveClanesGlobal(STATE, ROOM_ID).catch(e => logMsg('errors.log', `[${ROOM_ID}] Error clanes: ${e.message}`));
    return r;
}
async function loadDatabase() { return loadDatabaseFromPg(STATE, ROOM_ID); }
function inicializarIdsPermanentes() {
    let max = 0;
    for (const s of Object.values(STATE.baseDatos)) if (typeof s.id_permanente === "number" && s.id_permanente > max) max = s.id_permanente;
    const sin = Object.entries(STATE.baseDatos).filter(([, s]) => typeof s.id_permanente !== "number").sort((a, b) => (a[1].primera_vez || 0) - (b[1].primera_vez || 0));
    for (const [k, s] of sin) { max++; s.id_permanente = max; markDirty(k); }
    STATE.siguienteIdPermanente = max + 1;
    if (sin.length) console.log(`🔢 ${sin.length} perfiles migrados`);
}
function limpiarBaseDatos() {
    const TD = 2592000000, ahora = Date.now(), keys = [];
    for (const [k, s] of Object.entries(STATE.baseDatos)) {
        const u = s.ultima_vez || s.primera_vez || ahora;
        if ((s.partidos || 0) < 3 && (ahora - u) > TD && (!s.campeonatos || !s.campeonatos.length)) { delete STATE.baseDatos[k]; keys.push(k); }
    }
    if (keys.length > 0) { console.log(`🧹 ${keys.length} cuentas eliminadas`); markDirty(); deletePlayersLocalBatch(keys); liberarReservasHuerfanas(Object.keys(STATE.baseDatos)).catch(e => logMsg('errors.log', `[${ROOM_ID}] Error liberando reservas: ${e.message}`)); }
}
const LOG_MAX_BYTES = 5 * 1024 * 1024;
async function logMsg(file, msg) {
    try {
        const fp = path.join(CONFIG.LOG_DIR, file);
        try { const st = await fs.stat(fp); if (st.size > LOG_MAX_BYTES) await fs.rename(fp, fp.replace(/\.log$/, ".old.log")); } catch (e) { }
        await fs.appendFile(fp, `[${new Date().toISOString()}] ${msg}\n`);
    } catch (e) { }
}
async function backupDatabase() {
    try { STATE.isDirty = true; await saveDatabase(); } catch (e) { }
    return backupDatabaseToPg(STATE, CONFIG.BACKUPS_A_CONSERVAR, ROOM_ID);
}
function getDiaString(ts) { return new Date(ts).toISOString().slice(0, 10); }
function actualizarRachaDiaria(player, s) {
    const hoy = getDiaString(Date.now());
    const ud = s.ultimo_login ? getDiaString(s.ultimo_login) : null;
    if (ud === hoy) return null;
    const ayer = getDiaString(Date.now() - 86400000);
    s.streak_dias = (ud === ayer) ? (s.streak_dias || 0) + 1 : 1;
    s.ultimo_login = Date.now();
    const b = Math.min(s.streak_dias, CONFIG.STREAK_BONUS_MAX_DIAS) * CONFIG.STREAK_BONUS_MONEDAS;
    s.monedas += b;
    const k = getPlayerKey(player);
    if (s.streak_dias === 7 && !s.badges.includes("streak_7")) darBadge(player, "streak_7");
    if (s.streak_dias === 30 && !s.badges.includes("streak_30")) darBadge(player, "streak_30");
    markDirty(k);
    return `📅🔥 Racha ${s.streak_dias} día(s) — +${b}💰`;
}
function actualizarMisionDiaria(s) { const h = getDiaString(Date.now()); if (!s.misiones || s.misiones.fecha !== h) s.misiones = { fecha: h, goles: 0, partidos: 0, completadas: [] }; }
function verificarMisionDiaria(player, s, g) {
    actualizarMisionDiaria(s); s.misiones.partidos++; s.misiones.goles += g;
    if (s.misiones.goles >= CONFIG.MISION_GOLES_OBJETIVO && !s.misiones.completadas.includes("goles_dia")) {
        s.misiones.completadas.push("goles_dia"); s.monedas += CONFIG.MISION_RECOMPENSA_MONEDAS;
        darXP(player, CONFIG.MISION_RECOMPENSA_XP);
        msgSmall(`🎯 Misión del día · +${CONFIG.MISION_RECOMPENSA_MONEDAS}💰 +${CONFIG.MISION_RECOMPENSA_XP}XP`, player.id, COLORES.oro, "small-bold", 1);
    }
    markDirty(getPlayerKey(player));
}
function getSemanaString(ts) {
    const d = new Date(ts); d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
    const ia = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return `${d.getUTCFullYear()}-W${Math.ceil((((d - ia) / 86400000) + 1) / 7)}`;
}
function actualizarMisionSemanal(s) { const sm = getSemanaString(Date.now()); if (!s.misionSemanal || s.misionSemanal.semana !== sm) s.misionSemanal = { semana: sm, partidos: 0, completada: false }; }
function verificarMisionSemanal(player, s) {
    actualizarMisionSemanal(s); s.misionSemanal.partidos++;
    if (s.misionSemanal.partidos >= CONFIG.MISION_SEMANAL_PARTIDOS_OBJETIVO && !s.misionSemanal.completada) {
        s.misionSemanal.completada = true; s.monedas += CONFIG.MISION_SEMANAL_RECOMPENSA_MONEDAS;
        darXP(player, CONFIG.MISION_SEMANAL_RECOMPENSA_XP);
        msgSmall(`🗓️🏅 Semana redonda +${CONFIG.MISION_SEMANAL_RECOMPENSA_MONEDAS}💰`, player.id, COLORES.oro, "small-bold", 1);
    }
    markDirty(getPlayerKey(player));
}
const JERARQUIA_RANGOS = ["normal", "mod", "modplus", "admin", "coowner", "owner"];
const PERMISOS_MOD = {
    mod: ["!vetar", "!vetamin", "!desvetar", "!callar", "!hablar", "!advertir"],
    modplus: ["!vetar", "!vetamin", "!desvetar", "!callar", "!hablar", "!advertir"],
    admin: ["!vetar", "!vetamin", "!desvetar", "!callar", "!hablar", "!advertir", "!desadv", "!listaneg"],
    coowner: ["!vetar", "!vetamin", "!desvetar", "!callar", "!hablar", "!advertir", "!desadv", "!listaneg", "!quitveto"],
};
function getRango(p) { if (esOwner(p)) return "owner"; return STATE.baseDatos[getPlayerKey(p)]?.rango || "normal"; }
function puedeUsar(p, cmd) { const r = getRango(p); if (r === "owner") return true; return (PERMISOS_MOD[r] || []).includes(cmd); }
function esStaff(p) { return getRango(p) !== "normal"; }
function esAdminEfectivo(p, isA) { if (isA) return true; return ["admin", "coowner", "owner"].includes(getRango(p)); }
function esProtegidoDeVoto(p) { if (esStaff(p)) return true; return !!STATE.baseDatos[getPlayerKey(p)]?.vip; }
function rangoDeKey(k) {
    const s = STATE.baseDatos[k]; if (!s) return "normal";
    if (CONFIG.OWNER_AUTH && s.auth === CONFIG.OWNER_AUTH) return "owner";
    if (s.nombre_actual && s.nombre_actual.trim().toLowerCase() === CONFIG.OWNER_NAME.toLowerCase()) return "owner";
    return s.rango || "normal";
}
function actorSuperaKey(actor, tk) { if (esOwner(actor)) return true; return JERARQUIA_RANGOS.indexOf(getRango(actor)) > JERARQUIA_RANGOS.indexOf(rangoDeKey(tk)); }

function enviarEventoBot(tipo, datos = {}) {
    return new Promise((resolve) => {
        if (discordCBAbierto()) { resolve(null); return; }
        try {
            const url = new URL(CONFIG.BOT_HTTP_URL);
            const body = JSON.stringify({ tipo, secreto: CONFIG.BOT_HTTP_SECRETO, sala: CONFIG.NOMBRE_SALA, roomId: ROOM_ID, ...datos });
            const lib = url.protocol === "https:" ? https : http;
            const req = lib.request({
                hostname: url.hostname, port: url.port || (url.protocol === "https:" ? 443 : 80),
                path: url.pathname, method: "POST", timeout: CONFIG.BOT_HTTP_TIMEOUT_MS,
                agent: url.protocol === "https:" ? HTTPS_AGENT : HTTP_AGENT,
                headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), "x-bot-secreto": CONFIG.BOT_HTTP_SECRETO },
            }, (res) => {
                let r = ""; res.on("data", c => r += c);
                res.on("end", () => {
                    if (res.statusCode >= 200 && res.statusCode < 300) { discordCBExito(); try { resolve(JSON.parse(r || "{}")); } catch { resolve({}); } }
                    else { discordCBFallo(); logMsg('errors.log', `[${ROOM_ID}] Discord ${res.statusCode} "${tipo}"`); resolve(null); }
                });
            });
            req.on("timeout", () => req.destroy(new Error("timeout")));
            req.on("error", (e) => { discordCBFallo(); logMsg('errors.log', `[${ROOM_ID}] No se pudo contactar Discord ("${tipo}"): ${e.message}`); resolve(null); });
            req.write(body); req.end();
        } catch (e) { logMsg('errors.log', `[${ROOM_ID}] Error evento ("${tipo}"): ${e.message}`); resolve(null); }
    });
}
function construirEmbed({ title, description, color = 0x00BFFF, fields, footer, thumbnail } = {}) {
    const e = { color, timestamp: new Date().toISOString() };
    if (title) e.title = title.slice(0, 256);
    if (description) e.description = String(description).slice(0, 4000);
    if (fields && fields.length) e.fields = fields.map(f => ({ name: String(f.name).slice(0, 256), value: String(f.value).slice(0, 1024), inline: !!f.inline }));
    if (footer) e.footer = { text: String(footer).slice(0, 2048) };
    if (thumbnail) e.thumbnail = { url: thumbnail };
    return e;
}
const CHAT_BATCH_MS = 3000;
let colaChatBuffer = [], colaChatTimer = null;
function notificarMensaje(linea) {
    colaChatBuffer.push(linea);
    if (colaChatBuffer.join("\n").length > 3500) colaChatBuffer = colaChatBuffer.slice(-20);
    if (!colaChatTimer) {
        colaChatTimer = setTimeout(() => {
            const c = colaChatBuffer.join("\n").slice(0, 3900);
            colaChatBuffer = []; colaChatTimer = null;
            enviarEventoBot("mensaje", { embed: construirEmbed({ title: "💬 Chat", description: c, color: 0x5865F2 }) });
        }, CHAT_BATCH_MS);
    }
}
function notificarEstadisticas(e) { return enviarEventoBot("estadisticas", { embed: e }); }
function notificarJoinLeave(e) { return enviarEventoBot("joinleave", { embed: e }); }
async function crearMensajeLive(e) { const r = await enviarEventoBot("live_crear", { embed: e }); return r?.messageId || null; }
async function editarMensajeLive(id, e) { if (!id) return; const r = await enviarEventoBot("live_editar", { messageId: id, embed: e }); if (r?.recreado && r?.messageId) STATE.liveStatsMessageId = r.messageId; }
function embedHistorial() {
    const j = Object.values(STATE.baseDatos);
    return construirEmbed({
        title: `📚 Historial — Sala ${ROOM_ID}`, description: "Estadísticas acumuladas", color: 0x9B59B6,
        fields: [
            { name: "🧑‍🤝‍🧑 Registrados", value: String(j.length), inline: true },
            { name: "🎮 Partidos", value: String(STATE.records.partidosTotalesLiga || 0), inline: true },
            { name: "⚽ Goles", value: String(j.reduce((a, s) => a + (s.goles || 0), 0)), inline: true },
            { name: "🎯 Asistencias", value: String(j.reduce((a, s) => a + (s.asistencias || 0), 0)), inline: true },
            { name: "⏳ Horas", value: `${(j.reduce((a, s) => a + (s.segundos_jugados || 0), 0) / 3600).toFixed(1)}h`, inline: true },
        ], footer: `🏆 Bahía Blanca Futsal · ${ROOM_ID}`,
    });
}
async function actualizarHistorial() { try { await enviarEventoBot("historial_actualizar", { embed: embedHistorial() }); } catch (e) { logMsg('errors.log', `[${ROOM_ID}] Error historial: ${e.message}`); } }
function formatUptime(ms) { const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return h > 0 ? `${h}h ${m}m` : `${m}m ${s % 60}s`; }
function barraProgreso(a, m, l = 10) { const p = m > 0 ? Math.min(1, a / m) : 0; const ll = Math.round(p * l); return "●".repeat(ll) + "○".repeat(Math.max(0, l - ll)); }
function listaNombresJugadores(js, mx = 8) { if (!js.length) return "_Nadie conectado todavía_"; const ns = js.map(p => `\`${p.name}\``); return ns.length <= mx ? ns.join(", ") : `${ns.slice(0, mx).join(", ")} y ${ns.length - mx} más`; }
function embedEstadoSala() {
    const js = safeOperation(() => STATE.room.getPlayerList(), []) || [];
    const enSala = js.filter(p => p.id !== 0);
    const sc = STATE.partidoEnCurso ? STATE.ultimoMarcadorConocido : null;
    let est, col;
    if (sc) { est = "🟢 Partido en curso"; col = 0x00FF88; }
    else if (enSala.length > 0) { est = "🟡 Esperando jugadores"; col = 0xFFC531; }
    else { est = "⚪ Sala vacía"; col = 0x808080; }
    const marc = sc ? `🔴 \`${sc.red}\` — \`${sc.blue}\` 🔵\n🕐 ${formatTime(sc.time || 0)}′` : "_Sin partido_";
    let modo = "⛔ Manual";
    if (STATE.automatizadoActivado) modo = STATE.bracketFijo === BRACKET_X4_FIJO ? "⚙️ Auto · X4 fijo" : `⚙️ Auto · ${STATE.maxPlayersPerTeam}v${STATE.maxPlayersPerTeam}`;
    else if (STATE.jueganTodosActivo) modo = "👥 Juegan todos";
    return construirEmbed({
        title: CONFIG.NOMBRE_SALA, description: [`**${est}**`, `[🔗 Click acá para entrar](${STATE.roomLink || CONFIG.ROOM_LINK || ""})`].join("\n"), color: col,
        fields: [
            { name: "👥 Jugadores", value: `\`${enSala.length}/${CONFIG.MAX_JUGADORES_SALA}\` ${barraProgreso(enSala.length, CONFIG.MAX_JUGADORES_SALA)}`, inline: false },
            { name: "⏱️ Uptime", value: formatUptime(Date.now() - STATE.inicioSala), inline: true },
            { name: "⚽ Marcador", value: marc, inline: true },
            { name: "🎛️ Modo", value: modo, inline: true },
            { name: "🧑‍🤝‍🧑 En la sala", value: listaNombresJugadores(enSala), inline: false },
        ], footer: "🏆 Bahía Blanca Futsal",
    });
}
function getTituloSeguro(k) { return TITULOS[k] || TITULOS.bronce1; }
function getSiguienteRango(k) { const c = Object.keys(TITULOS), i = c.indexOf(k); if (i === -1 || i === c.length - 1) return null; return { key: c[i + 1], ...TITULOS[c[i + 1]] }; }
function invalidarCache(t, k) { STATE.caches[t].delete(`${t}_${k}`); STATE.caches.timestamps.delete(`${t}_${k}`); }
function prioridadBadge(b) { if (b.startsWith("campeon_s")) return 1000; const n = b.match(/(\d+)$/); return n ? parseInt(n[1], 10) : 1; }
function obtenerBadgesPorKey(k) {
    const ck = `badges_${k}`; if (STATE.caches.badges.has(ck)) return STATE.caches.badges.get(ck);
    const bj = STATE.baseDatos[k]?.badges || [];
    const me = [...bj].sort((a, b) => prioridadBadge(b) - prioridadBadge(a))[0];
    const r = me ? (BADGES[me] || (me.startsWith("campeon_s") ? "🏆" : "")) : "";
    STATE.caches.badges.set(ck, r); STATE.caches.timestamps.set(ck, Date.now()); return r;
}
function obtenerBadges(p) { return obtenerBadgesPorKey(getPlayerKey(p)); }
function obtenerTituloPorKey(k) {
    const ck = `titulos_${k}`; if (STATE.caches.titulos.has(ck)) return STATE.caches.titulos.get(ck);
    const s = STATE.baseDatos[k]; const r = getTituloSeguro(s?.titulo || "bronce1");
    const res = s?.titulo_custom ? { nombre: s.titulo_custom, color: s.color_nombre || 0xFFFFFF, req: 0, rango: r.nombre, esCustom: true } : { ...r, rango: r.nombre, esCustom: false };
    STATE.caches.titulos.set(ck, res); STATE.caches.timestamps.set(ck, Date.now()); return res;
}
function obtenerTitulo(p) { return obtenerTituloPorKey(getPlayerKey(p)); }
function formatTituloDisplay(t) { return t.esCustom ? `${t.nombre}, ${t.rango}` : t.nombre; }
function darBadgePorKey(k, bid, nm, ti = null) {
    const s = STATE.baseDatos[k]; if (!s || s.badges.includes(bid)) return;
    s.badges.push(bid); invalidarCache("badges", k);
    const nl = BADGE_NOMBRES[bid] || bid.replace(/_/g, " ");
    const txt = ti ? `🏅✨ ¡Nuevo logro! ${BADGES[bid] || "🏆"} ${nl}` : `🏅✨ ${nm} desbloqueó ${BADGES[bid] || "🏆"} ${nl}`;
    msgSmall(txt, ti, COLORES.oro, "small-bold", 1);
    markDirty(k);
}
function darBadge(p, bid) { if (!p) return; darBadgePorKey(p.key || getPlayerKey(p), bid, p.name, p.id); }
const CAMPOS_RANKING = { elo: "mmr", goles: "goles", asistencias: "asistencias", victorias: "victorias", partidos: "partidos", atajadas: "atajadas" };
async function obtenerRankingDesdeDB(cat, lim) {
    const c = CAMPOS_RANKING[cat] || "mmr";
    const { rows } = await getPool().query(`SELECT data FROM players WHERE COALESCE((data->>'partidos')::int, 0) > 0 ORDER BY COALESCE((data->>$1)::numeric, 0) DESC LIMIT $2;`, [c, Math.max(1, Math.min(25, lim))]);
    return rows.map(({ data: s }) => ({ nombre: s.nombre_actual, valor: s[c] || 0, mmr: s.mmr || 1000, goles: s.goles || 0, asistencias: s.asistencias || 0, victorias: s.victorias || 0, partidos: s.partidos || 0, titulo: getTituloSeguro(s.titulo || "bronce1")?.nombre || "Bronce I" }));
}
function obtenerRankingLocal(cat = "elo", lim = 10) {
    const c = CAMPOS_RANKING[cat] || "mmr";
    return Object.values(STATE.baseDatos).filter(s => (s.partidos || 0) > 0).sort((a, b) => (b[c] || 0) - (a[c] || 0)).slice(0, Math.max(1, Math.min(25, lim))).map(s => ({ nombre: s.nombre_actual, valor: s[c] || 0, mmr: s.mmr || 1000, goles: s.goles || 0, asistencias: s.asistencias || 0, victorias: s.victorias || 0, partidos: s.partidos || 0, titulo: getTituloSeguro(s.titulo || "bronce1")?.nombre || "Bronce I" }));
}
function confirmarVerificacionDiscord(cod, dId = null, dTag = null) {
    const p = STATE.verificacionesPendientes[cod];
    if (!p || p.expira < Date.now()) { delete STATE.verificacionesPendientes[cod]; return false; }
    delete STATE.verificacionesPendientes[cod];
    const s = STATE.baseDatos[p.key];
    if (!s || s.discord_verificado) return false;
    s.discord_verificado = true; s.discord_id = dId; s.discord_tag = dTag || null;
    s.monedas += CONFIG.VERIFICACION_RECOMPENSA_MONEDAS;
    if (!s.badges.includes("fair_play") && s.fair_play >= 90) darBadgePorKey(p.key, "fair_play", s.nombre_actual);
    markDirty(p.key);
    if (STATE.room?.getPlayer(p.playerId)) msgBox(`✅ ¡DISCORD VERIFICADO!`, [`+${CONFIG.VERIFICACION_RECOMPENSA_MONEDAS}💰`], COLORES.exito, "small-bold", 2, p.playerId);
    notificarMensaje(`✅ **${p.nombre}** verificó Discord`);
    return true;
}
function iniciarServidorVerificacion() {
    const server = http.createServer((req, res) => {
        if (req.headers["x-verificacion-secreto"] !== CONFIG.VERIFICACION_HTTP_SECRETO) { res.writeHead(401); return res.end("no autorizado"); }
        if (req.method === "POST" && req.url === "/verificar") {
            let body = "";
            req.on("data", c => { body += c; if (body.length > 10000) req.destroy(); });
            req.on("end", () => {
                try {
                    const { codigo, discordId, discordTag } = JSON.parse(body || "{}");
                    const ok = confirmarVerificacionDiscord(String(codigo || ""), discordId || null, discordTag || null);
                    res.writeHead(ok ? 200 : 404, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok }));
                } catch (e) { res.writeHead(400); res.end("bad request"); }
            }); return;
        }
        if (req.method === "GET" && req.url.startsWith("/ranking")) {
            (async () => {
                try {
                    const p = new URL(req.url, "http://localhost").searchParams;
                    const cat = p.get("categoria") || "elo", lim = parseInt(p.get("limite") || "10", 10);
                    const rk = await obtenerRankingDesdeDB(cat, lim);
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ ok: true, categoria: CAMPOS_RANKING[cat] ? cat : "elo", ranking: rk, roomId: ROOM_ID, sala: CONFIG.NOMBRE_SALA }));
                } catch (e) {
                    logMsg('errors.log', `[${ROOM_ID}] /ranking fallback: ${e.message}`);
                    try { const p = new URL(req.url, "http://localhost").searchParams; res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true, categoria: p.get("categoria") || "elo", ranking: obtenerRankingLocal(p.get("categoria") || "elo", parseInt(p.get("limite") || "10", 10)), roomId: ROOM_ID, sala: CONFIG.NOMBRE_SALA })); }
                    catch (e2) { res.writeHead(500); res.end("error"); }
                }
            })(); return;
        }
        if (req.method === "POST" && req.url === "/admin") {
            let body = "";
            req.on("data", c => { body += c; if (body.length > 10000) req.destroy(); });
            req.on("end", () => {
                try { const p = JSON.parse(body || "{}"); const r = ejecutarAccionAdmin(String(p.accion || ""), p); res.writeHead(r.ok ? 200 : 400, { "Content-Type": "application/json" }); res.end(JSON.stringify(r)); }
                catch (e) { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: "bad request" })); }
            }); return;
        }
        if (req.method === "GET" && req.url === "/health") {
            let ps = {}, pg = {};
            try { const x = getPool(); ps = { total: x.totalCount, idle: x.idleCount, waiting: x.waitingCount }; } catch (e) { }
            try { const x = getGlobalPool(); pg = { total: x.totalCount, idle: x.idleCount, waiting: x.waitingCount }; } catch (e) { }
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ room: ROOM_ID, uptime: Date.now() - (STATE.inicioSala || Date.now()), players: STATE.room ? STATE.room.getPlayerList().length : 0, partidoEnCurso: STATE.partidoEnCurso, isDirty: STATE.isDirty, dirtyPlayers: STATE.dirtyPlayers.size, fullDiffPendiente: STATE.fullDiffPendiente, poolSala: ps, poolGlobal: pg, retryQueue: RETRY_QUEUE.length, discordCircuit: DISCORD_CB.abiertoHasta > Date.now() ? "abierto" : "cerrado" })); return;
        }
        res.writeHead(404); res.end();
    });
    server.on("error", e => logMsg('errors.log', `[${ROOM_ID}] Servidor: ${e.message}`));
    server.listen(CONFIG.VERIFICACION_HTTP_PUERTO, () => console.log(`🔗 HTTP en puerto ${CONFIG.VERIFICACION_HTTP_PUERTO}`));
}
function ejecutarAccionAdmin(accion, payload) {
    if (!STATE.room) return { ok: false, error: "Sin sala" };
    switch (accion) {
        case "reiniciar": { const h = STATE.partidoEnCurso; STATE.room.stopGame(); setTimeout(() => { if (STATE.room && !STATE.partidoEnCurso) STATE.room.startGame(); }, 1000); return { ok: true, mensaje: h ? "Reiniciado" : "Reiniciado" }; }
        case "minutos": { if (STATE.partidoEnCurso) return { ok: false, error: "Partido en curso" }; const m = parseInt(payload.valor, 10); if (!Number.isFinite(m) || m < 0) return { ok: false, error: "Inválido" }; STATE.room.setTimeLimit(m); if (STATE.configuracionActual) STATE.configuracionActual.timeLimit = m; return { ok: true, mensaje: `${m} min` }; }
        case "goles": { if (STATE.partidoEnCurso) return { ok: false, error: "Partido en curso" }; const g = parseInt(payload.valor, 10); if (!Number.isFinite(g) || g < 0) return { ok: false, error: "Inválido" }; STATE.room.setScoreLimit(g); if (STATE.configuracionActual) STATE.configuracionActual.scoreLimit = g; return { ok: true, mensaje: `${g === 0 ? "sin límite" : g}` }; }
        case "mensaje": { const t = String(payload.texto || "").trim().slice(0, 200); if (!t) return { ok: false, error: "Vacío" }; sendAnnouncement(`💬 ${String(payload.autor || "Discord").slice(0, 32)} (Discord): ${t}`, null, 0x5865F2, "normal", 0); return { ok: true }; }
        case "admin": { const t = findOnlinePlayer(String(payload.jugador || "")); if (!t) return { ok: false, error: "No encontrado" }; STATE.room.setPlayerAdmin(t.id, true); return { ok: true, nombre: t.name }; }
        case "kick": { const t = findOnlinePlayer(String(payload.jugador || "")); if (!t) return { ok: false, error: "No encontrado" }; STATE.room.kickPlayer(t.id, String(payload.motivo || "Expulsado").slice(0, 100), false); return { ok: true, nombre: t.name }; }
        case "ban": case "banip": { const t = findOnlinePlayer(String(payload.jugador || "")); if (!t) return { ok: false, error: "No encontrado" }; const d = Math.max(1, parseInt(payload.dias, 10) || CONFIG.BAN_DIAS_NORMAL); const k = getPlayerKey(t); if (STATE.baseDatos[k]) aplicarBanGlobal(k, d * 86400000); STATE.room.kickPlayer(t.id, `⛔ ${String(payload.motivo || "Baneado").slice(0, 100)} (${d}d)`, accion === "banip"); return { ok: true, nombre: t.name, dias: d }; }
        case "unban": { const n = String(payload.jugador || "").trim(); if (!n) return { ok: false, error: "Falta nombre" }; const on = findOnlinePlayer(n); const k = on ? getPlayerKey(on) : findPlayerKeyByName(n); if (!k || !STATE.baseDatos[k]) return { ok: false, error: "No encontrado" }; quitarBanGlobal(k); return { ok: true, nombre: STATE.baseDatos[k].nombre_actual }; }
        default: return { ok: false, error: `Desconocida: ${accion}` };
    }
}
function calcularTamanoObjetivo(p) {
    if (!p || p.team === 0) return null;
    const s = STATE.baseDatos[getPlayerKey(p)]; if (!s) return null;
    const tier = s.vip ? tierVipDe(s) : null;
    const minB = CONFIG.TAMANO_MIN, maxB = tier ? tier.max : CONFIG.TAMANO_MAX;
    let b = s.tamano_personalizado || CONFIG.TAMANO_DEFAULT;
    b = Math.min(maxB, Math.max(minB, b));
    if (STATE.gkReservado[1] === p.id || STATE.gkReservado[2] === p.id) b += CONFIG.GK_SIZE_BONUS;
    if (CONFIG.CAPITAN_SIZE_BONUS > 0 && (STATE.capitanes[1] === p.id || STATE.capitanes[2] === p.id)) b += CONFIG.CAPITAN_SIZE_BONUS;
    b = Math.min(maxB + Math.max(CONFIG.GK_SIZE_BONUS, CONFIG.CAPITAN_SIZE_BONUS), Math.max(minB, b));
    return { radius: b, invMass: Math.max(0.05, 0.5 + (CONFIG.TAMANO_DEFAULT - b) * 0.02) };
}
function aplicarTamanoPersistente(p) {
    const o = calcularTamanoObjetivo(p); if (!o) return;
    STATE.radioJugadorCache.set(p.id, o.radius);
    const a = safeOperation(() => STATE.room.getPlayerDiscProperties(p.id));
    if (a && Math.abs(a.radius - o.radius) < 0.01 && Math.abs(a.invMass - o.invMass) < 0.001) return;
    safeOperation(() => STATE.room.setPlayerDiscProperties(p.id, { radius: o.radius, invMass: o.invMass }));
}
let enforceCounter = 0;
function aplicarTamanosPersistentes() { enforceCounter++; if (enforceCounter % 5 !== 0) return; STATE.room.getPlayerList().filter(p => p.team !== 0 && !STATE.animacionGolActiva.has(p.id)).forEach(aplicarTamanoPersistente); }

// ── Powershot + curva perpendicular ──
// cancelarPowershotCarga: solo cancela la CARGA del powershot (color,
// trigger, ID, timer). NO toca STATE.curvaEnCurso. Esto es clave: la curva
// debe sobrevivir aunque el pateador se aleje, aunque el sistema reinicie
// la carga por error un tick después del kick, o aunque otro jugador la
// reactive. Si esto llamara a finalizarCurva(), la comba moría a los pocos
// ms del disparo (síntoma: "la pelota se pone blanca y desaparece").
function cancelarPowershotCarga() {
    restaurarPelotaPowershot();
    STATE.powershotTrigger = false;
    STATE.powershotCounter = 0;
    STATE.powershotID = 0;
    STATE.powershotChargeStartTime = null;
}
// resetPowershotState: reset COMPLETO (powershot + curva). Se usa al
// terminar un partido, al hacer un gol, al detectar error, o cuando hay
// que garantizar que no quede ninguna comba activa.
function resetPowershotState() { cancelarPowershotCarga(); finalizarCurva(); }
function handlePowerShot(pl, bp, bpr) { try { _handlePowerShotInterno(pl, bp, bpr); } catch (e) { logMsg('errors.log', `[${ROOM_ID}] Error handlePowerShot: ${e.message}`); resetPowershotState(); } }
function _handlePowerShotInterno(playerList, bpc, bprc) {
    if (!STATE.partidoEnCurso) {
        if (STATE.powershotID !== 0 || STATE.powershotTrigger || STATE.powershotBallDefaults) resetPowershotState();
        return;
    }
    // Lock post-kick: ignorar por ~6 ticks (~100ms) al pateador que acaba
    // de disparar, para que no rearranque la carga mientras la comba está
    // recién iniciada y la pelota todavía está saliendo de su radio.
    if (STATE.powershotKickLockId != null && (Date.now() - (STATE.powershotKickLockTs || 0)) < 100) {
        if (bpc && bprc) {
            const lim = getLimitesCancha();
            const pK = (playerList || STATE.room.getPlayerList()).find(x => x.id === STATE.powershotKickLockId);
            if (pK && pK.position && !pelotaTocoAlgo(bpc, bprc, [pK], null)) {
                STATE.powershotKickLockId = null;
                STATE.powershotKickLockTs = 0;
            } else {
                return; // todavía pegado → no re-cargar
            }
        } else {
            STATE.powershotKickLockId = null;
            STATE.powershotKickLockTs = 0;
        }
    }
    if ((!STATE.powershotActivado || STATE.powershotID === 0) && STATE.powershotBallDefaults) resetPowershotState();
    if (STATE.powershotID !== 0 && STATE.powershotChargeStartTime && (Date.now() - STATE.powershotChargeStartTime) > CONFIG.POWERSHOT_TIMEOUT_ABSOLUTO_MS) cancelarPowershotCarga();
    const players = (playerList || STATE.room.getPlayerList()).filter(p => p.id !== STATE.BOT_ID);
    if (STATE.powershotID !== 0 && !players.some(pl => pl.id === STATE.powershotID)) cancelarPowershotCarga();
    if (!STATE.powershotActivado || !STATE.partidoEnCurso) return;
    const bP = bpc || safeOperation(() => STATE.room.getBallPosition()); if (!bP) return;
    const bR = bprc || safeOperation(() => STATE.room.getDiscProperties(0)); if (!bR) return;
    const bRad = bR.radius || 10;
    const cL = bRad + CONFIG.TAMANO_MAX + 0.01 + CONFIG.POWERSHOT_CANCEL_DISTANCE + 5;
    let hv = false, ht = false;
    const cands = [];
    for (const p of players) {
        if (STATE.powershotID === p.id) hv = true;
        if (p.team === 0) { if (STATE.powershotID === p.id) cancelarPowershotCarga(); continue; }
        if (!p.position) continue;
        const d = pointDistance(p.position, bP);
        if (d > cL) { if (STATE.powershotID === p.id) cancelarPowershotCarga(); continue; }
        const pr = STATE.radioJugadorCache.get(p.id) ?? 15;
        const td = bRad + pr + 0.01;
        const tc = d < td;
        if (tc && STATE.powershotID === p.id) ht = true;
        cands.push({ player: p, distance: d, triggerDistance: td, tocando: tc });
    }
    if (STATE.powershotID !== 0 && !hv) cancelarPowershotCarga();
    for (const { player, distance, triggerDistance, tocando } of cands) {
        if (tocando) {
            if (STATE.powershotID !== player.id) {
                if (ht) continue;
                if (STATE.powershotID !== 0) cancelarPowershotCarga();
                STATE.powershotID = player.id; STATE.powershotTrigger = false; STATE.powershotCounter = 0; STATE.powershotChargeStartTime = Date.now();
                ht = true;
            } else {
                STATE.powershotCounter++;
                const sC = STATE.baseDatos[getPlayerKey(player)];
                const esV = !!sC?.vip;
                const tC = esV ? tierVipDe(sC) : null;
                if (!STATE.powershotTrigger) {
                    if (!STATE.powershotBallDefaults) STATE.powershotBallDefaults = { invMass: bR.invMass, bCoef: bR.bCoef, damping: bR.damping, color: bR.color };
                    if (esV) setColorPelota(gradienteVipTier(cuantizarTickColor(STATE.powershotCounter), tC));
                    else if (STATE.powershotCounter > CONFIG.POWERSHOT_COLOR_DELAY_TICKS) setColorPelota(gradientePowershotNormal(cuantizarTickColor(STATE.powershotCounter - CONFIG.POWERSHOT_COLOR_DELAY_TICKS), player.team));
                } else {
                    let cF;
                    if (esV) cF = gradienteVipTier(cuantizarTickColor(STATE.powershotCounter), tC);
                    else { const cE = player.team === 1 ? CONFIG.POWERSHOT_NORMAL_PALETA_ROJO[0] : CONFIG.POWERSHOT_NORMAL_PALETA_AZUL[0]; const per = CONFIG.POWERSHOT_FLASH_TICKS * 2; const fase = (1 - Math.cos((cuantizarTickColor(STATE.powershotCounter) / per) * Math.PI * 2)) / 2; cF = interpolarColorHex("FFFFFF", cE, fase); }
                    setColorPelota(cF);
                    if (STATE.powershotCounter > CONFIG.POWERSHOT_TICKS + CONFIG.POWERSHOT_MAX_TICKS_CARGADO) { cancelarPowershotCarga(); continue; }
                }
                if (STATE.powershotCounter > CONFIG.POWERSHOT_TICKS && !STATE.powershotTrigger) {
                    const cN = esV ? tC.gradA : CONFIG.POWERSHOT_COLOR_CARGA;
                    safeOperation(() => STATE.room.setDiscProperties(0, { bCoef: CONFIG.POWERSHOT_BALL_BCOEF, invMass: CONFIG.POWERSHOT_BALL_INVMASS, damping: CONFIG.POWERSHOT_BALL_DAMPING, color: `0x${cN}` }));
                    ultimoColorPelotaEnviado = cN;
                    STATE.powershotTrigger = true;
                }
            }
        } else if (distance > triggerDistance + CONFIG.POWERSHOT_CANCEL_DISTANCE) {
            if (STATE.powershotID === player.id) cancelarPowershotCarga();
        }
    }
}
function manejarEstelaVip() { if (!STATE.vipBallTrailActivo || STATE.powershotID !== 0) return; STATE.vipBallTrailTick = (STATE.vipBallTrailTick || 0) + 1; setColorPelota(gradienteVipTier(cuantizarTickColor(STATE.vipBallTrailTick), STATE.vipBallTrailTier)); }
function restaurarPelotaPowershot() {
    if (STATE.powershotBallDefaults) {
        const d = STATE.powershotBallDefaults;
        STATE.powershotBallDefaults = null;
        safeOperation(() => STATE.room.setDiscProperties(0, {
            invMass: d.invMass, bCoef: d.bCoef, damping: d.damping, color: d.color,
        }));
        // OJO: d.color es un NÚMERO (getDiscProperties devuelve int).
        // String(numero) da DECIMAL ("16777215"), no hex ("FFFFFF").
        // Usar colorPelotaAHex para normalizar siempre a 6 chars hex.
        ultimoColorPelotaEnviado = colorPelotaAHex(d.color);
        return;
    }
    if (!hayEfectoDeColorActivo()) setColorPelota(colorPelotaOriginal());
}

// ── Curva perpendicular por ROTACIÓN de velocidad ──
// Antes se sumaba una fuerza perpendicular cada tick. El damping del motor
// (~0.96) disipaba la velocidad perpendicular antes de que se acumule, así
// que subir CURVA_FUERZA no servía — la curva "no se notaba un carajo".
// Ahora se ROTA el vector velocidad directamente: cada tick la dirección
// cambia CURVA_ANGULO_POR_TICK radianes, y como eso no depende del damping,
// se acumula de forma predecible. Angulo total para un tiro de 150 ticks
// con decay pow 0.35 ≈ 1.15 rad ≈ 66°. Es lo mismo que hace un efecto
// Magnus real, sin pelear contra la fricción.
function finalizarCurva() {
    const c = STATE.curvaEnCurso;
    if (!c) return;
    STATE.curvaEnCurso = null;
    // IMPORTANTE: usar SIEMPRE el color default del mapa (valor crudo,
    // puede ser -1 = color nativo). Si usáramos c.colorOriginal y ese
    // snapshot se tomó del estado "charged" del powershot, la pelota
    // quedaría pintada de rojo/rosa para siempre. Y si forzáramos un hex
    // fallback tipo "FFFFFF", la pelota queda blanca perma en vez de
    // volver a su color real del mapa.
    setColorPelota(colorPelotaOriginal());
}

function pelotaTocoAlgo(bp, bpr, playerList, kickerId) {
    if (!bp || !bpr) return false;
    const bRad = bpr.radius || 10;
    const lim = getLimitesCancha();
    if (lim) {
        const mX = bRad + 2, mY = bRad + 2;
        const enBoca = lim.goalMaxY > 0 && Math.abs(bp.y) < lim.goalMaxY - 5;
        if (!enBoca && Math.abs(bp.x) > lim.maxX - mX) return true;
        if (Math.abs(bp.y) > lim.maxY - mY) return true;
    }
    if (playerList) {
        for (const p of playerList) {
            if (p.team === 0 || !p.position) continue;
            // Saltar al pateador: sigue pegado a la pelota en los primeros
            // ticks del disparo y cortaría la curva al instante. Si la
            // vuelve a tocar, el onPlayerBallKick resetea la comba igual.
            if (kickerId != null && p.id === kickerId) continue;
            const pr = STATE.radioJugadorCache.get(p.id) ?? 15;
            // Margen de +1 (antes +2) porque el radio del jugador viene de
            // un cache que a veces queda levemente desactualizado.
            if (pointDistance(p.position, bp) < bRad + pr + 1) return true;
        }
    }
    return false;
}

function aplicarComba(bp, bpr, playerList) {
    if (!STATE.curvaEnCurso) return null;
    const c = STATE.curvaEnCurso;
    c.ticksActivos = (c.ticksActivos || 0) + 1;
    // Chequeo de colisión sólo después del grace period: el pateador sigue
    // pegado a la pelota 1-2 ticks y no queremos autocancelarla.
    if (c.ticksActivos > CONFIG.CURVA_GRACE_TICKS && pelotaTocoAlgo(bp, bpr, playerList, c.kickerId)) {
        finalizarCurva();
        return null;
    }
    if (c.ticksRestantes <= 0) { finalizarCurva(); return null; }
    const props = bpr || safeOperation(() => STATE.room.getDiscProperties(0));
    if (!props) { finalizarCurva(); return null; }
    const sp = Math.sqrt(props.xspeed ** 2 + props.yspeed ** 2);
    if (sp <= 0.5) { finalizarCurva(); return null; }
    // Detección de choque por cambio brusco de dirección o velocidad.
    // El damping del motor sólo escala el vector (misma dirección), así que
    // si el ángulo cambia más de ~5.7° en un tick (cos < 0.995), o si la
    // velocidad ACELERA (curSp > prevSp * 1.05), es porque la pelota chocó
    // contra algo: pared lateral real, poste, red o jugador. Este check
    // cubre específicamente las paredes que el check geométrico no ve
    // (los vertexes del fondo de las redes están más afuera que la pared
    // lateral real, así que Math.abs(bp.y) > maxY - mY nunca daba true).
    // Nuestra rotación máxima de comba es 0.022 rad ≈ 1.26°/tick, muy por
    // debajo del umbral, así que no hay falsos positivos.
    if (c.ultimaVel) {
        const prevSp = Math.hypot(c.ultimaVel.x, c.ultimaVel.y);
        const curSp = Math.hypot(props.xspeed, props.yspeed);
        if (prevSp > 0.5 && curSp > 0.01) {
            const cosA = (c.ultimaVel.x * props.xspeed + c.ultimaVel.y * props.yspeed) / (prevSp * curSp);
            if (cosA < 0.995 || curSp > prevSp * 1.05) { finalizarCurva(); return null; }
        }
    }
    const decay = Math.pow(c.ticksRestantes / CONFIG.CURVA_TICKS, CONFIG.CURVA_DECAY_POW);
    const ang = CONFIG.CURVA_ANGULO_POR_TICK * decay * c.direccion;
    const cos = Math.cos(ang), sin = Math.sin(ang);
    const nvx = props.xspeed * cos - props.yspeed * sin;
    const nvy = props.xspeed * sin + props.yspeed * cos;
    if (!Number.isFinite(nvx) || !Number.isFinite(nvy)) { finalizarCurva(); return null; }
    c.tickColor = (c.tickColor || 0) + 1;
    const fase = (1 - Math.cos((cuantizarTickColor(c.tickColor) / 40) * Math.PI * 2)) / 2;
    const colorHex = interpolarColorHex(CONFIG.CURVA_COLOR_A, CONFIG.CURVA_COLOR_B, fase);
    // ⚠️ SOLO xspeed/yspeed/color. NUNCA x/y: anclar la posición cada tick
    // hace que el motor "re-teletransporte" la pelota y se sienta trabada.
    const propsN = { xspeed: nvx, yspeed: nvy, color: `0x${colorHex}` };
    safeOperation(() => STATE.room.setDiscProperties(0, propsN));
    ultimoColorPelotaEnviado = colorHex;
    c.ultimaVel = { x: nvx, y: nvy };
    c.ticksRestantes--;
    if (c.ticksRestantes <= 0) finalizarCurva();
    return propsN;
}
function limitarVelocidadPelota(pc) {
    const p = pc || safeOperation(() => STATE.room.getDiscProperties(0)); if (!p) return;
    const s = Math.sqrt(p.xspeed ** 2 + p.yspeed ** 2);
    if (s > CONFIG.BALL_MAX_SPEED && s > 0) { const f = CONFIG.BALL_MAX_SPEED / s; safeOperation(() => STATE.room.setDiscProperties(0, { xspeed: p.xspeed * f, yspeed: p.yspeed * f })); }
}
function handlePowerShotKick(player) {
    if (!STATE.powershotActivado) return false;
    if (STATE.powershotID !== 0 && STATE.powershotID !== player.id) cancelarPowershotCarga();
    if (STATE.powershotID !== player.id) return false;
    const estaba = STATE.powershotTrigger;
    if (estaba) {
        const k = getPlayerKey(player), s = STATE.baseDatos[k];
        if (s) { s.powershots_exitosos = (s.powershots_exitosos || 0) + 1; if (s.powershots_exitosos >= 5 && !s.badges.includes("powershot_king")) darBadge(player, "powershot_king"); markDirty(k); }
        if (STATE.curvaActivado) {
            const bp = safeOperation(() => STATE.room.getDiscProperties(0));
            let dir = 1;
            if (bp) {
                const sp = Math.sqrt(bp.xspeed ** 2 + bp.yspeed ** 2);
                if (sp > 0.01) {
                    const dx = bp.xspeed / sp, dy = bp.yspeed / sp;
                    const cr = dx * (bp.y - player.position.y) - dy * (bp.x - player.position.x);
                    dir = cr >= 0 ? 1 : -1;
                }
            }
            // colorOriginal ya no se guarda: finalizarCurva() siempre usa
            // colorPelotaOriginal() (que respeta el color base del mapa y
            // nunca devuelve -1). Guardar un snapshot acá era fuente de bugs
            // (si el snapshot se tomaba durante el flash del powershot, la
            // pelota quedaba pintada de rojo/rosa para siempre).
            STATE.curvaEnCurso = {
                ticksRestantes: CONFIG.CURVA_TICKS,
                ticksActivos: 0,
                direccion: dir,
                tickColor: 0,
                kickerId: player.id,
                ultimaVel: null,
            };
        }
    }
    restaurarPelotaPowershot();
    STATE.powershotTrigger = false; STATE.powershotCounter = 0; STATE.powershotID = 0; STATE.powershotChargeStartTime = null;
    // Lock: durante los próximos ~6 ticks no dejar que el pateador
    // rearranque la carga automática al seguir pegado a la pelota después
    // del disparo. Sin esto, _handlePowerShotInterno arrancaba una carga
    // fantasma que a los 2 ticks se cancelaba y rompía la comba recién
    // iniciada.
    STATE.powershotKickLockId = player.id;
    STATE.powershotKickLockTs = Date.now();
    return estaba;
}
function hayEfectoDeColorActivo() { return STATE.powershotID !== 0 || STATE.vipBallTrailActivo || Object.keys(STATE.festejosVipActivos).length > 0; }
function colorPelotaOriginal() {
    const c = STATE.colorPelotaDefault;
    if (typeof c === "string") {
        const h = c.replace(/^0x/i, "").toUpperCase();
        if (/^[0-9A-F]{6}$/.test(h)) return h;
    }
    if (typeof c === "number" && c >= 0) return (c & 0xFFFFFF).toString(16).padStart(6, "0").toUpperCase();
    // colorPelotaDefault es null o inválido: NUNCA devolver -1, porque si el
    // engine lo interpreta como "reset al nativo" y el stadium no tiene un
    // color de pelota definido, la pelota queda invisible/desaparecida.
    // Fallback duro a blanco para que siempre se vea.
    return CONFIG.POWERSHOT_COLOR_INICIAL;
}
function restaurarColorPelotaSiLibre() { if (hayEfectoDeColorActivo()) return; setColorPelota(colorPelotaOriginal()); }

// ── Festejo VIP ──
function iniciarFestejoVip(player) {
    if (!player || STATE.festejosVipActivos[player.id]) return;
    STATE.vipBallTrailActivo = false;
    if (STATE.vipBallColorTimeout) clearTimeout(STATE.vipBallColorTimeout);
    const sF = STATE.baseDatos[getPlayerKey(player)], tF = tierVipDe(sF), esV = !!sF?.vip;
    const pO = esV ? safeOperation(() => STATE.room.getPlayerDiscProperties(player.id)) : null;
    STATE.festejosVipActivos[player.id] = { ticksRestantes: tF.festejoDuracionTicks || CONFIG.FESTEJO_VIP_DURACION_TICKS, gradTick: 0, avatarTick: 0, rgbTick: 0, tier: tF, esVipReal: esV, colorJugadorOriginal: pO ? pO.color : -1, startTs: Date.now() };
    safeOperation(() => STATE.room.setPlayerAvatar(player.id, "🔥"));
    setColorPelota(CONFIG.FESTEJO_VIP_TRAIL_COLORES[0]);
}
function finalizarFestejoVip(player) {
    const f = player ? STATE.festejosVipActivos[player.id] : null;
    if (player) delete STATE.festejosVipActivos[player.id];
    if (player) {
        const esC = STATE.capitanes[1] === player.id || STATE.capitanes[2] === player.id;
        safeOperation(() => STATE.room.setPlayerAvatar(player.id, esC ? CONFIG.CAPITAN_AVATAR : null));
        if (player.team !== 0 && !STATE.animacionGolActiva.has(player.id)) aplicarTamanoPersistente(player);
        if (f?.esVipReal) safeOperation(() => STATE.room.setPlayerDiscProperties(player.id, { color: f.colorJugadorOriginal }));
    }
    restaurarColorPelotaSiLibre();
}
function manejarFestejosVip(playerList) {
    for (const idS of Object.keys(STATE.festejosVipActivos)) {
        const id = parseInt(idS, 10), f = STATE.festejosVipActivos[idS];
        const p = playerList.find(pl => pl.id === id);
        if (!p) { finalizarFestejoVip(null); delete STATE.festejosVipActivos[idS]; continue; }
        f.ticksRestantes--;
        if (f.ticksRestantes <= 0 || (Date.now() - (f.startTs || 0)) > CONFIG.FESTEJO_VIP_DURACION_MAX_MS) { finalizarFestejoVip(p); continue; }
        const t = f.tier || CONFIG.VIP_TIERS.vip;
        if (f.ticksRestantes % 3 === 0) { const pr = safeOperation(() => STATE.room.getPlayerDiscProperties(p.id)); if (pr) { const v = Math.hypot(pr.xspeed, pr.yspeed); if (v > 0.01) { const ob = Math.min(v * t.festejoVelMult, CONFIG.FESTEJO_VEL_MAX); const fc = ob / v; if (fc > 1.001) safeOperation(() => STATE.room.setPlayerDiscProperties(p.id, { xspeed: pr.xspeed * fc, yspeed: pr.yspeed * fc })); } } }
        if (f.esVipReal) { f.rgbTick++; const cR = barridoPaleta(cuantizarTickColor(f.rgbTick), CONFIG.FESTEJO_VIP_RGB_COLORES, CONFIG.FESTEJO_VIP_RGB_VELOCIDAD); if (cR !== f.ultimoColorRgbEnviado) { f.ultimoColorRgbEnviado = cR; safeOperation(() => STATE.room.setPlayerDiscProperties(p.id, { color: `0x${cR}` })); } }
        f.gradTick++;
        setColorPelota(barridoPaleta(cuantizarTickColor(f.gradTick), CONFIG.FESTEJO_VIP_TRAIL_COLORES, t.festejoGradSpeed || 0.10));
        f.avatarTick++;
        const iA = t.festejoAvatarIntervalo || 8;
        if (f.avatarTick % iA === 0) { const av = ["🔥", "✨", "⭐"]; safeOperation(() => STATE.room.setPlayerAvatar(p.id, av[Math.floor(f.avatarTick / iA) % av.length])); }
    }
}

// ── Rainbow jersey ──
function restaurarCamisetaEquipo(team, orig) {
    if (!orig) return;
    safeOperation(() => STATE.room.setTeamColors(team, orig.angle ?? 90, textoContrasteCamiseta(orig.colors[0]), orig.colors));
}
function activarRainbowEquipo(team) {
    if (STATE.rainbowEquipoActivo && STATE.rainbowEquipoActivo.team !== team) restaurarCamisetaEquipo(STATE.rainbowEquipoActivo.team, STATE.rainbowEquipoActivo.colorOriginal);
    const orig = STATE.ultimasCamisetas ? (team === 1 ? STATE.ultimasCamisetas.cam1 : STATE.ultimasCamisetas.cam2) : null;
    STATE.rainbowEquipoActivo = {
        team, hueTick: 0, startTs: Date.now(),
        colorOriginal: orig || { angle: 90, colors: team === 1 ? [0xFF0000] : [0x0000FF] },
    };
}
// FIX rainbow: se corta cuando la pelota vuelve al centro (el saque está por
// empezar). Haxball reposiciona la pelota al centro DESPUÉS del gol, antes
// de que los jugadores se reacomoden a sus posiciones de saque. Este es el
// punto exacto en el que la camiseta tiene que volver a la original.
// Se ignora la posición durante los primeros 500ms por si la pelota ya
// estaba en el centro en el momento del gol (gol de taquito desde el medio).
function manejarRainbowEquipo(ballPos) {
    const r = STATE.rainbowEquipoActivo;
    if (!r) return;
    if (ballPos && (Date.now() - r.startTs) > 500) {
        if (Math.abs(ballPos.x) < 15 && Math.abs(ballPos.y) < 15) {
            restaurarCamisetaEquipo(r.team, r.colorOriginal);
            STATE.rainbowEquipoActivo = null;
            return;
        }
    }
    r.hueTick++;
    if (r.hueTick % CONFIG.RAINBOW_GOL_INTERVALO_TICKS !== 0) return;
    const ch = hueAHex((r.hueTick * CONFIG.RAINBOW_GOL_VELOCIDAD) % 360);
    const cn = parseInt(ch, 16);
    safeOperation(() => STATE.room.setTeamColors(r.team, 90, textoContrasteCamiseta(cn), [cn]));
}

// ── Votaciones ──
function iniciarVotacion(tipo, target, votante) {
    const ps = STATE.room.getPlayerList();
    if (ps.length < CONFIG.MIN_PLAYERS_VOTE) return msgError(`Se necesitan ${CONFIG.MIN_PLAYERS_VOTE}+ jugadores`, votante.id);
    if (STATE.votaciones[tipo]) return msgError(`Ya hay votación activa`, votante.id);
    const pp = Math.ceil(ps.length * CONFIG.PORCENTAJE_VOTOS / 100);
    const needed = (tipo === "kick30" || tipo === "mute30") ? Math.max(pp, Math.min(CONFIG.VOTEKICK_MIN_VOTOS, ps.length)) : pp;
    const token = ++STATE.votacionTokenSeq;
    STATE.votaciones[tipo] = { target, inicio: Date.now(), needed, token };
    STATE.votos[tipo] = { [votante.id]: true };
    const em = { expulsar: "🚷", kick30: "🚷", mute30: "🤫" }[tipo] || "🗳️";
    sendAnnouncement(`${em} VOTACIÓN: ${target.name}\n!votar ${tipo} (${needed} votos)`, null, COLORES.advertencia, "small-bold", 2);
    setTimeout(() => { if (STATE.votaciones[tipo]?.token === token) { STATE.votaciones[tipo] = null; STATE.votos[tipo] = {}; msgSmall(`❌ Votación cancelada`, null, COLORES.error, "small-bold", 1); } }, CONFIG.COOLDOWN_VOTE);
}
function votar(tipo, votante) {
    if (!STATE.votaciones[tipo]) return msgError("No hay votación", votante.id);
    if (STATE.votos[tipo][votante.id]) return msgError("Ya votaste", votante.id);
    STATE.votos[tipo][votante.id] = true;
    const n = STATE.votaciones[tipo].needed, v = Object.keys(STATE.votos[tipo]).length;
    msgSmall(`🗳️ ${votante.name} votó (${v}/${n})`, null, COLORES.advertencia, "small-bold", 1);
    if (v >= n) {
        const t = STATE.votaciones[tipo].target;
        if (tipo === "expulsar") { STATE.room.kickPlayer(t.id, "Expulsado", false); msgBox(`🚷 ¡EXPULSADO!`, [`${t.name}`], COLORES.error, "small-bold", 2); }
        else if (tipo === "kick30") { const s = STATE.baseDatos[getPlayerKey(t)]; if (s) aplicarBanGlobal(getPlayerKey(t), CONFIG.VOTEKICK_DURACION_MS); STATE.room.kickPlayer(t.id, "🚷 Votekickeado (30 min)", false); msgBox(`🚷 ¡VOTEKICK!`, [`${t.name}`, `30 min`], COLORES.error, "small-bold", 2); }
        else if (tipo === "mute30") { const k = getPlayerKey(t); STATE.mutesTemporales = STATE.mutesTemporales.filter(m => m.auth !== k); STATE.mutesTemporales.push({ auth: k, timestamp: Date.now(), duracion: CONFIG.VOTEMUTE_DURACION_MS }); msgBox(`🤫 ¡VOTEMUTE!`, [`${t.name}`, `30 min`], COLORES.advertencia, "small-bold", 2); }
        STATE.votaciones[tipo] = null; STATE.votos[tipo] = {};
    }
}
function checkFlood(player) {
    const k = getPlayerKey(player), ahora = Date.now();
    const h = (STATE.mensajesRecientes[k] || []).filter(t => ahora - t < CONFIG.FLOOD_VENTANA_MS);
    h.push(ahora);
    STATE.mensajesRecientes[k] = h;
    if (h.length > CONFIG.FLOOD_MAX_MENSAJES) {
        STATE.mensajesRecientes[k] = [];
        STATE.mutesTemporales = STATE.mutesTemporales.filter(m => m.auth !== k);
        STATE.mutesTemporales.push({ auth: k, timestamp: ahora, duracion: CONFIG.FLOOD_MUTE_MS });
        return true;
    }
    return false;
}
function checkAFK() {
    if (!STATE.partidoEnCurso) return;
    const now = Date.now();
    STATE.room.getPlayerList().forEach(p => {
        if (p.team === 0 || p.admin || !p.position) return;
        const prev = STATE.playerPositions[p.id];
        if (prev && prev.x === p.position.x && prev.y === p.position.y) {
            if (!STATE.afkPlayers.has(p.id) && (now - (STATE.playerLastMove[p.id] || now)) > CONFIG.AFK_DETECT_MS) {
                STATE.afkPlayers.add(p.id);
                STATE.afkDesde[p.id] = now;
                msgSmall(`💤 ${p.name} está AFK`, null, 0xFF8800, "small", 1);
                safeOperation(() => STATE.room.setPlayerTeam(p.id, 0));
                STATE.afkCooldown.set(getPlayerKey(p), now + CONFIG.AFK_REINGRESO_COOLDOWN_MS);
                STATE.ultimoToggleAfk[p.id] = now;
                msgSmall(`Volvé en ${Math.round(CONFIG.AFK_KICK_MS / 1000)}s`, p.id, 0xFF8800, "small", 1);
            }
        } else {
            STATE.afkPlayers.delete(p.id); delete STATE.afkDesde[p.id]; STATE.afkAvisado30s.delete(p.id);
            STATE.playerPositions[p.id] = { x: p.position.x, y: p.position.y };
            STATE.playerLastMove[p.id] = now;
        }
    });
}
function checkAFKKickAutomatico() {
    const ahora = Date.now();
    STATE.afkPlayers.forEach(id => {
        const desde = STATE.afkDesde[id]; if (!desde) return;
        const t = ahora - desde, j = STATE.room.getPlayer(id);
        if (!j || j.admin) return;
        if (t >= CONFIG.AFK_KICK_MS) { STATE.room.kickPlayer(id, "AFK", false); STATE.afkPlayers.delete(id); delete STATE.afkDesde[id]; STATE.afkAvisado30s.delete(id); }
        else if (!STATE.afkAvisado30s.has(id) && CONFIG.AFK_KICK_MS - t <= CONFIG.AFK_WARN_MS) { STATE.afkAvisado30s.add(id); msgSmall(`${j.name}, 30s antes del kick por AFK`, id, COLORES.error, "small-bold", 1); }
    });
}
function kickAFKs(adminName) {
    let k = 0;
    STATE.afkPlayers.forEach(id => { const p = STATE.room.getPlayer(id); if (p && !p.admin) { STATE.room.kickPlayer(id, "AFK", false); k++; } delete STATE.afkDesde[id]; STATE.afkAvisado30s.delete(id); });
    STATE.afkPlayers.clear(); msgBox(`🚷 AFKs Kickeados`, [`${k} jugadores`, `Por: ${adminName}`], COLORES.error, "small-bold", 2);
}
function handleFairPlay(sc) {
    if (!STATE.fairPlayActivo) return;
    const d = Math.abs(sc.red - sc.blue); if (d === 0) return;
    setTimeout(() => {
        if (STATE.partidoEnCurso) return;
        const ps = STATE.room.getPlayerList().filter(p => p.team !== 0);
        if (d === 1) { ps.forEach(p => { if (p.team === 1) STATE.room.setPlayerTeam(p.id, 2); else if (p.team === 2) STATE.room.setPlayerTeam(p.id, 1); }); msgBox(`🔄 FairPlay`, [`Dif 1 gol`, `Intercambiados`], COLORES.exito, "small-bold", 0); }
        else if (d === 2) { shuffleArray(ps).forEach((p, i) => STATE.room.setPlayerTeam(p.id, i % 2 === 0 ? 1 : 2)); msgBox(`🎲 FairPlay`, [`Dif 2`, `Mezclados`], COLORES.exito, "small-bold", 0); }
        else if (d >= 3) { const { equipo1, equipo2 } = balancearEquiposElo(ps); equipo1.forEach(p => STATE.room.setPlayerTeam(p.id, 1)); equipo2.forEach(p => STATE.room.setPlayerTeam(p.id, 2)); msgBox(`⚖️ FairPlay`, [`Dif 3+`, `Rebalanceados`], COLORES.exito, "small-bold", 0); }
    }, 2000);
}
function handleGanaSigue(gan) {
    if (!STATE.ganaSigueActivo || gan === 0) return;
    setTimeout(() => {
        if (STATE.partidoEnCurso) return;
        const per = gan === 1 ? 2 : 1;
        const specs = STATE.room.getPlayerList().filter(p => p.team === 0 && !STATE.afkPlayers.has(p.id));
        STATE.room.getPlayerList().filter(p => p.team === per).forEach(p => STATE.room.setPlayerTeam(p.id, 0));
        if (specs.length >= 2) { specs.slice(0, 4).forEach((p, i) => STATE.room.setPlayerTeam(p.id, i % 2 === 0 ? per : gan)); msgBox(`⏭️ Gana Sigue`, [`Perdedores salen`], COLORES.advertencia, "small-bold", 0); }
    }, 3000);
}
function calcularVelocidadTiro() { try { const b = STATE.room.getDiscProperties(0); return (Math.sqrt((b.xspeed || 0) ** 2 + (b.yspeed || 0) ** 2) * 60 / CONFIG.VELOCIDAD_PX_POR_METRO) * 3.6; } catch (e) { return null; } }
function animarCrecimientoGoleador(pid) {
    const prev = STATE.animacionGolIntervalos.get(pid); if (prev) clearInterval(prev);
    const orig = safeOperation(() => STATE.room.getPlayerDiscProperties(pid)); if (!orig) return;
    const tk = (STATE.animacionGolSeq = (STATE.animacionGolSeq || 0) + 1);
    STATE.animacionGolTokenPorId.set(pid, tk);
    STATE.animacionGolActiva.add(pid);
    const rI = orig.radius, rM = CONFIG.GOAL_GROW_MAX_SIZE, pasos = 22;
    const ms = Math.max(20, CONFIG.GOAL_GROW_DURATION_MS / pasos);
    const iM = r => Math.max(0.05, 0.5 + (CONFIG.TAMANO_DEFAULT - r) * 0.02);
    const term = () => { if (STATE.animacionGolTokenPorId.get(pid) !== tk) return; STATE.animacionGolIntervalos.delete(pid); STATE.animacionGolActiva.delete(pid); STATE.animacionGolTokenPorId.delete(pid); };
    let paso = 0;
    const int = setInterval(() => {
        if (STATE.animacionGolTokenPorId.get(pid) !== tk) { clearInterval(int); return; }
        paso++;
        const p = STATE.room.getPlayer(pid);
        if (!p) { clearInterval(int); term(); return; }
        const r = rI + (rM - rI) * (paso / pasos);
        const ok = safeOperation(() => { STATE.room.setPlayerDiscProperties(pid, { radius: r, invMass: iM(r) }); return true; }, false);
        if (!ok || paso >= pasos) { clearInterval(int); setTimeout(() => { if (STATE.animacionGolTokenPorId.get(pid) !== tk) return; iniciarAchiqueGradual(pid, rM, iM, term, tk); }, CONFIG.GOAL_GROW_HOLD_MS); }
    }, ms);
    STATE.animacionGolIntervalos.set(pid, int);
}
function iniciarAchiqueGradual(pid, rD, iM, term, tk) {
    const p = STATE.room.getPlayer(pid); if (!p) { term(); return; }
    const o = calcularTamanoObjetivo(p); const rF = o ? o.radius : CONFIG.TAMANO_DEFAULT;
    const pasos = 22, ms = Math.max(20, CONFIG.GOAL_GROW_DURATION_MS / pasos);
    let paso = 0;
    const int = setInterval(() => {
        if (STATE.animacionGolTokenPorId.get(pid) !== tk) { clearInterval(int); return; }
        paso++;
        const p2 = STATE.room.getPlayer(pid);
        if (!p2) { clearInterval(int); term(); return; }
        const r = rD + (rF - rD) * (paso / pasos);
        const ok = safeOperation(() => { STATE.room.setPlayerDiscProperties(pid, { radius: r, invMass: iM(r) }); return true; }, false);
        if (!ok || paso >= pasos) { clearInterval(int); term(); if (p2.team !== 0) aplicarTamanoPersistente(p2); }
    }, ms);
    STATE.animacionGolIntervalos.set(pid, int);
}
function calcularPosesion() {
    const t = STATE.equipoRojoPosesion + STATE.equipoAzulPosesion;
    if (t > 0) sendAnnouncement(`📊 Posesión: 🔴 ${((STATE.equipoRojoPosesion / t) * 100).toFixed(1)}% · ${((STATE.equipoAzulPosesion / t) * 100).toFixed(1)}% 🔵`, null, COLORES.info, "small-bold", 1);
}
function detectArquero(pl) {
    const ts = pl || STATE.room.getPlayerList();
    const r = ts.filter(p => p.team === 1 && p.position), b = ts.filter(p => p.team === 2 && p.position);
    if (r.length > 0) STATE.ArqueroRED = r.reduce((m, c) => c.position.x < m.position.x ? c : m, r[0]);
    if (b.length > 0) STATE.ArqueroBLUE = b.reduce((m, c) => c.position.x > m.position.x ? c : m, b[0]);
}
function revisarArquerosReservados(pl, bp) {
    const ancho = getAnchoCancha();
    [1, 2].forEach(t => {
        const gk = STATE.gkReservado[t]; if (!gk) return;
        const j = pl.find(p => p.id === gk && p.team === t); if (!j || !j.position) return;
        const gx = t === 1 ? -ancho / 2 : ancho / 2;
        const d = Math.abs(j.position.x - gx);
        const pel = bp ? (t === 1 ? bp.x < 0 : bp.x > 0) : true;
        const lejos = d > CONFIG.GK_WARN_DISTANCE && pel;
        const prev = STATE.gkUltimoWarn[gk], ya = prev?.avisado || false;
        if (lejos && !ya) STATE.gkUltimoWarn[gk] = { avisado: true, ts: Date.now() };
        else if ((!lejos || !pel) && ya && d <= CONFIG.GK_WARN_DISTANCE) STATE.gkUltimoWarn[gk] = { avisado: false, ts: Date.now() };
    });
}
function sugerirGkAJugadoresEnArco(pl) {
    const ancho = getAnchoCancha(), ahora = Date.now(), ids = new Set();
    pl.forEach(p => {
        if (p.team === 0 || !p.position) return;
        ids.add(p.id);
        if (STATE.gkReservado[p.team] === p.id) { delete STATE.zonaArcoDesde[p.id]; return; }
        const gx = p.team === 1 ? -ancho / 2 : ancho / 2;
        const d = Math.abs(p.position.x - gx);
        if (d > CONFIG.GK_SUGERIR_ZONA_DISTANCIA) { delete STATE.zonaArcoDesde[p.id]; return; }
        if (!STATE.zonaArcoDesde[p.id]) STATE.zonaArcoDesde[p.id] = ahora;
        const t = ahora - STATE.zonaArcoDesde[p.id], u = STATE.zonaArcoUltimoAviso[p.id] || 0;
        if (t >= CONFIG.GK_SUGERIR_TIEMPO_MS && ahora - u >= CONFIG.GK_SUGERIR_COOLDOWN_MS) { msgSmall(`🧤 Usá !gk si querés atajar oficial`, p.id, COLORES.info, "small-bold", 0); STATE.zonaArcoUltimoAviso[p.id] = ahora; }
    });
    for (const k of Object.keys(STATE.zonaArcoDesde)) if (!ids.has(Number(k))) delete STATE.zonaArcoDesde[k];
}
function cambiarMapa(n, sl, tl) {
    const m = MAPAS[n]; if (!m) return;
    const nc = { nombreMapa: n, mapa: m, scoreLimit: sl, timeLimit: tl };
    if (STATE.configuracionActual && STATE.configuracionActual.nombreMapa === n && STATE.configuracionActual.scoreLimit === sl && STATE.configuracionActual.timeLimit === tl) { STATE.cambioMapaPendiente = null; return; }
    if (STATE.partidoEnCurso) { STATE.cambioMapaPendiente = nc; return; }
    aplicarConfigMapa(nc);
}
function aplicarConfigMapa(c) {
    if (!c) return;
    STATE.room.setCustomStadium(c.mapa); STATE.room.setScoreLimit(c.scoreLimit); STATE.room.setTimeLimit(c.timeLimit);
    STATE.configuracionActual = c; STATE.limitesCancha = computarLimitesCancha(c.mapa); STATE.cambioMapaPendiente = null;
}
const AUTOMATIZADO_BRACKETS = [
    { max: 3, equipoSize: 1, mapas: ["futx1-2"] }, { max: 5, equipoSize: 2, mapas: ["futx1-2"] },
    { max: 7, equipoSize: 3, mapas: ["futx3"] }, { max: 9, equipoSize: 4, mapas: ["futx4"] },
    { max: 11, equipoSize: 5, mapas: ["futx5"] }, { max: 13, equipoSize: 6, mapas: ["futx6"] },
    { max: 14, equipoSize: 7, mapas: ["futx7"] }, { max: 16, equipoSize: 8, mapas: ["futx10"] },
    { max: 18, equipoSize: 9, mapas: ["futx10"] }, { max: 20, equipoSize: 10, mapas: ["futx10"] },
    { max: Infinity, equipoSize: 11, mapas: ["futx11"] },
];
function getBracketAutomatizado(n) { return AUTOMATIZADO_BRACKETS.find(b => n <= b.max) || AUTOMATIZADO_BRACKETS[AUTOMATIZADO_BRACKETS.length - 1]; }
const BRACKET_X4_FIJO = { max: Infinity, equipoSize: 4, mapas: ["futx4"] };
function rebalancearAutomatico(j, eS, a1 = 0, a2 = 0) { const { equipo1, equipo2, sinAsignar } = balancearEquiposElo(j, eS, a1, a2); equipo1.forEach(x => STATE.room.setPlayerTeam(x.id, 1)); equipo2.forEach(x => STATE.room.setPlayerTeam(x.id, 2)); sinAsignar.forEach(x => STATE.room.setPlayerTeam(x.id, 0)); }
function mezclarTodosAutomatico(j, eS, a1 = 0, a2 = 0) { if (!j || j.length === 0) return; const { equipo1, equipo2 } = balancearEquiposElo(j, eS, a1, a2); j.forEach(x => STATE.room.setPlayerTeam(x.id, 0)); equipo1.forEach(x => STATE.room.setPlayerTeam(x.id, 1)); equipo2.forEach(x => STATE.room.setPlayerTeam(x.id, 2)); }
function segundosJugadosDe(p) { return STATE.baseDatos[getPlayerKey(p)]?.segundos_jugados || 0; }
function completarEquiposAutomatico(sa, rA, aA, eS) {
    if (sa.length === 0) return;
    const cs = [...sa].sort((a, b) => segundosJugadosDe(a) - segundosJugadosDe(b));
    let lR = Math.max(0, eS - rA.length), lA = Math.max(0, eS - aA.length);
    let nR = rA.length, nA = aA.length;
    let mR = rA.reduce((s, p) => s + (STATE.baseDatos[getPlayerKey(p)]?.mmr || 1000), 0);
    let mA = aA.reduce((s, p) => s + (STATE.baseDatos[getPlayerKey(p)]?.mmr || 1000), 0);
    for (const j of cs) {
        if (lR <= 0 && lA <= 0) break;
        const mm = STATE.baseDatos[getPlayerKey(j)]?.mmr || 1000;
        let vR;
        if (lR > 0 && lA > 0) {
            const pR = nR ? mR / nR : mm, pA = nA ? mA / nA : mm;
            const dR = Math.abs((mR + mm) / (nR + 1) - pA), dA = Math.abs(pR - (mA + mm) / (nA + 1));
            if (dR === dA) vR = nR < nA || (nR === nA && Math.random() < 0.5); else vR = dR < dA;
        } else vR = lR > 0;
        if (vR) { STATE.room.setPlayerTeam(j.id, 1); lR--; nR++; mR += mm; sendAnnouncement(`『𝗕𝗮𝗵𝗜𝗔』 → ${j.name} al rojo`, null, COLORES.info, "small", 0); }
        else { STATE.room.setPlayerTeam(j.id, 2); lA--; nA++; mA += mm; sendAnnouncement(`『𝗕𝗮𝗵𝗜𝗔』 → ${j.name} al azul`, null, COLORES.info, "small", 0); }
    }
}
function programarEventoAleatorio() {
    if (STATE.eventoTimer) clearTimeout(STATE.eventoTimer);
    STATE.eventoTimer = setTimeout(() => {
        if (STATE.partidoEnCurso && !STATE.eventoGolX2Activo) { STATE.eventoGolX2Activo = true; msgGame("🎲 El próximo gol vale x2 monedas", null, COLORES.oro, 2); }
        programarEventoAleatorio();
    }, 240000 + Math.floor(Math.random() * 180000));
}
function anunciarModoAutomatizado() { if (!CONFIG.AUTOMATED_MODE_ANNOUNCE || !STATE.room) return; sendAnnouncement("⚙️ Modo auto: mapas y equipos se arman solos", null, COLORES.info, "small", 0); }
function ejecutarAutomatizado(f) { if (!STATE.automatizadoActivado) return; try { _ejecutarAutomatizadoInterno(f); } catch (e) { logMsg('errors.log', `[${ROOM_ID}] Error auto: ${e.message}`); } }
function _ejecutarAutomatizadoInterno(forzarMezcla) {
    STATE.jueganTodosActivo = true; STATE.fairPlayActivo = false;
    const tA = STATE.room.getPlayerList().filter(p => !STATE.afkPlayers.has(p.id));
    const jA = tA.filter(p => !p.admin);
    if (tA.length === 0) return;
    const br = STATE.bracketFijo || getBracketAutomatizado(tA.length);
    STATE.maxPlayersPerTeam = br.equipoSize;
    const enC = tA.filter(p => p.team !== 0);
    const ro = enC.filter(p => p.team === 1).length, az = enC.filter(p => p.team === 2).length;
    const sa = jA.filter(p => p.team === 0);
    const desb = Math.abs(ro - az) >= 1;
    const aR = enC.filter(p => p.team === 1 && p.admin).length, aA = enC.filter(p => p.team === 2 && p.admin).length;
    if (!STATE.partidoEnCurso) {
        if (forzarMezcla && jA.length > 0) mezclarTodosAutomatico(jA, br.equipoSize, aR, aA);
        else if (jA.length >= 2) rebalancearAutomatico(jA, br.equipoSize, aR, aA);
    } else {
        const sc = STATE.ultimoMarcadorConocido;
        const ya = sc && ((sc.timeLimit > 0 && sc.time >= sc.timeLimit * 60) || (sc.scoreLimit > 0 && (sc.red >= sc.scoreLimit || sc.blue >= sc.scoreLimit)));
        if (ya) return;
        completarEquiposAutomatico(sa, enC.filter(p => p.team === 1), enC.filter(p => p.team === 2), br.equipoSize);
        const rf = STATE.room.getPlayerList();
        const rA = rf.filter(p => p.team === 1), aA2 = rf.filter(p => p.team === 2);
        if (Math.abs(rA.length - aA2.length) >= 2) {
            const eG = rA.length > aA2.length ? 1 : 2;
            const cd = (eG === 1 ? rA : aA2).filter(p => !p.admin);
            if (cd.length > 0) {
                const mR = rA.length ? rA.reduce((s, p) => s + (STATE.baseDatos[getPlayerKey(p)]?.mmr || 1000), 0) / rA.length : 1000;
                const mA = aA2.length ? aA2.reduce((s, p) => s + (STATE.baseDatos[getPlayerKey(p)]?.mmr || 1000), 0) / aA2.length : 1000;
                const or = [...cd].sort((a, b) => segundosJugadosDe(a) - segundosJugadosDe(b));
                const pool = or.slice(0, Math.max(3, Math.ceil(or.length / 2)));
                let me = pool[0], md = Infinity;
                for (const c of pool) {
                    const mc = STATE.baseDatos[getPlayerKey(c)]?.mmr || 1000;
                    const nG = eG === 1 ? rA.length : aA2.length, nC = (eG === 1 ? aA2 : rA).length;
                    const mG = eG === 1 ? mR : mA, mC = eG === 1 ? mA : mR;
                    const mGS = nG > 1 ? (mG * nG - mc) / (nG - 1) : mG;
                    const mCS = (mC * nC + mc) / (nC + 1);
                    const d = Math.abs(mGS - mCS);
                    if (d < md) { md = d; me = c; }
                }
                STATE.room.setPlayerTeam(me.id, eG === 1 ? 2 : 1);
            }
        }
    }
    const mp = br.mapas[Math.floor(Math.random() * br.mapas.length)];
    cambiarMapa(mp, CONFIG.GOLES_AUTOMATIZADO, CONFIG.TIEMPO_AUTOMATIZADO);
    if (!STATE.partidoEnCurso) {
        const ls = STATE.room.getPlayerList().filter(p => !p.admin && p.team !== 0);
        if (ls.length >= 1) setTimeout(() => { if (!STATE.partidoEnCurso && STATE.automatizadoActivado) STATE.room.startGame(); }, 1000);
    }
}
const BALANCE_EXACTO_MAX_JUGADORES = 16;
function particionExactaPorMmr(j, cap1) {
    const n = j.length, mm = j.map(p => STATE.baseDatos[getPlayerKey(p)]?.mmr || 1000);
    const tot = mm.reduce((a, b) => a + b, 0);
    let mD = Infinity, el = null, em = 0;
    const co = [];
    function bt(st, sum) {
        if (co.length === cap1) { const d = Math.abs(2 * sum - tot); if (d < mD) { mD = d; el = co.slice(); em = 1; } else if (d === mD) { em++; if (Math.random() < 1 / em) el = co.slice(); } return; }
        const f = cap1 - co.length;
        for (let i = st; i <= n - f; i++) { co.push(i); bt(i + 1, sum + mm[i]); co.pop(); }
    }
    bt(0, 0);
    const s = new Set(el || []);
    return { equipo1: j.filter((_, i) => s.has(i)), equipo2: j.filter((_, i) => !s.has(i)) };
}
function balancearEquiposElo(ps, eS = Infinity, r1 = 0, r2 = 0) {
    const tot = ps.length + r1 + r2;
    const tG = Math.ceil(tot / 2), tC = Math.floor(tot / 2);
    const rg = STATE.ultimoEquipoInicial === 1;
    STATE.ultimoEquipoInicial = rg ? 2 : 1;
    const t1 = rg ? tG : tC, t2 = rg ? tC : tG;
    const c1 = Math.max(0, Math.min(t1, eS) - r1), c2 = Math.max(0, Math.min(t2, eS) - r2);
    const so = [...ps].sort((a, b) => (STATE.baseDatos[getPlayerKey(b)]?.mmr || 1000) - (STATE.baseDatos[getPlayerKey(a)]?.mmr || 1000));
    const jg = so.slice(0, c1 + c2), sa = so.slice(c1 + c2);
    let e1, e2;
    if (jg.length > 0 && jg.length <= BALANCE_EXACTO_MAX_JUGADORES) ({ equipo1: e1, equipo2: e2 } = particionExactaPorMmr(jg, c1));
    else {
        e1 = []; e2 = []; let m1 = 0, m2 = 0;
        for (const p of jg) {
            const mm = STATE.baseDatos[getPlayerKey(p)]?.mmr || 1000;
            const cb1 = e1.length < c1, cb2 = e2.length < c2;
            let v1;
            if (!cb2) v1 = true; else if (!cb1) v1 = false;
            else if (m1 === m2) v1 = Math.random() < 0.5; else v1 = m1 < m2;
            if (v1) { e1.push(p); m1 += mm; } else { e2.push(p); m2 += mm; }
        }
    }
    const sm = e => e.reduce((s, p) => s + (STATE.baseDatos[getPlayerKey(p)]?.mmr || 1000), 0);
    return { equipo1: e1, equipo2: e2, sinAsignar: sa, mmr1: Math.round(sm(e1) / (e1.length || 1)), mmr2: Math.round(sm(e2) / (e2.length || 1)) };
}
function asignarCamisetas() {
    if (STATE.rainbowEquipoActivo) { restaurarCamisetaEquipo(STATE.rainbowEquipoActivo.team, STATE.rainbowEquipoActivo.colorOriginal); STATE.rainbowEquipoActivo = null; }
    const c1 = CAMISETAS[Math.floor(Math.random() * CAMISETAS.length)];
    let c2 = CAMISETAS[Math.floor(Math.random() * CAMISETAS.length)], i = 0;
    while (c2.name === c1.name && i < 5) { c2 = CAMISETAS[Math.floor(Math.random() * CAMISETAS.length)]; i++; }
    safeOperation(() => { STATE.room.setTeamColors(1, c1.angle ?? 90, textoContrasteCamiseta(c1.colors[0]), c1.colors); STATE.room.setTeamColors(2, c2.angle ?? 90, textoContrasteCamiseta(c2.colors[0]), c2.colors); });
    STATE.ultimasCamisetas = { cam1: c1, cam2: c2 };
    msgSmall(`🎽 Camisetas: ${c1.name} vs ${c2.name}`, null, COLORES.oro, "small-bold", 1);
}
function marcarCapitan(pid, esC) {
    if (esC) { safeOperation(() => STATE.room.setPlayerAvatar(pid, CONFIG.CAPITAN_AVATAR)); if (CONFIG.CAPITAN_SIZE_BONUS > 0) { const p = STATE.room.getPlayer(pid); if (p) aplicarTamanoPersistente(p); } }
    else { safeOperation(() => STATE.room.setPlayerAvatar(pid, null)); const p = STATE.room.getPlayer(pid); if (p) aplicarTamanoPersistente(p); }
}
function elegirCapitanEquipo(t) {
    const c = STATE.room.getPlayerList().filter(p => p.team === t && !STATE.afkPlayers.has(p.id));
    if (!c.length) return null;
    let me = c[0], mm = STATE.baseDatos[getPlayerKey(me)]?.mmr ?? 1000;
    for (const p of c) { const m = STATE.baseDatos[getPlayerKey(p)]?.mmr ?? 1000; if (m > mm) { me = p; mm = m; } }
    return me;
}
function asegurarCapitan(t, { anunciar = false } = {}) {
    const ai = STATE.capitanes[t], a = ai != null ? STATE.room.getPlayer(ai) : null;
    if (a && a.team === t) return a;
    if (ai != null) marcarCapitan(ai, false);
    STATE.capitanes[t] = null;
    const n = elegirCapitanEquipo(t); if (!n) return null;
    STATE.capitanes[t] = n.id;
    marcarCapitan(n.id, true);
    if (anunciar) msgSmall(`${CONFIG.CAPITAN_AVATAR} ${n.name} capitán del ${t === 1 ? "rojo 🔴" : "azul 🔵"}`, null, t === 1 ? 0xFF3366 : 0x00BFFF, "small-bold", 0);
    return n;
}
function asignarCapitanes() { limpiarCapitanes(); const r = asegurarCapitan(1), a = asegurarCapitan(2); const p = []; if (r) p.push(`🔴 ${r.name}`); if (a) p.push(`🔵 ${a.name}`); if (p.length) msgSmall(`${CONFIG.CAPITAN_AVATAR} Capitanes — ${p.join("  vs  ")}`, null, COLORES.oro, "small-bold", 1); }
function limpiarCapitanes() { for (const t of [1, 2]) { const id = STATE.capitanes[t]; if (id != null) marcarCapitan(id, false); STATE.capitanes[t] = null; } }
function getStats(p) { if (!p) return null; return STATE.baseDatos[getPlayerKey(p)] || null; }
function initStats(p) {
    const k = getPlayerKey(p);
    if (!STATE.baseDatos[k]) {
        const lk = k.startsWith("anon_conn_") ? `anon_${p.name.toLowerCase().trim().replace(/\s+/g, "_")}` : null;
        const lg = lk ? STATE.baseDatos[lk] : null;
        if (lg && !lg._reclamado) {
            STATE.baseDatos[k] = { ...lg, auth: STATE.authPorId.get(p.id) || p.auth || null };
            lg._reclamado = true; lg._reclamadoPor = k;
            markDirty(lk); markDirty(k);
            logMsg('security.log', `[${ROOM_ID}] Migración: "${p.name}" ${lk} -> ${k}`);
        } else {
            if (typeof STATE.siguienteIdPermanente !== "number") STATE.siguienteIdPermanente = 1;
            STATE.baseDatos[k] = {
                id_permanente: STATE.siguienteIdPermanente++, auth: STATE.authPorId.get(p.id) || p.auth || null,
                nombre_actual: p.name, mmr: 1000, peak_elo: 1000, titulo: "bronce1", max_rank: "bronce1",
                goles: 0, asistencias: 0, autogoles: 0, partidos: 0, victorias: 0, derrotas: 0, empates: 0,
                racha: 0, mejor_racha: 0, mvps: 0, monedas: 100, xp: 0, nivel: 1, badges: [],
                warnings: 0, ragequits: 0, fair_play: 100, jugando: false, campeonatos: [], historial: [],
                misiones: { fecha: null, goles: 0, partidos: 0, completadas: [] }, misionSemanal: { semana: null, partidos: 0, completada: false },
                temporada: STATE.TEMPORADA_ACTUAL, primera_vez: Date.now(), intro_vista: false, ultima_vez: Date.now(),
                powershots_exitosos: 0, inventario: [], titulo_custom: null, color_nombre: null, color_custom_desbloqueado: false,
                boost_xp_activo: false, escudo_mmr_activo: false, festejo_fuego_activo: false, clan: null,
                historial_vs: {}, favoritos: [], rivales: [], streak_dias: 0, ultimo_login: null,
                duelos_ganados: 0, duelos_perdidos: 0, vallas_invictas: 0, atajadas: 0, apuestas_realizadas: 0,
                vip: false, rango: "normal", vip_tortu: false, vip_perma: false, vip_expira: null, vip_tier: "vip",
                warns_hoy: 0, warns_fecha: null, ban_hasta: 0, blacklisted: false, msg_join: null, msg_leave: null,
                discord_verificado: false, discord_id: null, discord_tag: null, segundos_jugados: 0, tamano_personalizado: CONFIG.TAMANO_DEFAULT
            };
            markDirty(k);
        }
    }
    const s = STATE.baseDatos[k];
    if (s.rango === undefined) s.rango = "normal";
    if (s.vip_tortu === undefined) s.vip_tortu = false;
    if (s.vip_perma === undefined) s.vip_perma = false;
    if (s.vip_expira === undefined) s.vip_expira = null;
    if (s.vip_tier === undefined) s.vip_tier = "vip";
    if (s.warns_hoy === undefined) s.warns_hoy = 0;
    if (s.warns_fecha === undefined) s.warns_fecha = null;
    if (s.ban_hasta === undefined) s.ban_hasta = 0;
    if (s.blacklisted === undefined) s.blacklisted = false;
    if (s.msg_join === undefined) s.msg_join = null;
    if (s.msg_leave === undefined) s.msg_leave = null;
    if (s.segundos_jugados === undefined) s.segundos_jugados = 0;
    if (s.color_custom_desbloqueado === undefined) s.color_custom_desbloqueado = false;
    if (s.festejo_fuego_activo === undefined) s.festejo_fuego_activo = false;
    if (s.discord_verificado === undefined) s.discord_verificado = false;
    if (s.discord_id === undefined) s.discord_id = null;
    if (s.discord_tag === undefined) s.discord_tag = null;
    if (s.tamano_personalizado === undefined) s.tamano_personalizado = CONFIG.TAMANO_DEFAULT;
    if (s.peak_elo === undefined) s.peak_elo = s.mmr || 1000;
    if (!Array.isArray(s.historial)) s.historial = [];
    if (s.autogoles === undefined) s.autogoles = 0;
    if (!s.historial_vs || typeof s.historial_vs !== "object") s.historial_vs = {};
    if (s.ragequits === undefined) s.ragequits = 0;
    if (s.intro_vista === undefined) s.intro_vista = true;
    if (s.vip_tortu) { s.vip = true; s.vip_tortu = false; markDirty(k); }
    if (!s.vip_perma && s.vip_expira && Date.now() > s.vip_expira) { s.vip = false; s.vip_expira = null; markDirty(k); }
    if (s.nombre_actual !== p.name) { s.nombre_actual = p.name; markDirty(k); }
    s.ultima_vez = Date.now();
    return s;
}
function resolverBlackjack(player, porExp = false) {
    const m = STATE.blackjackActivo[player.id]; if (!m) return;
    delete STATE.blackjackActivo[player.id];
    const s = STATE.baseDatos[m.key]; if (!s) return;
    const cart = () => Math.min(11, Math.floor(Math.random() * 10) + 2);
    const tJ = m.manoJugador.reduce((a, b) => a + b, 0);
    let mC = [...m.manoCasa], tC = mC.reduce((a, b) => a + b, 0);
    while (tC < 17) { mC.push(cart()); tC = mC.reduce((a, b) => a + b, 0); }
    let res, pre = 0;
    if (tC > 21) { pre = m.cantidad * 2; res = `La casa se pasó (${tC}). Vos ${tJ}. ¡Ganaste ${pre}💰!`; }
    else if (tJ > tC) { pre = m.cantidad * 2; res = `Vos ${tJ} vs Casa ${tC}. ¡Ganaste ${pre}💰!`; }
    else if (tJ === tC) { pre = m.cantidad; res = `Empate. Recuperás tu apuesta.`; }
    else res = `Vos ${tJ} vs Casa ${tC}. Perdiste ${m.cantidad}💰`;
    if (pre > 0) s.monedas += pre;
    markDirty(m.key);
    msgBox(`🃏 BLACKJACK`, [`${porExp ? "⌛ Auto-plantaste\n" : ""}Cartas casa: ${mC.join(" + ")}`, res], pre > m.cantidad ? 0x00FF88 : (pre === m.cantidad ? 0xFFD700 : 0xFF3366), "small-bold", 1, player.id);
}
function dejarArquero(p) {
    const era = STATE.gkReservado[1] === p.id || STATE.gkReservado[2] === p.id;
    if (!era) return msgError("No sos arquero reservado", p.id);
    if (STATE.gkReservado[1] === p.id) STATE.gkReservado[1] = null;
    if (STATE.gkReservado[2] === p.id) STATE.gkReservado[2] = null;
    aplicarTamanoPersistente(p);
    msgMini(`${p.name} colgó los guantes`, p.id, COLORES.info, 0);
}
// ── Helpers de ban global ──
function aplicarBanGlobal(key, ms) {
    const s = STATE.baseDatos[key]; if (!s) return;
    s.ban_hasta = Date.now() + ms;
    markDirty(key);
    upsertPlayerBan(key, { ban_hasta: s.ban_hasta, blacklisted: s.blacklisted || false }, ROOM_ID, false);
}
function quitarBanGlobal(key) {
    const s = STATE.baseDatos[key]; if (!s) return;
    s.ban_hasta = 0;
    markDirty(key);
    // Solo la columna ban_hasta, sin tocar blacklisted de la otra sala.
    upsertPlayerBanParcial(key, { ban_hasta: 0 }, ROOM_ID);
}
function setBlacklistGlobal(key, valor) {
    const s = STATE.baseDatos[key]; if (!s) return;
    s.blacklisted = valor;
    markDirty(key);
    upsertPlayerBanParcial(key, { blacklisted: valor }, ROOM_ID);
}
function modificarFairPlay(player, cantidad, razon) {
    const k = getPlayerKey(player);
    const s = STATE.baseDatos[k]; if (!s) return;
    s.fair_play = Math.max(0, Math.min(100, s.fair_play + cantidad));
    if (cantidad < 0) msgWarn(`${player.name}: ${cantidad} FP (${razon}). Total: ${s.fair_play}/100`, null);
    if (s.fair_play >= 90 && !s.badges.includes("fair_play")) darBadge(player, "fair_play");
    markDirty(k);
}

// ─── COMANDOS ───
const commands = {
    "!clave": (p, args) => {
        const key = getPlayerKey(p);
        const b = STATE.authIntentos?.[key], ahora = Date.now();
        if (b && b.hasta > ahora) { const r = Math.ceil((b.hasta - ahora) / 1000); return msgError(`Demasiados intentos. Probá en ${r}s`, p.id); }
        if (args[0] === CONFIG.ADMIN_PASSWORD) {
            if (STATE.authIntentos) delete STATE.authIntentos[key];
            STATE.room.setPlayerAdmin(p.id, true);
            msgBox("👑 Ahora sos admin", [`${p.name} es admin`], COLORES.oro, "small-bold", 2, p.id);
            logMsg('auth.log', `[${ROOM_ID}] Login OK: ${p.name} (${key})`);
            auditLog(p, "LOGIN_ADMIN_OK", p.name);
        } else {
            if (!STATE.authIntentos) STATE.authIntentos = {};
            const i = STATE.authIntentos[key] || { fallos: 0, hasta: 0 };
            i.fallos++;
            if (i.fallos >= 5) { i.hasta = ahora + 300000; i.fallos = 0; }
            STATE.authIntentos[key] = i;
            msgError("Contraseña incorrecta", p.id);
            logMsg('auth.log', `[${ROOM_ID}] Login FALLIDO: ${p.name} (${key})`);
        }
    },
    "!jugar": (p) => {
        if (STATE.partidoEnCurso && !STATE.jueganTodosActivo && !STATE.automatizadoActivado) return msgWarn("Partido en curso", p.id);
        const ahora = Date.now();
        const cdAfk = STATE.afkCooldown.get(getPlayerKey(p));
        if (cdAfk && ahora < cdAfk) { const r = Math.ceil((cdAfk - ahora) / 1000); return msgError(`Saliste de AFK hace poco, esperá ${r}s`, p.id); }
        const ult = STATE.ultimoJugar[p.id];
        if (ult && ahora - ult < CONFIG.JUGAR_COOLDOWN_MS) { const r = Math.ceil((CONFIG.JUGAR_COOLDOWN_MS - (ahora - ult)) / 1000); return msgError(`Esperá ${r}s`, p.id); }
        STATE.ultimoJugar[p.id] = ahora;
        const r = STATE.room.getPlayerList().filter(x => x.team === 1).length;
        const b = STATE.room.getPlayerList().filter(x => x.team === 2).length;
        STATE.room.setPlayerTeam(p.id, r <= b ? 1 : 2);
        setTimeout(() => aplicarTamanoPersistente(p), 100);
        msgSuccess(`${p.name} entró a la cancha!`, p.id);
    },
    "!ver": (p) => { STATE.room.setPlayerTeam(p.id, 0); msgSmall(`👀 ${p.name} a suplentes`, p.id, COLORES.advertencia, "small", 1); },
    "!tiempo": (p) => {
        if (!STATE.partidoEnCurso || !STATE.ultimoMarcadorConocido) return msgError("Sin partido activo", p.id);
        const t = Math.max(0, (STATE.ultimoMarcadorConocido.timeLimit * 60) - STATE.ultimoMarcadorConocido.time);
        sendAnnouncement(`⏱️ ${formatTime(t)} · ${STATE.ultimoMarcadorConocido.red}-${STATE.ultimoMarcadorConocido.blue}`, p.id, COLORES.info, "small-bold", 0);
    },
    "!equipos": (p) => {
        const ps = STATE.room.getPlayerList();
        sendAnnouncement(`🔴 ROJO: ${ps.filter(x => x.team === 1).map(x => x.name).join(", ") || "Vacío"}\n🔵 AZUL: ${ps.filter(x => x.team === 2).map(x => x.name).join(", ") || "Vacío"}\n👀 SPEC: ${ps.filter(x => x.team === 0).map(x => x.name).join(", ") || "Vacío"}`, p.id, 0xFFFFFF, "small-bold", 0);
    },
    "!vivo": (p) => {
        if (!STATE.partidoEnCurso) return msgError("Sin partido", p.id);
        const t = STATE.room.getPlayerList().filter(x => x.team !== 0).map(pl => { const ms = STATE.matchStats[pl.id] || { goles: 0, asistencias: 0 }; return `${pl.team === 1 ? "🔴" : "🔵"} ${pl.name}: ${ms.goles}G ${ms.asistencias}A`; }).join("\n");
        sendAnnouncement(`📊 STATS EN VIVO:\n${t || "Sin stats"}`, p.id, COLORES.info, "small-bold", 0);
    },
    "!perfil": (p, args) => {
        let target = p, key = getPlayerKey(p);
        if (args.length) { const r = resolverJugadorYResto(args); if (!r.key) return msgError("No encontré a ese jugador", p.id); target = r.target; key = r.key; }
        const s = STATE.baseDatos[key]; if (!s) return msgError("Perfil no encontrado", p.id);
        const t = obtenerTituloPorKey(key), b = obtenerBadgesPorKey(key);
        const wr = s.partidos > 0 ? Math.round((s.victorias / s.partidos) * 100) : 0;
        const n = target ? target.name : s.nombre_actual;
        const ver = s.discord_verificado ? " 🔗" : "";
        const sig = getSiguienteRango(s.titulo || "bronce1");
        const prog = sig ? `próximo: ${sig.nombre} (faltan ${Math.max(0, sig.req - s.mmr)} ELO)` : "rango máximo";
        msgCaja(`👤 ${n}${ver} · ${formatTituloDisplay(t)} ${b}`, [
            `🆔 ${s.id_permanente ?? "?"}`,
            `📊 ELO ${s.mmr} (Nv ${s.nivel}) · ${s.victorias}V-${s.derrotas}D-${s.empates}E (${wr}%)`,
            `↳ ${prog}`,
            `⚽ Goles ${s.goles} · 🎁 Asistencias ${s.asistencias} · 🌟 MVPs ${s.mvps || 0}`,
            `💰 ${s.monedas} · 🔥 Racha ${s.racha} (mejor ${s.mejor_racha || 0}) · 🎮 ${s.partidos} partidos`,
        ], t.color, "small", 0, p.id);
    },
    "!rango": (p) => {
        const s = STATE.baseDatos[getPlayerKey(p)], t = obtenerTitulo(p);
        const sig = getSiguienteRango(s.titulo || "bronce1");
        const prog = sig ? ` · faltan ${Math.max(0, sig.req - s.mmr)} ELO para ${sig.nombre}` : " · rango máximo";
        sendAnnouncement(`${formatTituloDisplay(t)} • ${p.name} · ELO ${s.mmr} · Nv ${s.nivel}${prog}`, p.id, t.color, "small", 0);
    },
    "!vs": (p, args) => {
        if (!args.length) return msgError("Uso: !vs [jugador]", p.id);
        const { target } = resolverJugadorYResto(args);
        if (!target) return msgError("No encontré a ese jugador conectado", p.id);
        if (target.id === p.id) return msgError("No podés compararte con vos mismo", p.id);
        const s = STATE.baseDatos[getPlayerKey(p)];
        const h = s.historial_vs?.[getPlayerKey(target)];
        if (!h || (h.victorias + h.derrotas + h.empates) === 0) return msgInfo(`Todavía no jugaste contra ${target.name}`, p.id);
        const tot = h.victorias + h.derrotas + h.empates;
        sendAnnouncement(`⚔️ ${p.name} VS ${target.name}\n🟢 ${h.victorias}V 🔴 ${h.derrotas}D ⚪ ${h.empates}E (${tot}, ${Math.round((h.victorias / tot) * 100)}%)`, p.id, COLORES.advertencia, "small", 0);
    },
    "!tabla": (p) => {
        const top = Object.values(STATE.baseDatos).sort((a, b) => b.mmr - a.mmr).slice(0, 5).map((s, i) => `${i + 1}. ${getTituloSeguro(s.titulo).nombre} ${s.nombre_actual} - ${s.mmr}`);
        top.push(footerRanking());
        msgCaja(`🏆 Top 5 · Temporada ${STATE.TEMPORADA_ACTUAL}`, top, COLORES.oro, "small", 0, p.id);
    },
    "!goles": (p) => { const t = Object.values(STATE.baseDatos).filter(s => s.goles > 0).sort((a, b) => b.goles - a.goles).slice(0, 10).map((s, i) => `${i + 1}. ${s.nombre_actual} — ⚽ ${s.goles}`); msgBox(`${EMOJIS.soccer} TOP GOLEADORES`, t.length ? [...t, footerRanking()] : ["Nadie metió goles"], COLORES.oro, "small", 0, p.id); },
    "!asist": (p) => { const t = Object.values(STATE.baseDatos).filter(s => s.asistencias > 0).sort((a, b) => b.asistencias - a.asistencias).slice(0, 10).map((s, i) => `${i + 1}. ${s.nombre_actual} — 🎯 ${s.asistencias}`); msgBox("🎯 TOP ASISTIDORES", t.length ? [...t, footerRanking()] : ["Sin asistencias"], COLORES.info, "small", 0, p.id); },
    "!figuras": (p) => { const t = Object.values(STATE.baseDatos).filter(s => s.mvps > 0).sort((a, b) => b.mvps - a.mvps).slice(0, 10).map((s, i) => `${i + 1}. ${s.nombre_actual} — 🌟 ${s.mvps}`); msgBox("🌟 TOP MVPS", t.length ? [...t, footerRanking()] : ["Nadie fue MVP"], COLORES.morado, "small", 0, p.id); },
    "!partidos": (p) => { const t = Object.values(STATE.baseDatos).filter(s => s.partidos > 0).sort((a, b) => b.partidos - a.partidos).slice(0, 10).map((s, i) => `${i + 1}. ${s.nombre_actual} — 🎮 ${s.partidos}`); msgBox("🎮 TOP PARTIDAS", t.length ? [...t, footerRanking()] : ["Sin partidos"], COLORES.exito, "small", 0, p.id); },
    "!vallas": (p) => { const t = Object.values(STATE.baseDatos).filter(s => s.vallas_invictas > 0).sort((a, b) => b.vallas_invictas - a.vallas_invictas).slice(0, 10).map((s, i) => `${i + 1}. ${s.nombre_actual} — 🧤 ${s.vallas_invictas}`); msgBox("🧤 VALLAS INVICTAS", t.length ? [...t, footerRanking()] : ["Sin vallas"], COLORES.azul, "small", 0, p.id); },
    "!atajadas": (p) => { const t = Object.values(STATE.baseDatos).filter(s => s.atajadas > 0).sort((a, b) => b.atajadas - a.atajadas).slice(0, 10).map((s, i) => `${i + 1}. ${s.nombre_actual} — 🧤✋ ${s.atajadas}`); msgBox("🧤✋ TOP ATAJADAS", t.length ? [...t, footerRanking()] : ["Sin atajadas"], COLORES.diamante, "small", 0, p.id); },
    "!horas": (p) => { const t = Object.values(STATE.baseDatos).filter(s => s.segundos_jugados > 0).sort((a, b) => b.segundos_jugados - a.segundos_jugados).slice(0, 10).map((s, i) => `${i + 1}. ${s.nombre_actual} — ⏳ ${formatTime(s.segundos_jugados)}`); msgBox(`${EMOJIS.clock} TOP TIEMPO`, t.length ? [...t, footerRanking()] : ["Sin datos"], COLORES.advertencia, "small", 0, p.id); },
    "!monedas": (p) => { const t = Object.values(STATE.baseDatos).sort((a, b) => b.monedas - a.monedas).slice(0, 10).map((s, i) => `${i + 1}. ${s.nombre_actual} — 💰 ${s.monedas}`); msgBox("💰 TOP MONEDAS", t.length ? [...t, footerRanking()] : ["Sin datos"], COLORES.oro, "small", 0, p.id); },
    "!efec": (p) => { const t = Object.values(STATE.baseDatos).filter(s => s.partidos >= 3).sort((a, b) => (b.victorias / b.partidos) - (a.victorias / a.partidos)).slice(0, 10).map((s, i) => `${i + 1}. ${s.nombre_actual} — 📊 ${Math.round((s.victorias / s.partidos) * 100)}% (${s.partidos} PJ)`); msgBox("📊 WINRATE (mín. 3)", t.length ? [...t, footerRanking()] : ["Nadie con 3 partidos"], COLORES.verde, "small", 0, p.id); },
    "!tienda": (p, args) => {
        const key = getPlayerKey(p), stats = STATE.baseDatos[key];
        if (args[0] === "exclusivo") {
            const lista = Object.entries(TITULOS_EXCLUSIVOS).map(([id, t]) => { const dk = STATE.titulosExclusivos[id]; const d = dk ? (STATE.baseDatos[dk]?.nombre_actual || "??") : "nadie"; return `${t.nombre} — ${t.precio}💰 (dueño: ${d}) → !tienda comprar ${id}`; });
            return msgCaja("👑 Títulos exclusivos", ["Sólo 1 persona puede tener cada uno", ...lista], COLORES.oro, "small", 0, p.id);
        }
        if (args[0] === "comprar" && args[1]) {
            const id = args[1].toLowerCase();
            if (TITULOS_EXCLUSIVOS[id]) {
                const ex = TITULOS_EXCLUSIVOS[id];
                if (STATE.titulosExclusivos[id] === key) return msgError("Ya sos vos el dueño", p.id);
                if (stats.monedas < ex.precio) return msgError(`Te faltan ${ex.precio - stats.monedas}💰`, p.id);
                stats.monedas -= ex.precio;
                const dk = STATE.titulosExclusivos[id];
                if (dk && STATE.baseDatos[dk]) { STATE.baseDatos[dk].titulo_custom = null; invalidarCache("titulos", dk); }
                stats.titulo_custom = ex.nombre; STATE.titulosExclusivos[id] = key; invalidarCache("titulos", key);
                msgSmall(`👑 ${p.name} ahora es ${ex.nombre}`, p.id, ex.color, "small", 1);
                auditLog(p, "BUY_TITLE", ex.nombre);
                return markDirty(key);
            }
            const item = TIENDA_ITEMS[id];
            if (!item) return msgError("Ese ítem no existe", p.id);
            if (id === "escudo_mmr" && stats.escudo_mmr_activo) return msgError("Ya tenés Escudo activo", p.id);
            if (id === "boost_xp" && stats.boost_xp_activo) return msgError("Ya tenés Boost activo", p.id);
            if (id === "revivir_racha" && stats.racha >= stats.mejor_racha) return msgError("Tu racha actual es la mejor", p.id);
            if (id === "titulo_custom" && args.length < 3) return msgError("Uso: !tienda comprar titulo_custom [texto]", p.id);
            if (id === "festejo_fuego" && (stats.vip || stats.festejo_fuego_activo)) return msgError(stats.vip ? "Ya sos VIP" : "Ya tenés un Festejo pendiente", p.id);
            if (stats.monedas < item.precio) return msgError(`Te faltan ${item.precio - stats.monedas}💰`, p.id);
            stats.monedas -= item.precio;
            if (id === "escudo_mmr") stats.escudo_mmr_activo = true;
            else if (id === "boost_xp") stats.boost_xp_activo = true;
            else if (id === "revivir_racha") stats.racha = stats.mejor_racha;
            else if (id === "festejo_fuego") stats.festejo_fuego_activo = true;
            else if (id === "titulo_custom" && args[2]) { stats.titulo_custom = args.slice(2).join(" ").slice(0, 30); invalidarCache("titulos", key); }
            msgSuccess(`Compraste ${item.nombre} · Te quedan ${stats.monedas}💰`, p.id);
            markDirty(key);
        } else {
            const est = (id) => {
                if (id === "escudo_mmr") return stats.escudo_mmr_activo ? " ✅ activo" : "";
                if (id === "boost_xp") return stats.boost_xp_activo ? " ✅ activo" : "";
                if (id === "titulo_custom") return stats.titulo_custom ? ` ✅ "${stats.titulo_custom}"` : "";
                if (id === "festejo_fuego") return stats.vip ? " ✅ por ser VIP" : (stats.festejo_fuego_activo ? " ✅ activo" : "");
                return "";
            };
            const porCat = {};
            Object.entries(TIENDA_ITEMS).forEach(([id, it]) => { const c = it.categoria || "Otros"; (porCat[c] = porCat[c] || []).push(`${it.nombre} — ${it.precio}💰 · ${it.desc}${est(id)}\n   ↳ !tienda comprar ${id}`); });
            const bl = Object.entries(porCat).map(([c, l]) => `▸ ${c}\n${l.join("\n")}`).join("\n\n");
            sendAnnouncement(`🛒 Tienda · Tenés 💰${stats.monedas}\n\n${bl}\n\n👑 !tienda exclusivo para títulos únicos`, p.id, COLORES.oro, "small", 0);
        }
    },
    "!enviar": (p, args) => {
        if (args.length < 2) return msgError("Uso: !enviar [jug] [cant]", p.id);
        const c = parseInt(args[args.length - 1], 10);
        if (!validarCantidad(c, 10)) return msgError("Mínimo 10💰", p.id);
        const k = getPlayerKey(p), s = STATE.baseDatos[k];
        if (s.monedas < c) return msgError(`Tenés ${s.monedas}💰`, p.id);
        const tk = findPlayerKeyByName(args.slice(0, -1).join(" "));
        if (!tk || tk === k) return msgError("Jugador inválido", p.id);
        const ts = STATE.baseDatos[tk]; if (!ts) return msgError("Jugador inválido", p.id);
        s.monedas -= c; ts.monedas += c;
        msgSuccess(`Le enviaste ${c}💰 a ${ts.nombre_actual}`, p.id);
        const on = findOnlinePlayer(ts.nombre_actual);
        if (on) msgSuccess(`${p.name} te envió ${c}💰`, on.id);
        markDirty(k); markDirty(tk);
    },
    "!apostar": (p, args) => {
        if (STATE.partidoEnCurso) return msgError("Durante partido no", p.id);
        if (args.length < 2) return msgError("Uso: !apostar [rojo/azul/empate] [cant]", p.id);
        const el = args[0].toLowerCase(), c = parseInt(args[1], 10);
        if (!validarCantidad(c, 1, CONFIG.MAX_APUESTA)) return msgError(`1-${CONFIG.MAX_APUESTA}💰`, p.id);
        const k = getPlayerKey(p), s = STATE.baseDatos[k];
        if (s.monedas < c) return msgError(`Tenés ${s.monedas}💰`, p.id);
        let team;
        if (["rojo", "red"].includes(el)) team = 1;
        else if (["azul", "blue"].includes(el)) team = 2;
        else if (["empate", "draw"].includes(el)) team = 0;
        else return msgError("Uso: !apostar [rojo/azul/empate] [cant]", p.id);
        s.monedas -= c;
        STATE.apuestas[p.id] = { key: k, equipo: team, cantidad: c };
        s.apuestas_realizadas = (s.apuestas_realizadas || 0) + 1;
        if (s.apuestas_realizadas >= 20 && !s.badges.includes("apostador")) darBadge(p, "apostador");
        msgSmall(`🎰 Apostaste ${c}💰`, p.id, COLORES.oro, "small", 1);
        markDirty(k);
    },
    "!casino": (p) => { sendAnnouncement(`🎰 CASINO\n\n🪙 !moneda [cant] · 50%: x${CONFIG.CUOTA_APUESTA}\n🃏 !veintiuno [cant] · !pedir/!plantar · x2\n🎡 !ruleta [rojo/negro/verde] [cant] · Rojo/Negro x2 · Verde x${CONFIG.RULETA_VERDE_PAYOUT}\n⚽ !apostar · al final del partido\n⚔️ !duelo [jug] [cant]`, p.id, COLORES.oro, "small", 0); },
    "!moneda": (p, args) => {
        if (!args[0]) return msgError("Uso: !moneda [cantidad]", p.id);
        const c = parseInt(args[0], 10);
        if (!validarCantidad(c, 1, CONFIG.MAX_MONEDA)) return msgError(`1-${CONFIG.MAX_MONEDA}💰`, p.id);
        const k = getPlayerKey(p), s = STATE.baseDatos[k];
        if (s.monedas < c) return msgError(`No te alcanza`, p.id);
        s.monedas -= c;
        s.apuestas_realizadas = (s.apuestas_realizadas || 0) + 1;
        if (s.apuestas_realizadas >= 20 && !s.badges.includes("apostador")) darBadge(p, "apostador");
        if (Math.random() < 0.5) { const pr = Math.round(c * CONFIG.CUOTA_APUESTA); s.monedas += pr; msgBox(`🪙 Cara — ganaste`, [`+${pr}💰`], COLORES.exito, "small", 1, p.id); }
        else msgSmall(`🪙 Ceca — perdiste ${c}💰`, p.id, COLORES.error, "small", 1);
        markDirty(k);
    },
    "!veintiuno": (p, args) => {
        if (STATE.blackjackActivo[p.id]) return msgError("Ya tenés mano en curso", p.id);
        if (!args[0]) return msgError("Uso: !veintiuno [cantidad]", p.id);
        const c = parseInt(args[0], 10);
        if (!validarCantidad(c, 1, CONFIG.MAX_BLACKJACK)) return msgError(`1-${CONFIG.MAX_BLACKJACK}💰`, p.id);
        const k = getPlayerKey(p), s = STATE.baseDatos[k];
        if (s.monedas < c) return msgError(`No te alcanza`, p.id);
        s.monedas -= c;
        s.apuestas_realizadas = (s.apuestas_realizadas || 0) + 1;
        if (s.apuestas_realizadas >= 20 && !s.badges.includes("apostador")) darBadge(p, "apostador");
        markDirty(k);
        const cart = () => Math.min(11, Math.floor(Math.random() * 10) + 2);
        const mJ = [cart(), cart()], mC = [cart(), cart()];
        const tJ = mJ.reduce((a, b) => a + b, 0);
        if (tJ === 21) { const pr = Math.round(c * 2.5); s.monedas += pr; markDirty(k); return msgBox(`🃏🔥 ¡BLACKJACK NATURAL!`, [`Tus cartas: ${mJ.join(" + ")} = 21`, `¡Redondo! ${pr}💰`], COLORES.exito, "small", 1, p.id); }
        STATE.blackjackActivo[p.id] = { cantidad: c, manoJugador: mJ, manoCasa: mC, key: k, expira: Date.now() + 45000 };
        setTimeout(() => { if (STATE.blackjackActivo[p.id]?.expira && STATE.blackjackActivo[p.id].expira <= Date.now()) resolverBlackjack(p, true); }, 45000);
        msgBox(`🃏 BLACKJACK`, [`Tus cartas: ${mJ.join(" + ")} = ${tJ}`, `Casa visible: ${mC[0]}`, `!pedir o !plantar`], COLORES.oro, "small", 1, p.id);
    },
    "!pedir": (p) => {
        const m = STATE.blackjackActivo[p.id]; if (!m) return msgError("No tenés mano activa", p.id);
        m.manoJugador.push(Math.min(11, Math.floor(Math.random() * 10) + 2));
        const t = m.manoJugador.reduce((a, b) => a + b, 0);
        if (t > 21) { delete STATE.blackjackActivo[p.id]; return msgBox(`🃏 ¡Te pasaste!`, [`Tus cartas: ${m.manoJugador.join(" + ")} = ${t}`, `Perdiste ${m.cantidad}💰`], COLORES.error, "small", 1, p.id); }
        m.expira = Date.now() + 45000;
        msgSmall(`🃏 Tus cartas: ${m.manoJugador.join(" + ")} = ${t}`, p.id, COLORES.oro, "small", 0);
    },
    "!plantar": (p) => { if (!STATE.blackjackActivo[p.id]) return msgError("No tenés mano activa", p.id); resolverBlackjack(p, false); },
    "!ruleta": (p, args) => {
        const col = (args[0] || "").toLowerCase();
        const cm = { rojo: "rojo", red: "rojo", negro: "negro", black: "negro", verde: "verde", green: "verde" };
        if (!cm[col]) return msgError("Uso: !ruleta [rojo/negro/verde] [cantidad]", p.id);
        const c = parseInt(args[1], 10);
        if (!validarCantidad(c, 1, CONFIG.MAX_RULETA)) return msgError(`1-${CONFIG.MAX_RULETA}💰`, p.id);
        const k = getPlayerKey(p), s = STATE.baseDatos[k];
        if (s.monedas < c) return msgError(`No te alcanza`, p.id);
        s.monedas -= c;
        s.apuestas_realizadas = (s.apuestas_realizadas || 0) + 1;
        if (s.apuestas_realizadas >= 20 && !s.badges.includes("apostador")) darBadge(p, "apostador");
        const r = Math.random();
        const sal = r < 0.027 ? "verde" : (r < 0.513 ? "rojo" : "negro");
        const el = cm[col];
        const em = { rojo: "🔴", negro: "⚫", verde: "🟢" };
        let pr = 0;
        if (el === sal) pr = el === "verde" ? c * CONFIG.RULETA_VERDE_PAYOUT : c * CONFIG.RULETA_ROJO_NEGRO_PAYOUT;
        if (pr > 0) { s.monedas += pr; msgBox(`🎡✨ Salió ${em[sal]} ${sal.toUpperCase()}`, [`¡La pegaste! +${pr}💰`], COLORES.exito, "small", 1, p.id); }
        else msgSmall(`🎡 Salió ${em[sal]} ${sal.toUpperCase()}, perdiste ${c}💰`, p.id, COLORES.error, "small", 1);
        markDirty(k);
    },
    "!duelo": (p, args) => {
        if (args.length < 2) return msgError("Uso: !duelo [jugador] [cant]", p.id);
        const { target, resto } = resolverJugadorYResto(args);
        if (!target || target.id === p.id) return msgError("Jugador inválido", p.id);
        const c = parseInt(resto[0], 10);
        if (!validarCantidad(c, 1, CONFIG.MAX_DUELO)) return msgError(`1-${CONFIG.MAX_DUELO}💰`, p.id);
        const k = getPlayerKey(p), s = STATE.baseDatos[k];
        if (s.monedas < c) return msgError(`Tenés ${s.monedas}💰`, p.id);
        const ts = STATE.baseDatos[getPlayerKey(target)];
        if (!ts || ts.monedas < c) return msgError(`${target.name} no tiene suficiente💰`, p.id);
        if (STATE.duelosActivos.find(d => d.retado === target.id)) return msgError("Ese jugador ya tiene duelo pendiente", p.id);
        s.monedas -= c; markDirty(k);
        STATE.duelosActivos.push({ retador: p.id, retado: target.id, cantidad: c, retadorKey: k, expira: Date.now() + 30000 });
        msgBox(`⚔️ ¡DUELO!`, [`${p.name} te retó`, `Apuesta: ${c}💰`, `!aceptar o !rechazar`], COLORES.advertencia, "small", 2, target.id);
        msgBox(`⚔️ ¡DUELO!`, [`Retaste a ${target.name}`, `${c}💰`, `Esperando...`], COLORES.advertencia, "small", 2, p.id);
        setTimeout(() => {
            const idx = STATE.duelosActivos.findIndex(d => d.retador === p.id && d.retado === target.id);
            if (idx !== -1) { const d = STATE.duelosActivos[idx]; STATE.duelosActivos.splice(idx, 1); const st = STATE.baseDatos[d.retadorKey]; if (st) { st.monedas += d.cantidad; markDirty(d.retadorKey); } msgSmall(`⌛ Duelo expirado`, p.id, COLORES.error, "small", 1); msgSmall(`⌛ Duelo expirado`, target.id, COLORES.error, "small", 0); }
        }, 30000);
    },
    "!aceptar": (p) => {
        const idx = STATE.duelosActivos.findIndex(d => d.retado === p.id);
        if (idx === -1) return msgError("No tenés duelos pendientes", p.id);
        const d = STATE.duelosActivos[idx]; STATE.duelosActivos.splice(idx, 1);
        const rt = STATE.room.getPlayer(d.retador);
        if (!rt) { const st = STATE.baseDatos[d.retadorKey]; if (st) { st.monedas += d.cantidad; markDirty(d.retadorKey); } return msgError("El retador ya no está", p.id); }
        const sA = STATE.baseDatos[getPlayerKey(rt)], sB = STATE.baseDatos[getPlayerKey(p)];
        if (!sA || !sB || sB.monedas < d.cantidad) { if (sA) { sA.monedas += d.cantidad; markDirty(getPlayerKey(rt)); } return msgError("No tenés suficiente💰", p.id); }
        sB.monedas -= d.cantidad;
        const pr = 1 / (1 + Math.pow(10, (sB.mmr - sA.mmr) / 400));
        const gr = Math.random() < pr;
        const tot = d.cantidad * 2;
        if (gr) sA.monedas += tot; else sB.monedas += tot;
        sA.duelos_ganados = (sA.duelos_ganados || 0) + (gr ? 1 : 0);
        sA.duelos_perdidos = (sA.duelos_perdidos || 0) + (gr ? 0 : 1);
        sB.duelos_ganados = (sB.duelos_ganados || 0) + (gr ? 0 : 1);
        sB.duelos_perdidos = (sB.duelos_perdidos || 0) + (gr ? 1 : 0);
        const gan = gr ? rt : p, per = gr ? p : rt;
        msgBox(`⚔️ Duelo ganado`, [`Venciste a ${per.name}`, `+${d.cantidad}💰`], COLORES.oro, "small", 2, gan.id);
        msgBox(`⚔️ Duelo perdido`, [`${gan.name} te venció`, `-${d.cantidad}💰`], COLORES.error, "small", 2, per.id);
        [[rt, sA], [p, sB]].forEach(([pl, st]) => { if (st.duelos_ganados >= 10 && !st.badges.includes("duelista")) darBadge(pl, "duelista"); });
        markDirty(getPlayerKey(rt)); markDirty(getPlayerKey(p));
    },
    "!rechazar": (p) => {
        const idx = STATE.duelosActivos.findIndex(d => d.retado === p.id);
        if (idx === -1) return msgError("No tenés duelos pendientes", p.id);
        const d = STATE.duelosActivos[idx]; STATE.duelosActivos.splice(idx, 1);
        const rt = STATE.room.getPlayer(d.retador);
        const st = STATE.baseDatos[d.retadorKey]; if (st) { st.monedas += d.cantidad; markDirty(d.retadorKey); }
        msgSmall(`🚫 Rechazaste el duelo${rt ? ` de ${rt.name}` : ""}`, p.id, COLORES.error, "small", 1);
        if (rt) msgSmall(`🚫 ${p.name} rechazó tu duelo`, rt.id, COLORES.error, "small", 0);
    },
    "!admin": (p, args, isA) => {
        if (!esAdminEfectivo(p, isA)) return msgError("Solo admins", p.id);
        if (!args[0]) return msgError("Uso: !admin [jugador]", p.id);
        const { target } = resolverJugadorYResto(args);
        if (!target) return msgError("No encontrado (debe estar conectado)", p.id);
        if (target.admin) return msgError("Ya es admin", p.id);
        STATE.room.setPlayerAdmin(target.id, true);
        const k = getPlayerKey(target);
        const s = STATE.baseDatos[k];
        if (s && JERARQUIA_RANGOS.indexOf(s.rango || "normal") < JERARQUIA_RANGOS.indexOf("admin")) { s.rango = "admin"; markDirty(k); }
        msgBox(`👑 ¡NUEVO ADMIN!`, [`${target.name}`], COLORES.oro, "small-bold", 2, p.id);
        auditLog(p, "GIVE_ADMIN", target.name);
    },
    "!expulsar": (p, args, isA) => {
        if (!args[0]) return msgError("Uso: !expulsar [jugador]", p.id);
        const { target } = resolverJugadorYResto(args);
        if (!target) return msgError("No encontrado", p.id);
        if (isA) { STATE.room.kickPlayer(target.id, "Expulsado", false); return; }
        if (target.admin) return msgError("No se puede expulsar admins", p.id);
        iniciarVotacion("expulsar", target, p);
    },
    "!votar": (p, args) => { if (!args[0]) return msgError("Uso: !votar expulsar", p.id); votar(args[0].toLowerCase(), p); },

    // ── !afk (con cooldown anti-teletransporte) ──
    "!afk": (p) => {
        const key = getPlayerKey(p);
        const ahora = Date.now();

        // Cooldown de toggle: sólo aplica durante partido y sólo al VOLVER
        // (avisar que te vas AFK nunca tiene cooldown, para no castigar al
        // que realmente se tiene que ir). Corta el ciclo "!afk → sale →
        // !afk → entra" que se usaba como teletransporte al arco.
        if (STATE.partidoEnCurso && STATE.afkPlayers.has(p.id)) {
            const ult = STATE.ultimoToggleAfk[p.id];
            if (ult && ahora - ult < CONFIG.AFK_TOGGLE_COOLDOWN_MS) {
                const r = Math.ceil((CONFIG.AFK_TOGGLE_COOLDOWN_MS - (ahora - ult)) / 1000);
                return msgError(`Esperá ${r}s antes de volver (evita el abuso de !afk para reposicionarte)`, p.id);
            }
        }
        STATE.ultimoToggleAfk[p.id] = ahora;

        if (STATE.afkPlayers.has(p.id)) {
            // Volver de AFK: exigir un mínimo de permanencia.
            const desde = STATE.afkDesde[p.id] || ahora;
            if (ahora - desde < CONFIG.AFK_MIN_DURACION_MS) {
                const f = Math.ceil((CONFIG.AFK_MIN_DURACION_MS - (ahora - desde)) / 1000);
                return msgError(`Estás AFK hace muy poco. Esperá ${f}s`, p.id);
            }
            STATE.afkPlayers.delete(p.id);
            delete STATE.afkDesde[p.id];
            STATE.afkAvisado30s.delete(p.id);
            STATE.afkCooldown.set(key, ahora + CONFIG.AFK_REINGRESO_COOLDOWN_MS);
            if (STATE.partidoEnCurso) {
                const r = STATE.room.getPlayerList().filter(x => x.team === 1).length;
                const b = STATE.room.getPlayerList().filter(x => x.team === 2).length;
                safeOperation(() => STATE.room.setPlayerTeam(p.id, r <= b ? 1 : 2));
            }
            msgSuccess(`Volviste`, p.id);
        } else {
            STATE.afkPlayers.add(p.id);
            STATE.afkDesde[p.id] = ahora;
            STATE.afkCooldown.set(key, ahora + CONFIG.AFK_REINGRESO_COOLDOWN_MS);
            STATE.room.setPlayerTeam(p.id, 0);
            msgSmall(`💤 ${p.name} está AFK`, p.id, COLORES.advertencia, "small-bold", 2);
            msgSmall(`Volvé en ${Math.round(CONFIG.AFK_KICK_MS / 1000)}s o te saca el sistema`, p.id, 0xFF8800, "small", 1);
        }
    },
    "!fueraafk": (p, args, isA) => { if (!esAdminEfectivo(p, isA)) return msgError("Solo admins", p.id); if (STATE.afkPlayers.size === 0) return msgInfo("No hay AFK", p.id); kickAFKs(p.name); },
    "!iniciar": (p, args, isA) => {
        if (!esAdminEfectivo(p, isA)) return;
        if (STATE.partidoEnCurso) return msgError("Ya hay partido", p.id);
        const all = STATE.room.getPlayerList().filter(x => !x.admin && !STATE.afkPlayers.has(x.id));
        if (all.length === 0) return msgError("No hay jugadores", p.id);
        const { equipo1, equipo2 } = balancearEquiposElo(all);
        all.forEach(pl => STATE.room.setPlayerTeam(pl.id, 0));
        equipo1.forEach(j => STATE.room.setPlayerTeam(j.id, 1));
        equipo2.forEach(j => STATE.room.setPlayerTeam(j.id, 2));
        setTimeout(() => { if (!STATE.partidoEnCurso) STATE.room.startGame(); }, 2000);
    },
    "!juegantodos": (p, args, isA) => {
        if (!esAdminEfectivo(p, isA)) return;
        STATE.jueganTodosActivo = !STATE.jueganTodosActivo;
        STATE.automatizadoActivado = false; STATE.bracketFijo = null;
        msgSmall(STATE.jueganTodosActivo ? "✅ Juegan todos: ON" : "❌ Juegan todos: OFF", p.id, STATE.jueganTodosActivo ? 0x00FF88 : 0xFF3366, "small-bold", 1);
        if (STATE.jueganTodosActivo) STATE.room.getPlayerList().filter(pl => pl.team === 0 && !pl.admin).forEach(pl => {
            const r = STATE.room.getPlayerList().filter(x => x.team === 1).length;
            const b = STATE.room.getPlayerList().filter(x => x.team === 2).length;
            STATE.room.setPlayerTeam(pl.id, r <= b ? 1 : 2);
        });
    },
    "!auto": (p, args, isA) => {
        if (!esAdminEfectivo(p, isA)) return;
        STATE.automatizadoActivado = !STATE.automatizadoActivado; STATE.bracketFijo = null;
        msgSmall(STATE.automatizadoActivado ? "✅ Modo auto: ON" : "❌ Modo auto: OFF", p.id, STATE.automatizadoActivado ? 0x00FF88 : 0xFF3366, "small-bold", 1);
        if (STATE.automatizadoActivado) { STATE.jueganTodosActivo = true; STATE.fairPlayActivo = false; ejecutarAutomatizado(true); anunciarModoAutomatizado(); }
    },
    "!detener": (p, args, isA) => { if (esAdminEfectivo(p, isA)) STATE.room.stopGame(); },
    "!echar": (p, args, isA) => {
        if (!esAdminEfectivo(p, isA)) return;
        const { target } = resolverJugadorYResto(args);
        if (!target) return msgError("No encontrado", p.id);
        if (target.admin) return msgError("No se puede expulsar admins", p.id);
        STATE.room.kickPlayer(target.id, "Expulsado", false);
    },
    "!powershot": (p, args, isA) => { if (!esAdminEfectivo(p, isA)) return; STATE.powershotActivado = !STATE.powershotActivado; msgSmall(STATE.powershotActivado ? "🔥 Powershot ON" : "❄️ Powershot OFF", p.id, STATE.powershotActivado ? 0xFF3366 : 0x00BFFF, "small-bold", 1); },
    "!curva": (p, args, isA) => {
        if (!esAdminEfectivo(p, isA)) return;
        if (!STATE.powershotActivado) return msgError("Primero activá !powershot", p.id);
        STATE.curvaActivado = !STATE.curvaActivado;
        msgSmall(STATE.curvaActivado ? "🌀 Curva ON" : "❌ Curva OFF", p.id, STATE.curvaActivado ? 0x00FFC8 : 0xFF3366, "small-bold", 1);
    },
    "!rainbow": (p, args, isA) => {
        if (!esAdminEfectivo(p, isA)) return;
        if (!STATE.rainbowEquipoActivo) return msgError("No hay rainbow activo", p.id);
        restaurarCamisetaEquipo(STATE.rainbowEquipoActivo.team, STATE.rainbowEquipoActivo.colorOriginal);
        STATE.rainbowEquipoActivo = null;
        msgSuccess("Rainbow desactivado, camiseta restaurada", p.id);
    },
    "!fairplay": (p, args, isA) => { if (esAdminEfectivo(p, isA)) { STATE.fairPlayActivo = !STATE.fairPlayActivo; msgSmall(`FairPlay: ${STATE.fairPlayActivo}`, p.id, COLORES.exito, "small-bold", 1); } },
    "!ganasigue": (p, args, isA) => { if (esAdminEfectivo(p, isA)) { STATE.ganaSigueActivo = !STATE.ganaSigueActivo; msgSmall(`GanaSigue: ${STATE.ganaSigueActivo}`, p.id, COLORES.exito, "small-bold", 1); } },
    "!goldeoro": (p, args, isA) => { if (esAdminEfectivo(p, isA)) { STATE.golDeOroActivo = !STATE.golDeOroActivo; msgSmall(`GolDeOro: ${STATE.golDeOroActivo}`, p.id, COLORES.exito, "small-bold", 1); } },
    "!tamano": (p, args) => {
        const s = STATE.baseDatos[getPlayerKey(p)];
        if (!esOwner(p) && !s?.vip) return msgError("Tamaño solo para VIP", p.id);
        const min = CONFIG.TAMANO_MIN;
        const max = esOwner(p) && !s?.vip ? CONFIG.TAMANO_MAX : tierVipDe(s).max;
        const sz = parseFloat(args[0]);
        if (isNaN(sz) || sz < min || sz > max) return msgError(`Uso: !tamano [${min}-${max}]`, p.id);
        s.tamano_personalizado = sz;
        markDirty(getPlayerKey(p));
        if (p.team !== 0) { aplicarTamanoPersistente(p); setTimeout(() => aplicarTamanoPersistente(p), 100); }
        msgSmall(`📏 ${p.name} tamaño base: ${sz}`, p.id, 0x9BFF35, "small", 0);
    },
    "!ids": (p) => { const t = STATE.room.getPlayerList().map(pl => `[${pl.id}] ${pl.name}${pl.admin ? " 👑" : ""}`).join("\n"); sendAnnouncement(`🆔 JUGADORES:\n${t || "Nadie"}`, p.id, 0xFFFFFF, "small-bold", 0); },
    "!discord": (p) => msgArrow(`⚡ DISCORD`, CONFIG.DISCORD_INVITE, p.id, 0x5865F2, 1),
    "!verificacion": (p) => {
        const k = getPlayerKey(p), s = STATE.baseDatos[k] || initStats(p);
        if (s.discord_verificado) return msgInfo("✅ Ya verificaste", p.id);
        const ahora = Date.now();
        let cod = Object.entries(STATE.verificacionesPendientes).find(([, v]) => v.key === k && v.expira > ahora)?.[0];
        if (!cod) { do { cod = String(Math.floor(100000 + Math.random() * 900000)); } while (STATE.verificacionesPendientes[cod]); STATE.verificacionesPendientes[cod] = { key: k, playerId: p.id, nombre: p.name, expira: ahora + CONFIG.VERIFICACION_EXPIRA_MS }; }
        const m = Math.round(CONFIG.VERIFICACION_EXPIRA_MS / 60000);
        msgBox(`🔗 VERIFICACIÓN DE DISCORD`, [`1) Entrá a: ${CONFIG.DISCORD_INVITE}`, `2) Canal ${CONFIG.VERIFICACION_CANAL}`, `3) Escribí tu código: ${cod}`, `⏳ Válido ${m} min`], 0x5865F2, "small-bold", 2, p.id);
        notificarMensaje(`🔗 **${p.name}** pidió verificación — código \`${cod}\``);
    },
    "!verificar": (p, args, isA) => {
        if (!esAdminEfectivo(p, isA)) return msgError("Solo admins", p.id);
        const cod = (args[0] || "").trim();
        if (!cod) return msgError("Uso: !verificar [código]", p.id);
        const pend = STATE.verificacionesPendientes[cod];
        if (!pend || pend.expira < Date.now()) { delete STATE.verificacionesPendientes[cod]; return msgError("Código inválido o vencido", p.id); }
        confirmarVerificacionDiscord(cod);
        msgSuccess(`Verificado ${pend.nombre}`, p.id);
    },
    "!dinero": (p) => { const s = STATE.baseDatos[getPlayerKey(p)] || initStats(p); msgInfo(`💰 Tenés ${s.monedas} monedas`, p.id); },
    "!misiones": (p) => {
        const s = STATE.baseDatos[getPlayerKey(p)];
        actualizarMisionDiaria(s); actualizarMisionSemanal(s);
        sendAnnouncement(`🎯 Hoy: ${s.misiones.goles}/${CONFIG.MISION_GOLES_OBJETIVO} goles ${s.misiones.completadas.includes("goles_dia") ? "✅" : ""}\n🗓️ Semana: ${s.misionSemanal.partidos}/${CONFIG.MISION_SEMANAL_PARTIDOS_OBJETIVO} partidos ${s.misionSemanal.completada ? "✅" : ""}`, p.id, COLORES.info, "small", 0);
    },
    "!clan": (p, args) => {
        const k = getPlayerKey(p), s = STATE.baseDatos[k];
        const sub = (args[0] || "").toLowerCase();
        if (sub === "crear") {
            const nom = args.slice(1).join(" ").trim().slice(0, 25);
            if (!nom) return msgError("Uso: !clan crear [nombre]", p.id);
            if (s.clan) return msgError("Ya estás en un clan", p.id);
            if (s.monedas < CONFIG.CLAN_CREAR_COSTO) return msgError(`Necesitás ${CONFIG.CLAN_CREAR_COSTO}💰`, p.id);
            const id = nom.toLowerCase();
            if (STATE.clanes[id]) return msgError("Ya existe ese clan", p.id);
            s.monedas -= CONFIG.CLAN_CREAR_COSTO;
            STATE.clanes[id] = { nombre: nom, lider: k, miembros: [k], creado: Date.now(), nivel: 1, xp: 0 };
            s.clan = id;
            if (!s.badges.includes("clan_leader")) darBadge(p, "clan_leader");
            msgBox("⚔️ Clan fundado", [`${nom}`, `Líder: ${p.name}`], 0xFF00FF, "small-bold", 1);
            markDirty(k);
        } else if (sub === "invitar") {
            if (!s.clan || !STATE.clanes[s.clan]) return msgError("No tenés clan", p.id);
            const c = STATE.clanes[s.clan];
            if (c.lider !== k) return msgError("Solo el líder invita", p.id);
            if (c.miembros.length >= CONFIG.CLAN_MAX_MIEMBROS) return msgError("Clan lleno", p.id);
            const t = findOnlinePlayer(args.slice(1).join(" "));
            if (!t) return msgError("No encontrado", p.id);
            const tk = getPlayerKey(t);
            if (STATE.baseDatos[tk]?.clan) return msgError("Ese jugador ya tiene clan", p.id);
            STATE.clanInvitaciones[tk] = { clan: s.clan, invitadoPor: p.name, expira: Date.now() + CONFIG.CLAN_INVITACION_TTL_MS };
            msgSmall(`⚔️ ${t.name} invitado a ${c.nombre}`, null, COLORES.advertencia, "small", 1);
            msgInfo(`⚔️ ${p.name} te invitó al clan "${c.nombre}". Usá !clan aceptar`, t.id);
        } else if (sub === "aceptar") {
            const inv = STATE.clanInvitaciones[k];
            if (!inv) return msgError("No tenés invitaciones", p.id);
            if (inv.expira && inv.expira < Date.now()) { delete STATE.clanInvitaciones[k]; return msgError("La invitación expiró", p.id); }
            const c = STATE.clanes[inv.clan];
            if (!c) { delete STATE.clanInvitaciones[k]; return msgError("Ese clan ya no existe", p.id); }
            if (s.clan) return msgError("Ya estás en un clan", p.id);
            c.miembros.push(k); s.clan = inv.clan; delete STATE.clanInvitaciones[k];
            msgBox("⚔️ Nuevo en el clan", [`${p.name} se unió a ${c.nombre}`], COLORES.exito, "small-bold", 1);
            markDirty(k);
        } else if (sub === "salir") {
            if (!s.clan || !STATE.clanes[s.clan]) return msgError("No tenés clan", p.id);
            const c = STATE.clanes[s.clan];
            c.miembros = c.miembros.filter(m => m !== k);
            if (c.lider === k) { if (c.miembros.length > 0) c.lider = c.miembros[0]; else delete STATE.clanes[s.clan]; }
            msgSmall(`${p.name} abandonó el clan`, p.id, COLORES.advertencia, "small", 1);
            s.clan = null; markDirty(k);
        } else if (sub === "info") {
            const id = args.slice(1).join(" ").toLowerCase() || s.clan;
            const c = STATE.clanes[id];
            if (!c) return msgError("Clan no encontrado", p.id);
            sendAnnouncement(`⚔️ ${c.nombre}\nNv ${c.nivel || 1} (${c.xp || 0}/${xpNecesariaParaNivel(c.nivel || 1)} XP) · Líder: ${STATE.baseDatos[c.lider]?.nombre_actual || "?"}\nMiembros: ${c.miembros.map(kk => STATE.baseDatos[kk]?.nombre_actual || "?").join(", ")}`, p.id, 0xFF00FF, "small-bold", 0);
        } else if (sub === "tabla") {
            const r = Object.values(STATE.clanes).map(c => ({ nombre: c.nombre, nivel: c.nivel || 1, mmrProm: Math.round(c.miembros.reduce((sm, kk) => sm + (STATE.baseDatos[kk]?.mmr || 1000), 0) / (c.miembros.length || 1)), miembros: c.miembros.length })).sort((a, b) => b.nivel - a.nivel || b.mmrProm - a.mmrProm).slice(0, 5);
            msgBox("⚔️ Top clanes", r.length ? r.map((c, i) => `${i + 1}. ${c.nombre} Nv.${c.nivel} ELO:${c.mmrProm} (${c.miembros})`) : ["Sin clanes aún"], 0xFF00FF, "small-bold", 0, p.id);
        } else msgInfo("Uso: !clan crear/invitar/aceptar/salir/info/tabla", p.id);
    },
    "!reportar": (p, args) => {
        if (!args.length) return msgError("Uso: !reportar [jugador] [motivo]", p.id);
        const { target, resto } = resolverJugadorYResto(args);
        if (!target || target.id === p.id) return msgError("Jugador inválido", p.id);
        const m = resto.join(" ") || "Sin especificar";
        STATE.reportes.push({ reportado: getPlayerKey(target), reportadoNombre: target.name, reportante: p.name, motivo: m, fecha: Date.now() });
        if (STATE.reportes.length > 200) STATE.reportes.splice(0, STATE.reportes.length - 200);
        msgSuccess(`Reporte enviado sobre ${target.name}`, p.id);
        modificarFairPlay(target, -3, "reportado");
    },
    "!reportes": (p, args, isA) => {
        if (!esAdminEfectivo(p, isA)) return;
        const u = STATE.reportes.slice(-10).reverse();
        if (!u.length) return msgInfo("Sin reportes", p.id);
        sendAnnouncement(`📋 ÚLTIMOS REPORTES:\n${u.map(r => `${r.reportadoNombre} ← ${r.reportante}: ${r.motivo}`).join("\n")}`, p.id, COLORES.advertencia, "small-bold", 0);
    },
    "!llamar": (p, args) => {
        const ahora = Date.now();
        if (STATE.ultimoLlamadoAdmin && ahora - STATE.ultimoLlamadoAdmin < CONFIG.LLAMARADMIN_COOLDOWN_MS) return msgError("Ya se avisó hace poco", p.id);
        STATE.ultimoLlamadoAdmin = ahora;
        const m = args.join(" ") || "sin especificar";
        msgWarn(`${p.name} está llamando a un admin`, null);
        STATE.room.getPlayerList().filter(pl => pl.admin).forEach(pl => msgInfo(`📣 ${p.name} llamó: ${m}`, pl.id));
        msgSmall(`🔰 Se avisó a los admins. Motivo: "${m}"`, p.id, COLORES.advertencia, "small-bold", 1);
    },
    "!callar": (p, args, isA) => {
        if (!isA && !puedeUsar(p, "!callar")) return;
        if (!args[0]) return msgError("Uso: !callar [jugador] [1s/1m/1h]", p.id);
        const po = args[args.length - 1], pd = parseDuracion(po);
        const tD = args.length > 1 && pd !== null;
        const nA = tD ? args.slice(0, -1) : args;
        const { target, key: tk } = resolverJugadorYResto(nA);
        if (!tk) return msgError("No encontrado", p.id);
        if (!actorSuperaKey(p, tk)) return msgError("No podés mutear a alguien de rango igual o mayor", p.id);
        const dur = tD ? pd : CONFIG.MUTE_DEFAULT_MIN * 60000;
        STATE.mutesTemporales = STATE.mutesTemporales.filter(m => m.auth !== tk);
        STATE.mutesTemporales.push({ auth: tk, timestamp: Date.now(), duracion: dur });
        msgBox("🤫 Silenciado", [`${target ? target.name : STATE.baseDatos[tk]?.nombre_actual}`, `${formatDuracion(dur)}`], COLORES.advertencia, "small-bold", 2, p.id);
        auditLog(p, "MUTE", target?.name || STATE.baseDatos[tk]?.nombre_actual, formatDuracion(dur));
    },
    "!hablar": (p, args, isA) => {
        if (!isA && !puedeUsar(p, "!hablar")) return;
        const { target, key: tk } = resolverJugadorYResto(args);
        if (!tk) return msgError("No encontrado", p.id);
        const a = STATE.mutesTemporales.length;
        STATE.mutesTemporales = STATE.mutesTemporales.filter(m => m.auth !== tk);
        if (STATE.mutesTemporales.length < a) msgSuccess(`${target ? target.name : STATE.baseDatos[tk]?.nombre_actual} puede hablar`, p.id);
        else msgError("No estaba silenciado", p.id);
    },
    "!vetar": (p, args, isA) => {
        if (!puedeUsar(p, "!vetar")) return msgError("Sin permiso", p.id);
        if (!args[0]) return msgError("Uso: !vetar [jugador] [motivo]", p.id);
        const { target, key, resto } = resolverJugadorYResto(args);
        if (!key || !STATE.baseDatos[key]) return msgError("No encontrado", p.id);
        if (!actorSuperaKey(p, key)) return msgError("No podés banear a alguien de rango igual o mayor", p.id);
        const motivo = resto.join(" ").trim();
        if (motivo.length < 3) return msgError("Necesitás especificar un motivo (mín. 3 caracteres)", p.id);
        aplicarBanGlobal(key, CONFIG.BAN_DIAS_NORMAL * 86400000);
        const n = target ? target.name : STATE.baseDatos[key].nombre_actual;
        if (target) STATE.room.kickPlayer(target.id, `⛔ Baneado ${CONFIG.BAN_DIAS_NORMAL}d. Motivo: ${motivo}`, false);
        msgBox("⛔ Baneado", [`${n}`, `${CONFIG.BAN_DIAS_NORMAL}d`, `${motivo}`], COLORES.error, "small-bold", 2, p.id);
        logMsg('security.log', `[${ROOM_ID}] ${p.name} baneó a ${n} (${CONFIG.BAN_DIAS_NORMAL}d): ${motivo}`);
        auditLog(p, "BAN", n, `${CONFIG.BAN_DIAS_NORMAL}d · ${motivo}`);
    },
    "!vetamin": (p, args, isA) => {
        if (!puedeUsar(p, "!vetamin")) return msgError("Sin permiso", p.id);
        if (!args[0]) return msgError("Uso: !vetamin [jugador] [motivo]", p.id);
        const { target, key, resto } = resolverJugadorYResto(args);
        if (!key || !STATE.baseDatos[key]) return msgError("No encontrado", p.id);
        if (!actorSuperaKey(p, key)) return msgError("No podés banear a alguien de rango igual o mayor", p.id);
        const motivo = resto.join(" ").trim();
        if (motivo.length < 3) return msgError("Motivo obligatorio (mín. 3)", p.id);
        aplicarBanGlobal(key, CONFIG.BAN_DIAS_LOW * 86400000);
        const n = target ? target.name : STATE.baseDatos[key].nombre_actual;
        if (target) STATE.room.kickPlayer(target.id, `⛔ Baneado ${CONFIG.BAN_DIAS_LOW}d: ${motivo}`, false);
        msgBox("⛔ Baneado", [`${n}`, `${CONFIG.BAN_DIAS_LOW}d`, `${motivo}`], COLORES.error, "small-bold", 2, p.id);
        auditLog(p, "BAN_MIN", n, `${CONFIG.BAN_DIAS_LOW}d · ${motivo}`);
    },
    "!desvetar": (p, args) => {
        if (!puedeUsar(p, "!desvetar")) return msgError("Sin permiso", p.id);
        if (!args[0]) return msgError("Uso: !desvetar [jugador]", p.id);
        const key = findPlayerKeyByName(args.join(" "));
        if (!key || !STATE.baseDatos[key]) return msgError("No encontrado", p.id);
        quitarBanGlobal(key);
        msgSuccess(`${STATE.baseDatos[key].nombre_actual} ya no está baneado`, p.id);
        auditLog(p, "UNBAN", STATE.baseDatos[key].nombre_actual);
    },
    "!advertir": (p, args) => {
        if (!puedeUsar(p, "!advertir")) return msgError("Sin permiso", p.id);
        if (!args[0]) return msgError("Uso: !advertir [jugador] [motivo]", p.id);
        const { target, key, resto } = resolverJugadorYResto(args);
        if (!key || !STATE.baseDatos[key]) return msgError("No encontrado", p.id);
        if (!actorSuperaKey(p, key)) return msgError("No podés warnear a alguien de rango igual o mayor", p.id);
        const m = resto.join(" ") || "sin especificar";
        const s = STATE.baseDatos[key];
        const hoy = getDiaString(Date.now());
        if (s.warns_fecha !== hoy) { s.warns_fecha = hoy; s.warns_hoy = 0; }
        s.warns_hoy++; markDirty(key);
        msgBox(`⚠️ WARN`, [`${target ? target.name : s.nombre_actual} (${s.warns_hoy}/${CONFIG.WARN_MAX})`, `${m}`], COLORES.advertencia, "small-bold", 2, p.id);
        auditLog(p, "WARN", target?.name || s.nombre_actual, m);
        if (s.warns_hoy >= CONFIG.WARN_MAX) {
            aplicarBanGlobal(key, CONFIG.BAN_DIAS_LOW * 86400000);
            s.warns_hoy = 0; markDirty(key);
            if (target) STATE.room.kickPlayer(target.id, `⛔ Baneado ${CONFIG.BAN_DIAS_LOW}d por warns`, false);
        }
    },
    "!desadv": (p, args) => { if (!puedeUsar(p, "!desadv")) return msgError("Sin permiso", p.id); const k = findPlayerKeyByName(args.join(" ")); if (!k || !STATE.baseDatos[k]) return msgError("No encontrado", p.id); STATE.baseDatos[k].warns_hoy = 0; markDirty(k); msgSuccess(`Warn removido`, p.id); },
    "!listaneg": (p, args) => { if (!puedeUsar(p, "!listaneg")) return msgError("Sin permiso", p.id); const { target, key } = resolverJugadorYResto(args); if (!key || !STATE.baseDatos[key]) return msgError("No encontrado", p.id); if (!actorSuperaKey(p, key)) return msgError("No podés listar a alguien de rango igual o mayor", p.id); setBlacklistGlobal(key, true); if (target) STATE.room.kickPlayer(target.id, "🚫 Lista negra", false); msgBox("🚫 Lista negra", [`${STATE.baseDatos[key].nombre_actual} agregado`], COLORES.error, "small-bold", 2, p.id); auditLog(p, "BLACKLIST", STATE.baseDatos[key].nombre_actual); },
    "!quitveto": (p, args) => { if (!puedeUsar(p, "!quitveto")) return msgError("Sin permiso", p.id); const k = findPlayerKeyByName(args.join(" ")); if (!k || !STATE.baseDatos[k]) return msgError("No encontrado", p.id); setBlacklistGlobal(k, false); msgSuccess(`${STATE.baseDatos[k].nombre_actual} salió de lista negra`, p.id); auditLog(p, "UNBLACKLIST", STATE.baseDatos[k].nombre_actual); },
    "!dar": (p, args) => {
        if (args.length < 2) return msgError("Uso: !dar [vip/supervip/ultravip/mod/modplus/admin/coowner] [jugador] (perma/[días])", p.id);
        const tipo = args[0].toLowerCase();
        const dT = args[args.length - 1].toLowerCase();
        const esP = dT === "perma";
        const dC = !esP ? parseInt(dT, 10) : null;
        const tD = esP || (dC && dC > 0);
        const nA = tD ? args.slice(1, -1) : args.slice(1);
        const target = findOnlinePlayer(nA.join(" "));
        if (!target) return msgError("No encontrado", p.id);
        const key = getPlayerKey(target);
        if (esKeyAnonima(key)) return msgError(`${target.name} no tiene auth. No se puede dar VIP/rango.`, p.id);
        const s = STATE.baseDatos[key];
        const ra = getRango(p);
        const TV = { vip: "vip", supervip: "super_vip", super_vip: "super_vip", ultravip: "ultra_vip", ultra_vip: "ultra_vip" };
        if (TV[tipo]) {
            const tk = TV[tipo];
            if (!["admin", "coowner", "owner"].includes(ra)) return msgError("Solo admins+", p.id);
            if (esP && !["coowner", "owner"].includes(ra)) return msgError("Perma solo owner/co-owner", p.id);
            const d = dC && dC > 0 ? Math.min(dC, 3650) : 14;
            s.vip = true; s.vip_tier = tk; s.vip_perma = esP; s.vip_expira = esP ? null : Date.now() + d * 86400000;
            markDirty(key);
            const ti = CONFIG.VIP_TIERS[tk];
            msgBox(`${ti.emoji} ¡${ti.nombre}!`, [`${target.name}`, esP ? "Permanente" : `${d} día${d === 1 ? "" : "s"}`], 0x00FFFF, "small-bold", 2, p.id);
            auditLog(p, "GRANT_VIP", target.name, `${tk}${esP ? " perma" : ` ${d}d`}`);
        } else if (tipo === "mod" || tipo === "modplus") {
            if (!["admin", "coowner", "owner"].includes(ra)) return msgError("Solo admins+", p.id);
            s.rango = tipo === "modplus" ? "modplus" : "mod"; markDirty(key);
            msgBox("🛡️ Nuevo staff", [`${target.name} ahora es ${tipo === "modplus" ? "MOD+" : "MOD"}`], COLORES.info, "small-bold", 2, p.id);
            auditLog(p, "GRANT_RANK", target.name, tipo);
        } else if (tipo === "admin") {
            if (!["coowner", "owner"].includes(ra)) return msgError("Solo owner/co-owner", p.id);
            s.rango = "admin"; markDirty(key);
            msgBox("🛠 Nuevo admin", [`${target.name}`], COLORES.oro, "small-bold", 2, p.id);
            auditLog(p, "GRANT_RANK", target.name, "admin");
        } else if (tipo === "coowner") {
            if (ra !== "owner") return msgError("Solo owner", p.id);
            s.rango = "coowner"; markDirty(key);
            msgBox("✨ Nuevo co-owner", [`${target.name}`], 0xDA70D6, "small-bold", 2, p.id);
            auditLog(p, "GRANT_RANK", target.name, "coowner");
        } else return msgError("Tipo inválido", p.id);
    },
    "!darmon": (p, args) => {
        if (!esOwner(p)) return msgError("Solo owner", p.id);
        if (args.length < 2) return msgError("Uso: !darmon [jugador] [cantidad]", p.id);
        const c = parseInt(args[args.length - 1], 10);
        if (!validarCantidad(c, 1)) return msgError("Cantidad inválida", p.id);
        const { target, key: tk } = resolverJugadorYResto(args.slice(0, -1));
        if (!tk) return msgError("No encontrado", p.id);
        if (esKeyAnonima(tk)) return msgError("Ese jugador no tiene auth.", p.id);
        const s = STATE.baseDatos[tk];
        s.monedas += c; markDirty(tk);
        if (target) msgSuccess(`💰 Recibiste ${c} monedas`, target.id);
        msgSuccess(`Le diste ${c}💰 a ${s.nombre_actual}`, p.id);
        auditLog(p, "GIVE_COINS", s.nombre_actual, String(c));
    },
    "!darmoneda": (p, args) => commands["!darmon"](p, args),
    "!darelo": (p, args) => {
        if (!esOwner(p)) return msgError("Solo owner", p.id);
        if (args.length < 2) return msgError("Uso: !darelo [jugador] [cantidad]", p.id);
        const c = parseInt(args[args.length - 1], 10);
        if (Number.isNaN(c) || c === 0) return msgError("Cantidad inválida", p.id);
        const { target, key: tk } = resolverJugadorYResto(args.slice(0, -1));
        if (!tk) return msgError("No encontrado", p.id);
        const s = STATE.baseDatos[tk]; if (!s) return msgError("Sin perfil", p.id);
        const ant = s.mmr || 1000;
        s.mmr = Math.max(0, ant + c);
        if (c < 0 && s.peak_elo > s.mmr) s.peak_elo = s.mmr;
        actualizarTitulo(tk);
        markDirty(tk);
        const sg = c > 0 ? "+" : "";
        if (target) msgSuccess(`⚖️ ELO: ${sg}${c} → ${s.mmr}`, target.id);
        msgSuccess(`${s.nombre_actual}: ${ant} → ${s.mmr}`, p.id);
        auditLog(p, "ADJUST_ELO", s.nombre_actual, `${sg}${c}`);
    },
    "!quitar": (p, args) => {
        if (args.length < 2) return msgError("Uso: !quitar [vip/mod/modplus/admin/coowner] [jugador]", p.id);
        const tipo = args[0].toLowerCase(), nom = args.slice(1).join(" ");
        const target = findOnlinePlayer(nom);
        const key = target ? getPlayerKey(target) : findPlayerKeyByName(nom);
        if (!key || !STATE.baseDatos[key]) return msgError("No encontrado", p.id);
        const s = STATE.baseDatos[key], ra = getRango(p);
        if (tipo === "vip") { if (!["admin", "coowner", "owner"].includes(ra)) return msgError("Solo admins+", p.id); s.vip = false; s.vip_perma = false; s.vip_expira = null; s.vip_tier = "vip"; }
        else if (tipo === "coowner") { if (ra !== "owner") return msgError("Solo owner", p.id); s.rango = "normal"; }
        else if (["mod", "modplus", "admin"].includes(tipo)) { if (!["coowner", "owner"].includes(ra)) return msgError("Solo owner/co-owner", p.id); s.rango = "normal"; }
        else return msgError("Tipo inválido", p.id);
        markDirty(key);
        msgSuccess(`Se le sacó ${tipo} a ${s.nombre_actual}`, p.id);
        auditLog(p, "REVOKE", s.nombre_actual, tipo);
    },
    "!votexp": (p, args) => { const { target } = resolverJugadorYResto(args); if (!target) return msgError("Uso: !votexp [jugador]", p.id); if (esProtegidoDeVoto(target)) return msgError("Protegido (VIP/staff)", p.id); iniciarVotacion("kick30", target, p); },
    "!votmute": (p, args) => { const { target } = resolverJugadorYResto(args); if (!target) return msgError("Uso: !votmute [jugador]", p.id); if (esProtegidoDeVoto(target)) return msgError("Protegido", p.id); iniciarVotacion("mute30", target, p); },
    "!color": (p, args) => {
        const s = STATE.baseDatos[getPlayerKey(p)];
        if (!esOwner(p) && !s.vip) return msgError("!color es exclusivo VIP", p.id);
        const hex = (args[0] || "").replace("#", "").toUpperCase();
        if (!/^[0-9A-F]{6}$/.test(hex)) return msgError("Uso: !color [RRGGBB]", p.id);
        s.color_nombre = parseInt(hex, 16); markDirty(getPlayerKey(p));
        msgSuccess(`Color actualizado`, p.id);
    },
    "!msgenter": (p, args) => { const s = STATE.baseDatos[getPlayerKey(p)]; if (!s.vip && !esStaff(p)) return msgError("Solo VIP/staff", p.id); const t = args.join(" ").slice(0, 80); if (!t) return msgError("Uso: !msgenter [mensaje]", p.id); s.msg_join = t; markDirty(getPlayerKey(p)); msgSuccess(`Actualizado`, p.id); },
    "!msgsale": (p, args) => { const s = STATE.baseDatos[getPlayerKey(p)]; if (!s.vip && !esStaff(p)) return msgError("Solo VIP/staff", p.id); const t = args.join(" ").slice(0, 80); if (!t) return msgError("Uso: !msgsale [mensaje]", p.id); s.msg_leave = t; markDirty(getPlayerKey(p)); msgSuccess(`Actualizado`, p.id); },
    "!infovip": (p) => { const t = CONFIG.VIP_TIERS; sendAnnouncement(`3 tiers: color, msgenter/msgsale, festejos, x1.5 goles\n\n🥉 VIP tamaño ${t.vip.min}-${t.vip.max} azul\n🥈 Super ${t.super_vip.min}-${t.super_vip.max} cian\n👑 Ultra ${t.ultra_vip.min}-${t.ultra_vip.max} fuego\n\n⚡ ${CONFIG.DISCORD_INVITE}`, p.id, 0x00FFFF, "small", 0); },
    "!ayuda": (p) => { sendAnnouncement(`📖 Guía\n!perfil · !tienda · !clan · !tabla · !figuras\nCompleta: !comandos`, p.id, 0xFFFFFF, "small-bold", 0); },
    "!gk": (p) => {
        if (p.team === 0) return msgError("Entrá a un equipo primero", p.id);
        const act = STATE.gkReservado[p.team];
        if (act && act !== p.id) { const j = STATE.room.getPlayer(act); if (j && j.team === p.team) return msgError("Ya tenés arquero", p.id); STATE.gkReservado[p.team] = null; }
        if (act === p.id) return;
        STATE.gkReservado[p.team] = p.id;
        aplicarTamanoPersistente(p);
        msgMini(`🧤 ${p.name} se puso los guantes`, p.id, COLORES.info, 1);
    },
    "!salirarquero": (p) => dejarArquero(p),
    "!capitanes": (p) => {
        if (!STATE.partidoEnCurso) return msgError("No hay partido", p.id);
        const n = (t) => { const id = STATE.capitanes[t]; const j = id != null ? STATE.room.getPlayer(id) : null; return j ? j.name : "—"; };
        msgBox(`${CONFIG.CAPITAN_AVATAR} Capitanes`, [`🔴 ${n(1)}`, `🔵 ${n(2)}`], COLORES.oro, "small-bold", 0, p.id);
    },
    "!capitan": (p, args, isA) => {
        if (!esAdminEfectivo(p, isA)) return msgError("Solo admins", p.id);
        if (!STATE.partidoEnCurso) return msgError("Solo con partido", p.id);
        if (!args.length) return msgError("Uso: !capitan [jugador]", p.id);
        const t = findOnlinePlayer(args.join(" "));
        if (!t) return msgError("No encontrado", p.id);
        if (t.team !== 1 && t.team !== 2) return msgError("No está en equipo", p.id);
        const team = t.team;
        if (STATE.capitanes[team] === t.id) return msgError("Ya es capitán", p.id);
        if (STATE.capitanes[team] != null) marcarCapitan(STATE.capitanes[team], false);
        STATE.capitanes[team] = t.id;
        marcarCapitan(t.id, true);
        msgSmall(`${CONFIG.CAPITAN_AVATAR} ${t.name} capitán del ${team === 1 ? "rojo 🔴" : "azul 🔵"} (por ${p.name})`, null, team === 1 ? COLORES.equipo_rojo : COLORES.equipo_azul, "small-bold", 1);
    },
    "!bb": (p) => { sendAnnouncement(`👋 ${p.name} se despidió (!bb)`, null, COLORES.advertencia, "small-bold", 1); STATE.salidasVoluntarias.add(p.id); STATE.room.kickPlayer(p.id, "👋 ¡Bye bye!", false); },
    "!nv": (p) => { sendAnnouncement(`👋 ${p.name} se despidió (!nv)`, null, COLORES.advertencia, "small-bold", 1); STATE.salidasVoluntarias.add(p.id); STATE.room.kickPlayer(p.id, "👋 ¡Nos vemos!", false); },
    "!mapa": (p, args, isA) => {
        if (!esAdminEfectivo(p, isA)) return;
        const n = (args[0] || "").toLowerCase();
        if (!MAPAS[n]) return msgError(`Mapas: ${Object.keys(MAPAS).join(", ")}`, p.id);
        STATE.automatizadoActivado = false; STATE.bracketFijo = null;
        const sc = STATE.room.getScores();
        cambiarMapa(n, sc?.scoreLimit || 3, sc?.timeLimit || 5);
        msgSuccess(`Mapa: ${n}`, p.id);
    },
    "!swapcol": (p, args, isA) => {
        if (!esAdminEfectivo(p, isA)) return;
        if (!STATE.ultimasCamisetas) return msgError("Sin camisetas", p.id);
        const { cam1, cam2 } = STATE.ultimasCamisetas;
        safeOperation(() => { STATE.room.setTeamColors(1, cam2.angle ?? 90, textoContrasteCamiseta(cam2.colors[0]), cam2.colors); STATE.room.setTeamColors(2, cam1.angle ?? 90, textoContrasteCamiseta(cam1.colors[0]), cam1.colors); });
        STATE.ultimasCamisetas = { cam1: cam2, cam2: cam1 };
        if (STATE.rainbowEquipoActivo) { restaurarCamisetaEquipo(STATE.rainbowEquipoActivo.team, STATE.rainbowEquipoActivo.colorOriginal); STATE.rainbowEquipoActivo = null; }
        msgSmall("🔄 Camisetas intercambiadas", p.id, COLORES.oro, "small-bold", 1);
    },
    "!liga": (p, args, isA) => {
        if (!esAdminEfectivo(p, isA)) return;
        if (args.length < 2) return msgError("Uso: !liga [club] [red/blue]", p.id);
        const eq = args[args.length - 1].toLowerCase();
        if (eq !== "red" && eq !== "blue") return msgError("'red' o 'blue'", p.id);
        const nc = args.slice(0, -1).join(" ").toLowerCase();
        const club = CAMISETAS.find(c => c.name.toLowerCase() === nc || c.name.toLowerCase().includes(nc));
        if (!club) return msgError(`No tengo esa. Probá: ${CAMISETAS.map(c => c.name).join(", ")}`, p.id);
        const tid = eq === "red" ? 1 : 2;
        safeOperation(() => STATE.room.setTeamColors(tid, club.angle ?? 90, textoContrasteCamiseta(club.colors[0]), club.colors));
        if (!STATE.ultimasCamisetas) STATE.ultimasCamisetas = { cam1: club, cam2: club };
        if (tid === 1) STATE.ultimasCamisetas.cam1 = club; else STATE.ultimasCamisetas.cam2 = club;
        msgSmall(`🎽 ${eq} ahora con la de ${club.name}`, p.id, COLORES.oro, "small-bold", 1);
    },
    "!vip": (p, args) => {
        if (!esOwner(p)) return msgError("Solo owner", p.id);
        if (!args.length) return msgError("Uso: !vip [jugador] (tier)", p.id);
        const TV = { vip: "vip", supervip: "super_vip", super_vip: "super_vip", ultravip: "ultra_vip", ultra_vip: "ultra_vip" };
        const ult = args[args.length - 1].toLowerCase();
        const tp = TV[ult];
        const nA = tp ? args.slice(0, -1) : args;
        const t = findOnlinePlayer(nA.join(" "));
        if (!t) return msgError("No encontrado", p.id);
        const key = getPlayerKey(t), s = STATE.baseDatos[key];
        if (esKeyAnonima(key)) return msgError(`${t.name} no tiene auth.`, p.id);
        if (!s) return msgError("Sin perfil", p.id);
        s.vip = !s.vip;
        if (s.vip) s.vip_tier = tp || s.vip_tier || "vip";
        markDirty(key);
        const ti = CONFIG.VIP_TIERS[s.vip_tier] || CONFIG.VIP_TIERS.vip;
        msgSmall(s.vip ? `${ti.emoji} ${t.name} es ${ti.nombre}` : `${t.name} ya no es VIP`, p.id, 0x00FFFF, "small-bold", 1);
    },
    "!liberarnombre": (p, args) => {
        if (!esOwner(p)) return msgError("Solo owner", p.id);
        if (!args.length) return msgError("Uso: !liberarnombre [nombre]", p.id);
        const nv = args.join(" ");
        const lk = `anon_${nv.toLowerCase().trim().replace(/\s+/g, "_")}`;
        const lg = STATE.baseDatos[lk];
        if (!lg) return msgError(`No existe "${nv}"`, p.id);
        if (!lg._reclamado || !lg._reclamadoPor) return msgError(`"${nv}" ya está libre`, p.id);
        const imp = lg._reclamadoPor;
        delete STATE.baseDatos[imp];
        deletePlayerLocal(imp);
        deletePlayerGlobalRow(imp);
        lg._reclamado = false; delete lg._reclamadoPor;
        markDirty(lk);
        logMsg('security.log', `[${ROOM_ID}] Nombre liberado: "${nv}" por ${p.name}`);
        msgSuccess(`"${nv}" quedó libre`, p.id);
    },
    "!liberarreserva": (p, args) => {
        if (!esOwner(p)) return msgError("Solo owner", p.id);
        if (!args.length) return msgError("Uso: !liberarreserva [nombre]", p.id);
        const nn = args.join(" ").toLowerCase().trim();
        if (!STATE.nombresReservados.has(nn)) return msgError(`"${args.join(" ")}" no está reservado`, p.id);
        const du = STATE.nombresReservados.get(nn);
        STATE.nombresReservados.delete(nn);
        liberarNombreReservado(nn);
        logMsg('security.log', `[${ROOM_ID}] Reserva liberada: "${nn}" (era ${du}) por ${p.name}`);
        msgSuccess(`"${args.join(" ")}" quedó libre`, p.id);
    },
    "!addadmin": (p, args) => {
        if (!esOwner(p)) return msgError("Solo owner", p.id);
        const auth = (args[0] || "").trim();
        if (!auth) return msgError("Uso: !addadmin [auth]", p.id);
        if (STATE.adminsAutomaticos.has(auth)) return msgError("Ya está en la lista", p.id);
        STATE.adminsAutomaticos.add(auth);
        agregarAdminAuto(auth, p.name, ROOM_ID);
        const on = STATE.room.getPlayerList().find(pl => STATE.authPorId.get(pl.id) === auth);
        if (on) {
            safeOperation(() => STATE.room.setPlayerAdmin(on.id, true));
            const sy = STATE.baseDatos[auth];
            if (sy && JERARQUIA_RANGOS.indexOf(sy.rango || "normal") < JERARQUIA_RANGOS.indexOf("admin")) { sy.rango = "admin"; markDirty(auth); }
        }
        msgSuccess(`Admin auto agregado: ${auth}`, p.id);
        auditLog(p, "ADD_ADMIN", auth);
    },
    "!deladmin": (p, args) => {
        if (!esOwner(p)) return msgError("Solo owner", p.id);
        const auth = (args[0] || "").trim();
        if (!auth) return msgError("Uso: !deladmin [auth]", p.id);
        if (!STATE.adminsAutomaticos.has(auth)) return msgError("No está en la lista", p.id);
        STATE.adminsAutomaticos.delete(auth);
        quitarAdminAuto(auth);
        const c = STATE.room.getPlayerList().find(pl => STATE.authPorId.get(pl.id) === auth);
        if (c) safeOperation(() => STATE.room.setPlayerAdmin(c.id, false));
        msgSuccess(`Admin auto quitado: ${auth}`, p.id);
        auditLog(p, "DEL_ADMIN", auth);
    },
    "!listadmins": (p) => {
        if (!esOwner(p)) return msgError("Solo owner", p.id);
        if (!STATE.adminsAutomaticos.size) return msgSuccess("Sin admins automáticos", p.id);
        msgCaja("👑 Admins automáticos", [...STATE.adminsAutomaticos].map(auth => { const s = STATE.baseDatos[auth]; const on = STATE.room.getPlayerList().some(pl => STATE.authPorId.get(pl.id) === auth); return `${s?.nombre_actual || auth} ${on ? "🟢" : "⚪"}`; }), COLORES.oro, "small", 0, p.id);
    },
    "!contrasena": (p, args, isA) => { if (!esAdminEfectivo(p, isA)) return; if (!args[0] || args[0].toLowerCase() === "off") { safeOperation(() => STATE.room.setPassword(null)); return msgSuccess("Contraseña desactivada", p.id); } safeOperation(() => STATE.room.setPassword(args.join(" "))); msgSuccess(`Contraseña activada`, p.id); },
    "!temporada": (p, args, isA) => {
        if (!esAdminEfectivo(p, isA)) return;
        const ent = Object.entries(STATE.baseDatos).sort((a, b) => (b[1].mmr || 1000) - (a[1].mmr || 1000)).slice(0, 3);
        if (!ent.length) return msgError("Sin jugadores", p.id);
        STATE.campeones.push({ temporada: STATE.TEMPORADA_ACTUAL, top: ent.map(([, s]) => ({ nombre: s.nombre_actual, mmr: s.mmr })), fecha: Date.now() });
        ent.forEach(([k, s]) => { s.campeonatos = s.campeonatos || []; s.campeonatos.push(STATE.TEMPORADA_ACTUAL); darBadgePorKey(k, "campeon", s.nombre_actual); });
        Object.entries(STATE.baseDatos).forEach(([k, s]) => { s.mmr = Math.round(1000 + (s.mmr - 1000) * 0.5); s.temporada = STATE.TEMPORADA_ACTUAL + 1; actualizarTitulo(k, true); });
        STATE.TEMPORADA_ACTUAL++;
        msgCaja(`🏆 ¡Arrancó Temporada ${STATE.TEMPORADA_ACTUAL}!`, [`👑 Campeones: ${ent.map(([, s]) => s.nombre_actual).join(", ")}`, `🔄 ELO comprimido`], COLORES.oro, "bold", 2, null);
        markDirty();
        auditLog(p, "NEW_SEASON", `T${STATE.TEMPORADA_ACTUAL}`, ent.map(([, s]) => s.nombre_actual).join(","));
    },
    "!records": (p) => { if (!STATE.campeones.length) return msgInfo("Sin campeones aún", p.id); const u = STATE.campeones.slice(-5).reverse(); msgBox("📜 Salón de la fama", u.map(c => `S${c.temporada}: ${c.top.map(t => `${t.nombre}(${t.mmr})`).join(", ")}`), COLORES.oro, "small", 2, p.id); },
    "!tutorial": (p) => { sendAnnouncement(`📘 CÓMO ARRANCAR:\n1️⃣ !jugar entra a la cancha\n2️⃣ Cada partido suma ELO/monedas/XP\n3️⃣ !perfil para ver stats\n4️⃣ !tienda para gastar\n5️⃣ !clan para fundar\n6️⃣ !misiones objetivo diario\n📜 !comandos lista completa`, p.id, COLORES.info, "small-bold", 0); },
    "!comandos": (p, args, isA) => {
        let a = `📜 Comandos\n!jugar !ver !perfil !vs [jug] !tabla !tienda !misiones !figuras\n!goles !asist !figuras !partidos !vallas !horas !monedas !efec\n!enviar !casino !apostar !ruleta !moneda !veintiuno !pedir !plantar !dinero\n!afk !liga [club] !capitanes !votar (💎 !tamano solo VIP)\n!duelo [jug] [monto] !aceptar !rechazar\n!clan crear/invitar/aceptar/salir/info/tabla\n!reportar [jug] [motivo] !records !ids !llamar [motivo]\n🎮 t [msg] equipo · ⚔️ c [msg] clan · @@nombre [msg] privado`;
        if (esAdminEfectivo(p, isA)) a += `\n\n⚡ Admins\n!iniciar !detener !echar !fueraafk !powershot !curva !rainbow !mapa\n!juegantodos !auto !x2jt !x3jt !x5jt !x6jt !x7jt !x4jt !callar !hablar !fairplay\n!ganasigue !goldeoro !swapcol !capitan [jug] !expulsar !contrasena !temporada\n!reportes !status !admin [ID] !verificar [código] !panel [número]`;
        sendAnnouncement(a, p.id, COLORES.blanco, "small-bold", 0);
    },
    "!status": (p) => {
        if (!esOwner(p) && !esAdminEfectivo(p, false)) return msgError("Solo admins/owner", p.id);
        let ps = {}, pg = {};
        try { const x = getPool(); ps = { total: x.totalCount, idle: x.idleCount, waiting: x.waitingCount }; } catch (e) { }
        try { const x = getGlobalPool(); pg = { total: x.totalCount, idle: x.idleCount, waiting: x.waitingCount }; } catch (e) { }
        msgCaja("🩺 ESTADO DEL BOT", [
            `Sala: ${ROOM_ID} (${CONFIG.NOMBRE_SALA})`,
            `Uptime: ${formatUptime(Date.now() - (STATE.inicioSala || Date.now()))}`,
            `Jugadores: ${STATE.room ? STATE.room.getPlayerList().length : 0}`,
            `Partido: ${STATE.partidoEnCurso ? "🟢 en curso" : "⚪ no"}`,
            `isDirty: ${STATE.isDirty} · dirty: ${STATE.dirtyPlayers.size} · fullDiff: ${STATE.fullDiffPendiente}`,
            `Pool sala: ${ps.total || 0} (${ps.idle || 0} idle, ${ps.waiting || 0} espera)`,
            `Pool global: ${pg.total || 0} (${pg.idle || 0} idle, ${pg.waiting || 0} espera)`,
            `Discord CB: ${DISCORD_CB.abiertoHasta > Date.now() ? "🔴 abierto" : "🟢 cerrado"}`,
            `Retry queue: ${RETRY_QUEUE.length}`,
        ], COLORES.info, "small", 0, p.id);
    },
};

// Aliases EN
const ALIAS_EN = { "!help": "!ayuda", "!commands": "!comandos", "!play": "!jugar", "!profile": "!perfil", "!rank": "!rango", "!shop": "!tienda", "!map": "!mapa", "!teams": "!equipos", "!time": "!tiempo", "!live": "!vivo", "!top": "!tabla", "!goals": "!goles", "!assists": "!asist", "!coins": "!monedas", "!missions": "!misiones" };
for (const [a, o] of Object.entries(ALIAS_EN)) if (commands[o] && !commands[a]) commands[a] = commands[o];

// !x2jt..!x7jt
const BRACKETS_FIJOS_JT = { 2: { e: 2, m: ["futx1-2"], l: "X2" }, 3: { e: 3, m: ["futx3"], l: "X3" }, 5: { e: 5, m: ["futx5"], l: "X5" }, 6: { e: 6, m: ["futx6"], l: "X6" }, 7: { e: 7, m: ["futx7"], l: "X7" } };
for (const [n, c] of Object.entries(BRACKETS_FIJOS_JT)) {
    const bf = { max: Infinity, equipoSize: c.e, mapas: c.m };
    commands[`!x${n}jt`] = (p, args, isA) => {
        if (!esAdminEfectivo(p, isA)) return;
        const ya = STATE.automatizadoActivado && STATE.bracketFijo === bf;
        if (!ya) {
            STATE.automatizadoActivado = true; STATE.bracketFijo = bf; STATE.jueganTodosActivo = true; STATE.fairPlayActivo = false;
            msgSmall(`✅ ${c.l}: ON`, p.id, COLORES.exito, "small-bold", 1);
            ejecutarAutomatizado(true);
            if (CONFIG.AUTOMATED_MODE_ANNOUNCE && STATE.room) sendAnnouncement(`⚙️ Modo ${c.l}`, null, COLORES.info, "small", 0);
        } else { STATE.automatizadoActivado = false; STATE.bracketFijo = null; msgSmall(`❌ ${c.l}: OFF`, p.id, COLORES.error, "small-bold", 1); }
    };
}
commands["!x4jt"] = (p, args, isA) => {
    if (!esAdminEfectivo(p, isA)) return;
    const ya = STATE.automatizadoActivado && STATE.bracketFijo === BRACKET_X4_FIJO;
    if (!ya) {
        STATE.automatizadoActivado = true; STATE.bracketFijo = BRACKET_X4_FIJO; STATE.jueganTodosActivo = true; STATE.fairPlayActivo = false;
        msgSmall("✅ X4: ON", p.id, COLORES.exito, "small-bold", 1);
        ejecutarAutomatizado(true);
        if (CONFIG.AUTOMATED_MODE_ANNOUNCE && STATE.room) sendAnnouncement("⚙️ Modo X4", null, COLORES.info, "small", 0);
    } else { STATE.automatizadoActivado = false; STATE.bracketFijo = null; msgSmall("❌ X4: OFF", p.id, COLORES.error, "small-bold", 1); }
};

const ACCIONES_ADMIN_MENU = [
    { numero: 1, etiqueta: "Iniciar", accion: (p, isA) => commands["!iniciar"](p, [], isA) },
    { numero: 2, etiqueta: "Detener", accion: (p, isA) => commands["!detener"](p, [], isA) },
    { numero: 3, etiqueta: "Mapa x5", accion: (p, isA) => commands["!mapa"](p, ["futx5"], isA) },
    { numero: 4, etiqueta: "Powershot", accion: (p, isA) => commands["!powershot"](p, [], isA) },
    { numero: 5, etiqueta: "Kick AFK", accion: (p, isA) => commands["!fueraafk"](p, [], isA) },
    { numero: 6, etiqueta: "Balancear", accion: (p, isA) => { const j = STATE.room.getPlayerList().filter(x => x.team !== 0); if (j.length < 2) return msgError("Pocos en cancha", p.id); const { equipo1, equipo2 } = balancearEquiposElo(j); equipo1.forEach(x => STATE.room.setPlayerTeam(x.id, 1)); equipo2.forEach(x => STATE.room.setPlayerTeam(x.id, 2)); msgBox(`⚖️ Balanceados`, [`Por: ${p.name}`], COLORES.exito, "small-bold", 2, p.id); } },
    { numero: 7, etiqueta: "Auto", accion: (p, isA) => commands["!auto"](p, [], isA) },
];
commands["!menuadm"] = (p, args, isA) => {
    if (!esAdminEfectivo(p, isA)) return msgError("Solo admins", p.id);
    const filas = [];
    for (let i = 0; i < ACCIONES_ADMIN_MENU.length; i += 2) {
        const a = ACCIONES_ADMIN_MENU[i], b = ACCIONES_ADMIN_MENU[i + 1];
        filas.push(b ? `[${a.numero}] ${a.etiqueta}   [${b.numero}] ${b.etiqueta}` : `[${a.numero}] ${a.etiqueta}`);
    }
    sendAnnouncement(`👑 PANEL — !panel [número]\n${filas.join("\n")}`, p.id, COLORES.oro, "small-bold", 0);
};
commands["!panel"] = (p, args, isA) => {
    if (!esAdminEfectivo(p, isA)) return msgError("Solo admins", p.id);
    const num = parseInt(args[0], 10);
    const op = ACCIONES_ADMIN_MENU.find(o => o.numero === num);
    if (!op) return msgError("Opción inválida", p.id);
    op.accion(p, isA);
};

// ── ELO / XP / Títulos ──
function actualizarTitulo(pOrK, sil = false) {
    let key, nom, tid = null;
    if (typeof pOrK === "string") { key = pOrK; nom = STATE.baseDatos[key]?.nombre_actual || "Jugador"; }
    else { key = getPlayerKey(pOrK); nom = pOrK.name; tid = pOrK.id; }
    const s = STATE.baseDatos[key]; if (!s || s.titulo_custom) return;
    let nv = "bronce1";
    for (const [k, t] of Object.entries(TITULOS)) if (s.mmr >= t.req) nv = k;
    if (s.titulo !== nv) {
        const nt = getTituloSeguro(nv);
        const sub = nt.req > getTituloSeguro(s.titulo).req;
        if (!sil) {
            const sg = getSiguienteRango(nv);
            const pr = sub && sg ? ` (${Math.max(0, sg.req - s.mmr)} ELO para ${sg.nombre})` : "";
            let t;
            if (sub) {
                const alt = ["diamante1", "diamante2", "maestro", "gran_maestro"].includes(nv);
                const em = nv === "leyenda" ? "👑" : alt ? "🔥" : "🎉";
                const vr = nv === "leyenda" ? "llegó a" : alt ? "alcanzó" : "subió a";
                t = tid ? `${em} Subiste a ${nt.nombre}${pr}` : `${em} ${nom} ${vr} ${nt.nombre}${pr}`;
            } else t = tid ? `⬇️ Bajaste a ${nt.nombre}` : `⬇️ ${nom} bajó a ${nt.nombre}`;
            msgSmall(t, tid, nt.color, "small-bold", sub ? 1 : 0);
        }
        s.titulo = nv; invalidarCache("titulos", key);
        if (nt.req > getTituloSeguro(s.max_rank || "bronce1").req) s.max_rank = nv;
    }
    markDirty(key);
}
function darXP(player, cantidad) {
    const key = player.key || getPlayerKey(player);
    const s = STATE.baseDatos[key]; if (!s || !validarCantidad(cantidad, 0)) return;
    if (s.boost_xp_activo) { cantidad *= 2; s.boost_xp_activo = false; msgSmall(`⚡ ¡Boost XP x2!`, player.id, 0xAA00FF, "small-bold", 1); }
    s.xp += cantidad;
    const nv = Math.floor(s.xp / 100) + 1;
    if (nv > s.nivel) {
        let bonus = 0;
        for (let n = s.nivel + 1; n <= nv; n++) bonus += n * 10;
        s.nivel = nv; s.monedas += bonus;
        msgSmall(`🎉 Subiste a nivel ${nv} (+${bonus}💰)`, player.id, COLORES.oro, "small-bold", 1);
        if (nv >= 10 && !s.badges.includes("nivel_10")) darBadge(player, "nivel_10");
        if (nv >= 25 && !s.badges.includes("nivel_25")) darBadge(player, "nivel_25");
    }
    markDirty(key);
}
function kFactorPara(part, mmr) { if (part > 100 && mmr >= CONFIG.ELO_TOP_UMBRAL) return CONFIG.ELO_K_TOP; if (part > 100) return CONFIG.ELO_K_VETERANO; if (part > 30) return CONFIG.ELO_K_INTERMEDIO; return CONFIG.ELO_K_NOVATO; }
function calcularPerformanceMultiplier({ goles = 0, asistencias = 0, atajadas = 0, autogoles = 0, vallaInvicta = false, segundosAfk = 0 }) {
    let sc = 0; sc += goles * 3 + asistencias * 2 + atajadas * 1.2;
    if (vallaInvicta) sc += 3;
    sc -= autogoles * 4; sc -= Math.min(segundosAfk / 60, 5);
    if (sc >= 0) return Math.min(CONFIG.ELO_PERF_MULT_MAX, (sc / 8) * CONFIG.ELO_PERF_MULT_MAX);
    return Math.max(CONFIG.ELO_PERF_MULT_MIN, (sc / 8) * Math.abs(CONFIG.ELO_PERF_MULT_MIN));
}
function calcularBonusRacha(r) { if (r >= 10) return CONFIG.ELO_RACHA_10; if (r >= 5) return CONFIG.ELO_RACHA_5; if (r >= 3) return CONFIG.ELO_RACHA_3; return 0; }
function calcularCambioElo(eloJ, eloR, res, part, aj = 0, aband = false) {
    const K = kFactorPara(part, eloJ);
    const dif = Math.max(-400, Math.min(400, eloR - eloJ));
    const exp = 1 / (1 + Math.pow(10, dif / 400));
    const base = K * (res - exp);
    const fac = base >= 0 ? (1 + aj) : (1 - aj);
    let cam = Math.round(base * fac);
    if (res === 1) cam = Math.max(CONFIG.ELO_CAMBIO_MIN_GANANDO, Math.min(CONFIG.ELO_CAMBIO_MAX, cam));
    else if (res === 0) cam = Math.min(-CONFIG.ELO_CAMBIO_MIN_PERDIENDO, Math.max(-CONFIG.ELO_CAMBIO_MAX, cam));
    else cam = Math.max(-Math.round(CONFIG.ELO_CAMBIO_MAX / 3), Math.min(Math.round(CONFIG.ELO_CAMBIO_MAX / 3), cam));
    if (aband) cam -= CONFIG.ELO_PENALIZACION_ABANDONO;
    return cam;
}
function aplicarCambioEloPartido(s, { eloRival, resultado, cambio, motivo }) {
    const ant = s.mmr;
    s.mmr = Math.max(0, s.mmr + cambio);
    const real = s.mmr - ant;
    if (s.mmr > (s.peak_elo || 0)) s.peak_elo = s.mmr;
    if (!Array.isArray(s.historial)) s.historial = [];
    s.historial.push({ fecha: Date.now(), rival_elo: Math.round(eloRival), antes: ant, despues: s.mmr, diferencia: real, motivo });
    if (s.historial.length > 20) s.historial.shift();
    return real;
}
function chequearAntiSmurf(player, s) {
    if (s.partidos > CONFIG.ANTISMURF_PARTIDOS_MAX) return;
    if (s.racha < CONFIG.ANTISMURF_RACHA_MIN) return;
    const wr = s.partidos > 0 ? s.victorias / s.partidos : 0;
    if (wr < CONFIG.ANTISMURF_WINRATE_MIN) return;
    logMsg('security.log', `[${ROOM_ID}] Posible smurf: ${player.name} (${s.partidos}p, racha ${s.racha}, ${Math.round(wr * 100)}%, ELO ${s.mmr})`);
}
function verificarBadgesPostPartido(player, s, gE) {
    if (!s.badges.includes("primer_gol") && s.goles >= 1) darBadge(player, "primer_gol");
    if (!s.badges.includes("goleador_10") && s.goles >= 10) darBadge(player, "goleador_10");
    if (!s.badges.includes("goleador_50") && s.goles >= 50) darBadge(player, "goleador_50");
    if (!s.badges.includes("goleador_100") && s.goles >= 100) darBadge(player, "goleador_100");
    if (gE >= 4 && !s.badges.includes("poker")) darBadge(player, "poker");
    else if (gE >= 3 && !s.badges.includes("hat_trick")) darBadge(player, "hat_trick");
    if (!s.badges.includes("racha_5") && s.racha >= 5) darBadge(player, "racha_5");
    if (!s.badges.includes("racha_10") && s.racha >= 10) darBadge(player, "racha_10");
    if (!s.badges.includes("veterano_50") && s.partidos >= 50) darBadge(player, "veterano_50");
    if (!s.badges.includes("veterano_100") && s.partidos >= 100) darBadge(player, "veterano_100");
    if (!s.badges.includes("anti_ragequit") && s.partidos >= 20 && s.ragequits === 0) darBadge(player, "anti_ragequit");
}
function xpNecesariaParaNivel(n) { return n * CONFIG.CLAN_XP_BASE_NIVEL; }
function sumarXPClan(id, c) {
    const cl = STATE.clanes[id]; if (!cl) return;
    cl.nivel = cl.nivel || 1; cl.xp = (cl.xp || 0) + c;
    const req = xpNecesariaParaNivel(cl.nivel);
    if (cl.xp >= req) {
        cl.xp -= req; cl.nivel++;
        STATE.room.getPlayerList().forEach(pl => { if (STATE.baseDatos[getPlayerKey(pl)]?.clan === id) msgSmall(`⚔️ ${cl.nombre} llegó a Nivel ${cl.nivel}`, pl.id, 0xFF00FF, "small-bold", 1); });
    }
}
function detectarYAnunciarRivalidad() {
    STATE.rivalidadDelPartido = null;
    const r = STATE.room.getPlayerList().filter(p => p.team === 1);
    const a = STATE.room.getPlayerList().filter(p => p.team === 2);
    if (!r.length || !a.length) return;
    let me = null;
    for (const pr of r) {
        const kr = getPlayerKey(pr), sr = STATE.baseDatos[kr];
        if (!sr?.historial_vs) continue;
        for (const pa of a) {
            const ka = getPlayerKey(pa);
            const h = sr.historial_vs[ka]; if (!h) continue;
            const t = h.victorias + h.derrotas + h.empates;
            if (t < CONFIG.RIVALIDAD_MIN_PARTIDOS) continue;
            if (!me || t > me.total) me = { pRojo: pr, pAzul: pa, keyRojo: kr, keyAzul: ka, h, total: t };
        }
    }
    if (!me) return;
    STATE.rivalidadDelPartido = { keyRojo: me.keyRojo, keyAzul: me.keyAzul, nombreRojo: me.pRojo.name, nombreAzul: me.pAzul.name };
    const { victorias, derrotas, empates } = me.h;
    sendAnnouncement(`⚔️ Rivalidad: ${me.pRojo.name} vs ${me.pAzul.name} — ${victorias}V ${derrotas}D${empates ? ` ${empates}E` : ""}`, null, COLORES.oro, "bold", 1);
}
function getFiguraDelPartido() {
    const ps = STATE.room.getPlayerList().filter(p => p.team !== 0);
    let mx = -1, fg = null;
    ps.forEach(p => { const s = STATE.matchStats[p.id] || { goles: 0, asistencias: 0 }; const pt = s.goles + s.asistencias * 0.7; if (pt > mx) { mx = pt; fg = p; } });
    return fg;
}
function otorgarMVP(player) {
    if (!player) return;
    const k = getPlayerKey(player), s = STATE.baseDatos[k]; if (!s) return;
    s.mvps = (s.mvps || 0) + 1;
    s.monedas += CONFIG.MVP_MONEDAS;
    darXP(player, CONFIG.MVP_XP);
    if (s.mvps >= 5 && !s.badges.includes("mvp_5")) darBadge(player, "mvp_5");
    if (s.mvps >= 20 && !s.badges.includes("mvp_20")) darBadge(player, "mvp_20");
    markDirty(k);
    sendAnnouncement(`🌟 MVP: ${player.name}`, null, COLORES.oro, "bold", 1);
    msgSmall(`🎉 MVP · +${CONFIG.MVP_MONEDAS}💰 +${CONFIG.MVP_XP}XP`, player.id, COLORES.oro, "small-bold", 1);
}
function iniciarVotacionMVP(f) { if (f) otorgarMVP(f); }

// ─── EVENTOS ───
function setupEvents() {
    STATE.room.onPlayerJoin = async function(player) {
        try {
            if (player.id === STATE.BOT_ID) return;
            const nomOrig = player.name, authOrig = player.auth, connOrig = player.conn;
            await new Promise(r => setTimeout(r, 400));
            const ju = STATE.room.getPlayer(player.id);
            if (!ju || ju.name !== nomOrig) return;
            player = { ...ju, auth: authOrig, conn: connOrig };
            if (player.auth) STATE.authPorId.set(player.id, player.auth);
            if (player.conn) STATE.connPorId.set(player.id, player.conn);

            {
                const kr = getPlayerKey(player);
                const ab = STATE.abandonos.get(kr);
                if (ab && (Date.now() - ab.ts) < CONFIG.ELO_RECONEXION_GRACIA_MS) { STATE.abandonos.delete(kr); msgSmall(`👋 Volviste a tiempo`, player.id, COLORES.info, "small", 0); }
            }

            if (!esOwner(player)) {
                const nn = player.name.toLowerCase().trim();
                const ka = getPlayerKey(player);
                const du = STATE.nombresReservados.get(nn);
                if (du && du !== ka) { STATE.room.kickPlayer(player.id, `Ese nombre ya es de otro. Entrá con otro.`, false); return; }
                if (!du && player.auth) {
                    await reservarNombre(nn, ka, ROOM_ID);
                    try {
                        const { rows } = await getGlobalPool().query(`SELECT owner_key FROM nombres_reservados WHERE nombre = $1`, [nn]);
                        if (rows[0] && rows[0].owner_key && rows[0].owner_key !== ka) {
                            STATE.nombresReservados.set(nn, rows[0].owner_key);
                            STATE.room.kickPlayer(player.id, "Ese nombre ya es de otro.", false);
                            return;
                        }
                    } catch (e) { }
                    STATE.nombresReservados.set(nn, ka);
                }
            }

            if (CONFIG.REQUIRE_AUTH_TO_PLAY && !player.auth && !esOwner(player)) msgWarn("Necesitás cuenta Haxball para jugar", player.id);
            const s = initStats(player);
            if (s.blacklisted) { STATE.room.kickPlayer(player.id, "Estás en lista negra.", false); return; }
            if (s.ban_hasta && Date.now() < s.ban_hasta) { const h = Math.ceil((s.ban_hasta - Date.now()) / 3600000); STATE.room.kickPlayer(player.id, `Baneado. Faltan ${h}h.`, false); return; }
            if (player.auth && STATE.adminsAutomaticos.has(player.auth)) {
                safeOperation(() => STATE.room.setPlayerAdmin(player.id, true));
                if (JERARQUIA_RANGOS.indexOf(s.rango || "normal") < JERARQUIA_RANGOS.indexOf("admin")) { s.rango = "admin"; markDirty(getPlayerKey(player)); }
            }
            const t = obtenerTitulo(player), b = obtenerBadges(player);
            const wr = s.partidos > 0 ? Math.round((s.victorias / s.partidos) * 100) : 0;
            const nR = t.esCustom ? `${t.nombre} (${t.rango})` : t.nombre;
            const vT = s.vip ? `  ${tierVipDe(s).nombre}` : "";
            const rT = actualizarRachaDiaria(player, s);
            const ls = [`${nR}${b ? "  " + b : ""}${vT}`, s.partidos > 0 ? `Nivel ${s.nivel} · ELO ${s.mmr} · ${wr}% en ${s.partidos} partidos${s.racha >= 2 ? ` · 🔥${s.racha}` : ""}` : `Nivel ${s.nivel} · ELO ${s.mmr} · recién arrancás`, `💰 ${s.monedas}`];
            if (rT) ls.push(rT);
            msgCaja(`⚽ ¡Bienvenido, ${player.name}!`, ls, t.color, "bold", 1, player.id);
            if (!s.intro_vista) {
                s.intro_vista = true; markDirty(getPlayerKey(player));
                msgCaja(`👋 Bienvenido a ${CONFIG.NOMBRE_SALA}`, [`Es tu primera vez:`, `🤖 La sala la maneja 『𝗕𝗮𝗵𝗜𝗔』 — tablas, niveles, logros automáticos.`, `📖 !ayuda o !comandos`, `💬 ${CONFIG.DISCORD_INVITE}`], COLORES.info, "small", 0, player.id);
            }
            if (s.msg_join) sendAnnouncement(`${player.name}: ${s.msg_join}`, player.id, s.color_nombre || 0x00FFFF, "small-bold", 1);
            const cj = STATE.room.getPlayerList().length - 1;
            notificarJoinLeave(construirEmbed({ title: "🟢 Conectado", description: `**${player.name}** entró`, color: 0x00FF88, footer: `${cj}/30` }));
            if (STATE.liveStatsMessageId) editarMensajeLive(STATE.liveStatsMessageId, embedEstadoSala());
            if (STATE.automatizadoActivado && !player.admin) {
                if (STATE.partidoEnCurso) {
                    const ac = STATE.room.getPlayerList().filter(p => !p.admin);
                    const r = ac.filter(p => p.team === 1).length, b2 = ac.filter(p => p.team === 2).length;
                    STATE.room.setPlayerTeam(player.id, r <= b2 ? 1 : 2);
                } else {
                    const ac = STATE.room.getPlayerList().filter(p => !STATE.afkPlayers.has(p.id) && !p.admin);
                    const r = ac.filter(p => p.team === 1).length, b2 = ac.filter(p => p.team === 2).length;
                    if (r < STATE.maxPlayersPerTeam && r <= b2) STATE.room.setPlayerTeam(player.id, 1);
                    else if (b2 < STATE.maxPlayersPerTeam) STATE.room.setPlayerTeam(player.id, 2);
                    else if (r < STATE.maxPlayersPerTeam) STATE.room.setPlayerTeam(player.id, 1);
                    else STATE.room.setPlayerTeam(player.id, 0);
                }
            } else if (STATE.jueganTodosActivo && !player.admin) {
                const r = STATE.room.getPlayerList().filter(x => x.team === 1).length;
                const b2 = STATE.room.getPlayerList().filter(x => x.team === 2).length;
                STATE.room.setPlayerTeam(player.id, r <= b2 ? 1 : 2);
            } else STATE.room.setPlayerTeam(player.id, 0);
            setTimeout(() => { const p = STATE.room.getPlayer(player.id); if (p && p.team !== 0) aplicarTamanoPersistente(p); }, 100);
        } catch (e) { logMsg('errors.log', `[${ROOM_ID}] Error onPlayerJoin: ${e.message}\n${e.stack}`); }
    };

    STATE.room.onPlayerLeave = function(player) {
        try {
            if (player.id === STATE.BOT_ID) return;
            const key = getPlayerKey(player);
            const s = STATE.baseDatos[key];
            const vol = STATE.salidasVoluntarias.has(player.id);
            STATE.salidasVoluntarias.delete(player.id);
            if (STATE.partidoEnCurso && player.team !== 0 && !vol) {
                STATE.abandonos.set(key, { team: player.team, ts: Date.now(), stats: { ...(STATE.matchStats[player.id] || { goles: 0, asistencias: 0, atajadas: 0 }) } });
            }
            if (!vol) { if (s?.msg_leave) sendAnnouncement(`${player.name}: ${s.msg_leave}`, null, s.color_nombre || 0x00FFFF, "small-bold", 1); else msgSmall(`👋 Se piró ${player.name}`, null, COLORES.info, "small", 0); }
            const cj = STATE.room.getPlayerList().length - 2;
            notificarJoinLeave(construirEmbed({ title: "🔴 Desconectado", description: `**${player.name}** salió`, color: 0xFF3366, footer: `${Math.max(cj, 0)}/30` }));
            if (STATE.liveStatsMessageId) editarMensajeLive(STATE.liveStatsMessageId, embedEstadoSala());
            delete STATE.matchStats[player.id];
            STATE.afkPlayers.delete(player.id); delete STATE.afkDesde[player.id]; STATE.afkAvisado30s.delete(player.id);
            STATE.afkCooldown.delete(key);
            delete STATE.ultimoToggleAfk[player.id];
            delete STATE.ultimoJugar[player.id];
            delete STATE.mensajesRecientes[key];
            for (const ck of Array.from(STATE.cooldownsCmd.keys())) if (ck.startsWith(`${key}:`)) STATE.cooldownsCmd.delete(ck);
            delete STATE.clanInvitaciones[key];
            if (STATE.powershotID === player.id) resetPowershotState();
            if (STATE.festejosVipActivos[player.id]) finalizarFestejoVip(player);
            delete STATE.festejosVipActivos[player.id];
            if (STATE.blackjackActivo[player.id]) { const m = STATE.blackjackActivo[player.id]; const st = STATE.baseDatos[m.key]; if (st) { st.monedas += m.cantidad; markDirty(m.key); } delete STATE.blackjackActivo[player.id]; }
            if (STATE.gkReservado[1] === player.id) STATE.gkReservado[1] = null;
            if (STATE.gkReservado[2] === player.id) STATE.gkReservado[2] = null;
            delete STATE.gkUltimoWarn[player.id];
            delete STATE.zonaArcoDesde[player.id]; delete STATE.zonaArcoUltimoAviso[player.id];
            delete STATE.playerPositions[player.id]; delete STATE.playerLastMove[player.id];
            STATE.authPorId.delete(player.id); STATE.connPorId.delete(player.id);
            STATE.radioJugadorCache.delete(player.id);
            const ig = STATE.animacionGolIntervalos.get(player.id); if (ig) clearInterval(ig); STATE.animacionGolIntervalos.delete(player.id);
            STATE.animacionGolIntervalos.delete(player.id); STATE.animacionGolActiva.delete(player.id); STATE.animacionGolTokenPorId.delete(player.id);
            if (STATE.partidoEnCurso) for (const t of [1, 2]) if (STATE.capitanes[t] === player.id) asegurarCapitan(t, { anunciar: true });
            if (STATE.automatizadoActivado) ejecutarAutomatizado();
        } catch (e) { logMsg('errors.log', `[${ROOM_ID}] Error onPlayerLeave: ${e.message}\n${e.stack}`); }
    };

    STATE.room.onPlayerTeamChange = function(ch) {
        try {
            if (ch.team !== 0 && STATE.afkPlayers.has(ch.id)) {
                STATE.afkPlayers.delete(ch.id); delete STATE.afkDesde[ch.id]; STATE.afkAvisado30s.delete(ch.id);
                STATE.playerLastMove[ch.id] = Date.now();
                if (ch.position) STATE.playerPositions[ch.id] = { x: ch.position.x, y: ch.position.y };
            }
            for (const t of [1, 2]) if (STATE.gkReservado[t] === ch.id && ch.team !== t) { STATE.gkReservado[t] = null; delete STATE.gkUltimoWarn[ch.id]; }
            if (ch.team !== 0) setTimeout(() => aplicarTamanoPersistente(ch), 50);
            if (!STATE.partidoEnCurso) return;
            for (const t of [1, 2]) { const ci = STATE.capitanes[t]; if (ci == null) { asegurarCapitan(t, { anunciar: true }); continue; } const c = STATE.room.getPlayer(ci); if (!c || c.team !== t) asegurarCapitan(t, { anunciar: true }); }
        } catch (e) { logMsg('errors.log', `[${ROOM_ID}] Error onPlayerTeamChange: ${e.message}`); }
    };

    STATE.room.onGameTick = function() {
        try {
            const jt = STATE.room.getPlayerList();
            const bp = safeOperation(() => STATE.room.getBallPosition());
            const bpt = safeOperation(() => STATE.room.getDiscProperties(0));
            handlePowerShot(jt, bp, bpt);
            manejarEstelaVip();
            if (!STATE.partidoEnCurso) return;
            const sc = STATE.room.getScores();
            if (sc) STATE.ultimoMarcadorConocido = { red: sc.red, blue: sc.blue, time: sc.time, scoreLimit: sc.scoreLimit, timeLimit: sc.timeLimit };
            const bF = aplicarComba(bp, bpt, jt);
            limitarVelocidadPelota(bF || bpt);
            manejarFestejosVip(jt);
            manejarRainbowEquipo(bp);   // usa ballPos para detectar saque
            if (bp) jt.forEach(p => { if (p.team === 0 || !p.position) return; if (pointDistance(p.position, bp) < 25) { if (p.team === 1) STATE.equipoRojoPosesion++; else if (p.team === 2) STATE.equipoAzulPosesion++; } });
            detectArquero(jt);
            revisarArquerosReservados(jt, bp);
            sugerirGkAJugadoresEnArco(jt);
            aplicarTamanosPersistentes();
            mantenerPelotaEnCancha(bp);
        } catch (e) { logMsg('errors.log', `[${ROOM_ID}] Error onGameTick: ${e.message}\n${e.stack}`); }
    };

    STATE.room.onPlayerBallKick = function(player) {
        try {
            if (!STATE.partidoEnCurso) return;
            const ahora = Date.now();
            const vK = calcularVelocidadTiro();
            const pX = safeOperation(() => STATE.room.getBallPosition())?.x ?? null;
            const kT = getPlayerKey(player);
            STATE.toquesRecientes.push({ id: player.id, name: player.name, team: player.team, tiempo: ahora, velocidadKmh: vK, posX: pX, key: kT });
            if (STATE.toquesRecientes.length > CONFIG.MAX_TOQUES_RECIENTES) STATE.toquesRecientes.shift();
            if (!STATE.matchStats[player.id]) STATE.matchStats[player.id] = { goles: 0, asistencias: 0, ultimoFuePowerShot: 0 };
            if (player.team === 1 || player.team === 2) {
                if (STATE.tiroPeligroso && STATE.tiroPeligroso.team === player.team && (ahora - STATE.tiroPeligroso.ts) < CONFIG.ATAJADA_VENTANA_MS) {
                    const bA = safeOperation(() => STATE.room.getBallPosition());
                    const lim = bA ? getLimitesCancha() : null;
                    const mAX = lim ? (player.team === 1 ? -lim.maxX : lim.maxX) : null;
                    const cC = mAX !== null && Math.abs(bA.x - mAX) < CONFIG.ATAJADA_ZONA_DISTANCIA * 1.3;
                    if (cC) {
                        const sA = STATE.baseDatos[kT];
                        if (sA) {
                            sA.atajadas = (sA.atajadas || 0) + 1;
                            STATE.matchStats[player.id].atajadas = (STATE.matchStats[player.id].atajadas || 0) + 1;
                            if (sA.atajadas >= 10 && !sA.badges.includes("atajador_10")) darBadge(player, "atajador_10");
                            else if (sA.atajadas >= 50 && !sA.badges.includes("atajador_50")) darBadge(player, "atajador_50");
                            if (STATE.tiroPeligroso.esPowerShot) darBadge(player, "atajada_powershot");
                            const m = STATE.ultimoMarcadorConocido;
                            if (m && m.timeLimit > 0 && m.time >= (m.timeLimit * 60 - 30)) { const d = player.team === 1 ? (m.red - m.blue) : (m.blue - m.red); if (d === 1) darBadge(player, "arquero_heroe"); }
                            markDirty(kT);
                            msgMini(`🧤✋ ¡Tapadón de ${player.name}!`, null, player.team === 1 ? 0xFF3366 : 0x1E90FF, 0);
                        }
                    }
                    STATE.tiroPeligroso = null;
                } else {
                    const bP = safeOperation(() => STATE.room.getBallPosition());
                    const bPr = safeOperation(() => STATE.room.getDiscProperties(0));
                    const lim = bP && bPr ? getLimitesCancha() : null;
                    if (lim && vK !== null && vK >= CONFIG.ATAJADA_MIN_KMH) {
                        const eD = player.team === 1 ? 2 : 1;
                        const gX = eD === 1 ? -lim.maxX : lim.maxX;
                        const dist = Math.abs(bP.x - gX);
                        const va = gX < 0 ? bPr.xspeed < 0 : bPr.xspeed > 0;
                        if (va && dist < CONFIG.ATAJADA_ZONA_DISTANCIA) STATE.tiroPeligroso = { team: eD, ts: ahora };
                    }
                }
            }
            STATE.matchStats[player.id].ultimoToque = ahora;
            const fps = handlePowerShotKick(player);
            if (fps) STATE.matchStats[player.id].ultimoFuePowerShot = ahora;
            if (STATE.tiroPeligroso && STATE.tiroPeligroso.ts === ahora) STATE.tiroPeligroso.esPowerShot = fps;
            if (!fps && STATE.powershotID === 0 && !STATE.festejosVipActivos[player.id]) {
                const sT = STATE.baseDatos[kT];
                if (sT?.vip) {
                    const tT = tierVipDe(sT);
                    STATE.vipBallTrailActivo = true; STATE.vipBallTrailTick = 0; STATE.vipBallTrailTier = tT;
                    safeOperation(() => STATE.room.setDiscProperties(0, { color: `0x${tT.gradA}` }));
                    ultimoColorPelotaEnviado = tT.gradA;
                } else if (STATE.vipBallTrailActivo) { STATE.vipBallTrailActivo = false; restaurarColorPelotaSiLibre(); }
            }
        } catch (e) { logMsg('errors.log', `[${ROOM_ID}] Error onPlayerBallKick: ${e.message}\n${e.stack}`); }
    };

    STATE.room.onTeamGoal = function(team) {
        try {
            const sc = STATE.room.getScores();
            const ahora = Date.now();
            if (STATE.golDeOroActivo && sc && sc.time > (sc.timeLimit * 60 - 60)) { msgBox(`🥇 ¡GOL DE ORO!`, [`¡${team === 1 ? "ROJO" : "AZUL"} GANA!`], COLORES.oro, "small-bold", 2); setTimeout(() => STATE.room.stopGame(), 3000); }
            const tE = STATE.toquesRecientes.filter(t => t.team === team && ahora - t.tiempo < CONFIG.ASISTENCIA_VENTANA_MS);
            const gT = tE[tE.length - 1];
            const vK = gT?.velocidadKmh ?? calcularVelocidadTiro();
            const gol = gT ? STATE.room.getPlayerList().find(p => p.id === gT.id) : null;
            if (gol) animarCrecimientoGoleador(gol.id);

            let autoAn = false;
            if (!gT) {
                const eR = team === 1 ? 2 : 1;
                const tR = STATE.toquesRecientes.filter(t => t.team === eR && ahora - t.tiempo < CONFIG.ASISTENCIA_VENTANA_MS);
                const tA = tR[tR.length - 1];
                if (tA && STATE.matchStats[tA.id]) {
                    STATE.matchStats[tA.id].autogoles = (STATE.matchStats[tA.id].autogoles || 0) + 1;
                    const jA = STATE.room.getPlayerList().find(p => p.id === tA.id);
                    const kA = tA.key || (jA ? getPlayerKey(jA) : null);
                    if (kA && STATE.baseDatos[kA]) { STATE.baseDatos[kA].autogoles = (STATE.baseDatos[kA].autogoles || 0) + 1; markDirty(kA); }
                    if (jA) { sendAnnouncement(`😂 Gol en contra de ${jA.name}`, null, eR === 1 ? 0xFF3366 : 0x1E90FF, "small", 0); autoAn = true; }
                }
            }
            if (sc && STATE.peorDesventaja) { const eR = team === 1 ? 2 : 1; const dA = team === 1 ? (sc.red - sc.blue) : (sc.blue - sc.red); if (dA > (STATE.peorDesventaja[eR] || 0)) STATE.peorDesventaja[eR] = dA; }
            if (gT && STATE.matchStats[gT.id]) {
                STATE.matchStats[gT.id].goles++;
                const esPS = STATE.matchStats[gT.id].ultimoFuePowerShot && ahora - STATE.matchStats[gT.id].ultimoFuePowerShot < 3000;
                const tit = esPS ? "💥 ¡GOLAZO DE POWER SHOT!" : FRASES_GOL_TITULOS[Math.floor(Math.random() * FRASES_GOL_TITULOS.length)];
                if (gol) {
                    if (gT.posX !== null && gT.posX !== undefined) { const lg = getLimitesCancha(); const gX = team === 1 ? lg.maxX : -lg.maxX; if (Math.abs(gT.posX - gX) > 250) darBadge(gol, "gol_distancia"); }
                    if (vK !== null && vK >= 100) darBadge(gol, "gol_misilazo");
                    if (sc && sc.time <= 10) darBadge(gol, "gol_relampago");
                    if (sc && sc.timeLimit > 0 && sc.time >= (sc.timeLimit * 60 - 10)) darBadge(gol, "gol_agonico");
                    const mj = STATE.matchStats[gT.id];
                    if (mj.ultimoGolTs && (ahora - mj.ultimoGolTs) < 30000) darBadge(gol, "doblete_veloz");
                    mj.ultimoGolTs = ahora;
                }
                let aT = null;
                for (let i = tE.length - 2; i >= 0; i--) { const tp = tE[i]; if (tp.id !== gT.id) { aT = tp; break; } }
                const asis = aT ? STATE.room.getPlayerList().find(p => p.id === aT.id) : null;
                if (aT && STATE.matchStats[aT.id]) {
                    STATE.matchStats[aT.id].asistencias++;
                    const kA = aT.key || getPlayerKey({ id: aT.id, auth: asis?.auth, name: aT.name });
                    const sA = STATE.baseDatos[kA];
                    if (sA) {
                        sA.asistencias++;
                        if (sA.asistencias >= 10 && !sA.badges.includes("asistencia_10")) darBadge(asis || aT, "asistencia_10");
                        else if (sA.asistencias >= 50 && !sA.badges.includes("asistencia_50")) darBadge(asis || aT, "asistencia_50");
                        else if (sA.asistencias >= 100 && !sA.badges.includes("asistencia_100")) darBadge(asis || aT, "asistencia_100");
                        markDirty(kA);
                    }
                }
                const fr = ["🔥 Rompe la defensa", "🧠 Definición fría", "💨 No lo vieron venir", "🎯 Al ángulo", "🌪️ Relámpago", "🦵 Con clase"];
                anunciarGol(tit, team, gT.name, aT ? aT.name : null, vK, sc, fr[Math.floor(Math.random() * fr.length)]);
                activarRainbowEquipo(team);   // ← camiseta rainbow
                if (gol) {
                    const sV = STATE.baseDatos[getPlayerKey(gol)];
                    if (sV?.vip) iniciarFestejoVip(gol);
                    else if (sV?.festejo_fuego_activo) { sV.festejo_fuego_activo = false; markDirty(getPlayerKey(gol)); iniciarFestejoVip(gol); }
                }
                if (STATE.eventoGolX2Activo) {
                    STATE.eventoGolX2Activo = false;
                    const kG = gol ? getPlayerKey(gol) : null;
                    const sG = kG ? STATE.baseDatos[kG] : null;
                    if (sG) { sG.monedas += 50; markDirty(kG); msgGame(`🎲 ¡Gol x2! ${gT.name} +50💰`, null, COLORES.oro, 1); }
                }
            } else if (sc && !autoAn) {
                anunciarGol(`${EMOJIS.soccer} ${EMOJIS.sparkles} GOOOL!`, team, `Equipo ${team === 1 ? "ROJO" : "AZUL"}`, null, vK, sc);
                activarRainbowEquipo(team);
            }
            STATE.toquesRecientes = []; STATE.tiroPeligroso = null; resetPowershotState();
            if (sc) STATE.ultimoMarcadorConocido = { red: sc.red, blue: sc.blue, time: sc.time, scoreLimit: sc.scoreLimit, timeLimit: sc.timeLimit };
            if (STATE.liveStatsMessageId) editarMensajeLive(STATE.liveStatsMessageId, embedEstadoSala());
            const reap = () => STATE.room.getPlayerList().filter(p => p.team !== 0 && !STATE.animacionGolActiva.has(p.id)).forEach(aplicarTamanoPersistente);
            setTimeout(reap, 100);
        } catch (e) { logMsg('errors.log', `[${ROOM_ID}] Error onTeamGoal: ${e.message}\n${e.stack}`); }
    };

    STATE.room.onGameStart = function() {
        try {
            STATE.matchStats = {}; STATE.toquesRecientes = [];
            STATE.equipoRojoPosesion = 0; STATE.equipoAzulPosesion = 0;
            STATE.inicioPartido = Date.now(); STATE.partidoEnCurso = true;
            STATE.peorDesventaja = { 1: 0, 2: 0 };
            STATE.abandonos.clear();
            resetPowershotState();
            STATE.powershotKickLockId = null; STATE.powershotKickLockTs = 0;
            STATE.rainbowEquipoActivo = null;
            safeOperation(() => STATE.room.startRecording());
            STATE.festejosVipActivos = {};
            // Leer el color base de la pelota del mapa. Si la lectura falla o
            // devuelve algo inválido (ej. -1 = transparente/nativo sin color),
            // reintentar a los 300ms y por defecto usar blanco. Además hay que
            // forzar ultimoColorPelotaEnviado=null porque el dedupe de
            // setColorPelota persiste entre partidos: si del partido anterior
            // quedó guardado un valor a medio terminar (o -1), sin reset nunca
            // se emitiría el color bueno en el nuevo partido → pelota invisible.
            const pb = safeOperation(() => STATE.room.getDiscProperties(0));
            if (pb && typeof pb.color === "number" && pb.color >= 0) {
                STATE.colorPelotaDefault = pb.color;
            } else {
                STATE.colorPelotaDefault = 0xFFFFFF;
                setTimeout(() => {
                    const p2 = safeOperation(() => STATE.room.getDiscProperties(0));
                    if (p2 && typeof p2.color === "number" && p2.color >= 0) STATE.colorPelotaDefault = p2.color;
                }, 300);
            }
            ultimoColorPelotaEnviado = null;
            STATE.afkPlayers.clear(); STATE.afkDesde = {}; STATE.afkAvisado30s.clear();
            STATE.gkReservado = { 1: null, 2: null }; STATE.gkUltimoWarn = {};
            STATE.eventoGolX2Activo = false;
            programarEventoAleatorio();
            asignarCamisetas();
            STATE.room.getPlayerList().forEach(p => {
                if (p.team !== 0) { const k = getPlayerKey(p); if (STATE.baseDatos[k]) STATE.baseDatos[k].jugando = true; STATE.matchStats[p.id] = { goles: 0, asistencias: 0, ultimoFuePowerShot: 0 }; aplicarTamanoPersistente(p); }
            });
            markDirty();
            asignarCapitanes();
            sendAnnouncement(`${FRASES_ARRANQUE_PARTIDO[Math.floor(Math.random() * FRASES_ARRANQUE_PARTIDO.length)]} Temporada S${STATE.TEMPORADA_ACTUAL}`, null, 0xFFFFFF, "bold", 1);
            detectarYAnunciarRivalidad();
            STATE.ultimoMarcadorConocido = { red: 0, blue: 0, time: 0, scoreLimit: STATE.room.getScores()?.scoreLimit, timeLimit: STATE.room.getScores()?.timeLimit };
            if (STATE.liveStatsMessageId) editarMensajeLive(STATE.liveStatsMessageId, embedEstadoSala());
        } catch (e) { logMsg('errors.log', `[${ROOM_ID}] Error onGameStart: ${e.message}\n${e.stack}`); }
    };

    STATE.room.onGamePause = function() { try { if (STATE.powershotID !== 0) cancelarPowershotCarga(); } catch (e) { logMsg('errors.log', `[${ROOM_ID}] Error onGamePause: ${e.message}`); } };

    STATE.room.onGameStop = function() {
        try {
            STATE.partidoEnCurso = false;
            if (STATE.eventoTimer) { clearTimeout(STATE.eventoTimer); STATE.eventoTimer = null; }
            STATE.eventoGolX2Activo = false;
            if (STATE.cambioMapaPendiente) aplicarConfigMapa(STATE.cambioMapaPendiente);
            resetPowershotState();
            STATE.powershotKickLockId = null; STATE.powershotKickLockTs = 0;
            STATE.festejosVipActivos = {};
            STATE.vipBallTrailActivo = false;
            if (STATE.vipBallColorTimeout) clearTimeout(STATE.vipBallColorTimeout);
            restaurarColorPelotaSiLibre();
            if (STATE.rainbowEquipoActivo) { restaurarCamisetaEquipo(STATE.rainbowEquipoActivo.team, STATE.rainbowEquipoActivo.colorOriginal); STATE.rainbowEquipoActivo = null; }
            limpiarCapitanes();
            if (STATE.liveStatsMessageId) editarMensajeLive(STATE.liveStatsMessageId, embedEstadoSala());
            // Obtener el marcador FINAL directamente del motor, no de STATE.ultimoMarcadorConocido
            // que puede estar desactualizado. Esto es CRITICO para que el ELO se guarde correctamente
            const sc = safeOperation(() => STATE.room.getScores()) || STATE.ultimoMarcadorConocido;
            const sinLim = sc && sc.timeLimit === 0 && sc.scoreLimit === 0;
            // Verificar si el partido termino de forma natural:
            // - Por tiempo: tiempo actual >= limite de tiempo
            // - Por goles: alguno de los equipos alcanzo el limite de goles
            // - Sin limites: partido sin tiempo ni goles limite, pero duro mas de 30 segundos
            const tiempoAlcanzado = sc && sc.timeLimit > 0 && sc.time >= sc.timeLimit * 60;
            const golesAlcanzados = sc && sc.scoreLimit > 0 && (sc.red >= sc.scoreLimit || sc.blue >= sc.scoreLimit);
            const sinLimitesValido = sinLim && (Date.now() - STATE.inicioPartido) > 30000;
            const nat = sc && (tiempoAlcanzado || golesAlcanzados || sinLimitesValido);
            // SOLO cancelar si el partido NO termino naturalmente Y no hay jugadores en equipos
            // Si hay jugadores en equipos, asumimos que el partido termino y procesamos el ELO
            const ps = STATE.room.getPlayerList();
            const jugadoresEnEquipos = ps.filter(p => p.team === 1 || p.team === 2).length;
            if (!nat && jugadoresEnEquipos === 0) {
                safeOperation(() => STATE.room.stopRecording());
                msgSmall(`\ud83d\uded1 Partido detenido, sin cambios de ELO`, null, COLORES.error, "small-bold", 1);
                STATE.room.getPlayerList().forEach(p => { const k = getPlayerKey(p); if (STATE.baseDatos[k]) STATE.baseDatos[k].jugando = false; });
                Object.values(STATE.apuestas).forEach(a => { const s = STATE.baseDatos[a.key]; if (s) s.monedas += a.cantidad; });
                if (Object.keys(STATE.apuestas).length) msgInfo("Apuestas reembolsadas", null);
                STATE.apuestas = {}; markDirty(); return;
            }
            // Si el partido no termino naturalmente pero hay jugadores, lo tratamos como natural
            // para que se guarde el ELO. Esto evita el problema de partidos cerrados abruptamente.
            const gan = sc.red > sc.blue ? 1 : (sc.blue > sc.red ? 2 : 0);
            try {
                const buf = STATE.room.stopRecording();
                if (buf && buf.length) enviarEventoBot("replay", { archivoBase64: Buffer.from(buf).toString("base64"), nombreArchivo: `${CONFIG.NOMBRE_SALA || "replay"}_${Date.now()}.hbr2`, embed: construirEmbed({ title: "🎬 Replay", description: `Rojo ${sc.red} - ${sc.blue} Azul`, color: 0x9B59B6 }) }).catch(() => { });
            } catch (e) { logMsg('errors.log', `[${ROOM_ID}] Error replay: ${e.message}`); }
            STATE.records.partidosTotalesLiga = (STATE.records.partidosTotalesLiga || 0) + 1; markDirty();
            Object.entries(STATE.apuestas).forEach(([pid, a]) => { const s = STATE.baseDatos[a.key]; if (!s) return; if (a.equipo === gan) { const pr = Math.round(a.cantidad * CONFIG.CUOTA_APUESTA); s.monedas += pr; msgSmall(`🎰 Apuesta ganada +${pr}💰`, parseInt(pid, 10), COLORES.exito, "small-bold", 1); } });
            const r = ps.filter(p => p.team === 1), a = ps.filter(p => p.team === 2);
            const mr = r.length ? r.reduce((s, p) => s + (STATE.baseDatos[getPlayerKey(p)]?.mmr || 1000), 0) / r.length : 1000;
            const ma = a.length ? a.reduce((s, p) => s + (STATE.baseDatos[getPlayerKey(p)]?.mmr || 1000), 0) / a.length : 1000;
            const vR = sc.blue === 0 && !!STATE.ArqueroRED;
            const vB = sc.red === 0 && !!STATE.ArqueroBLUE;
            const msgR = { act: [], rot: [] };
            const fig = getFiguraDelPartido();
            ps.forEach(p => {
                const k = getPlayerKey(p);
                if (p.team !== 0 && STATE.baseDatos[k]) {
                    const s = STATE.baseDatos[k];
                    s.jugando = false; s.partidos++;
                    const pS = STATE.matchStats[p.id] || { goles: 0, asistencias: 0 };
                    s.goles += pS.goles;
                    const mV = s.vip ? 1.2 : 1;
                    let mG = Math.round(pS.goles * 10 * mV);
                    s.monedas += mG;
                    const xG = pS.goles * 15;
                    darXP(p, xG);
                    if (Math.random() < CONFIG.CAJA_PROBABILIDAD) { const mc = Math.floor(CONFIG.CAJA_MONEDAS_MIN + Math.random() * (CONFIG.CAJA_MONEDAS_MAX - CONFIG.CAJA_MONEDAS_MIN)); s.monedas += mc; msgSmall(`🎁✨ Caja +${mc}💰`, p.id, COLORES.oro, "small-bold", 1); }
                    const eR = p.team === 1 ? ma : mr;
                    let res = 0.5, resT = "🤝 Empate";
                    const rA = s.racha;
                    if (gan !== 0) {
                        if (p.team === gan) {
                            res = 1; resT = "🏆 Victoria"; s.victorias++; s.racha++;
                            const bV = Math.round(20 * mV); s.monedas += bV; mG += bV;
                            if (s.clan) sumarXPClan(s.clan, CONFIG.CLAN_XP_POR_VICTORIA);
                            if (s.racha > (s.mejor_racha || 0)) s.mejor_racha = s.racha;
                            if (s.racha >= 3) msgR.act.push(`${p.name} (${s.racha})`);
                            if (STATE.peorDesventaja && (STATE.peorDesventaja[gan] || 0) >= 3) darBadge(p, "remontada");
                            const nG = gan === 1 ? r.length : a.length;
                            const nP = gan === 1 ? a.length : r.length;
                            if (nG === 1 && nP >= 3) darBadge(p, "heroe_1v3");
                        } else { res = 0; resT = "❌ Derrota"; s.derrotas++; if (rA >= 3) msgR.rot.push(`${p.name} (${rA})`); s.racha = 0; }
                    } else { s.empates++; s.racha = 0; }
                    const esGI = (p.team === 1 && vR && STATE.ArqueroRED?.id === p.id) || (p.team === 2 && vB && STATE.ArqueroBLUE?.id === p.id);
                    let lE;
                    if (!s.escudo_mmr_activo) {
                        const pm = calcularPerformanceMultiplier({ goles: pS.goles, asistencias: pS.asistencias || 0, atajadas: pS.atajadas || 0, autogoles: pS.autogoles || 0, vallaInvicta: esGI, segundosAfk: 0 });
                        const bR = res === 1 ? calcularBonusRacha(s.racha) : 0;
                        const esM = fig && fig.id === p.id;
                        const bM = esM ? CONFIG.ELO_MVP_BONUS : 0;
                        const aj = pm + bR + bM;
                        const cam = calcularCambioElo(s.mmr, eR, res, s.partidos, aj, false);
                        const camR = aplicarCambioEloPartido(s, { eloRival: eR, resultado: res, cambio: cam, motivo: res === 1 ? "victoria" : res === 0 ? "derrota" : "empate" });
                        lE = `📊 ELO: ${camR >= 0 ? "+" : ""}${camR} → ${s.mmr}`;
                        const tp = getTituloSeguro(s.titulo || "bronce1");
                        const sg = getSiguienteRango(s.titulo || "bronce1");
                        if (sg) { const rw = Math.max(1, sg.req - tp.req); const av = Math.max(0, Math.min(1, (s.mmr - tp.req) / rw)); const B = 10, ll = Math.round(av * B); lE += `\n   ${"▰".repeat(ll) + "▱".repeat(B - ll)} faltan ${Math.max(0, sg.req - s.mmr)} para ${sg.nombre}`; }
                    } else { s.escudo_mmr_activo = false; lE = `🛡️ Escudo Anti-ELO usado`; msgSmall(`🛡️ ${p.name} usó Escudo`, null, COLORES.info, "small", 0); }
                    if (gan !== 0) chequearAntiSmurf(p, s);
                    const col = resT === "🏆 Victoria" ? 0x00FF88 : resT === "❌ Derrota" ? 0xFF3366 : 0xFFD700;
                    const tj = STATE.inicioPartido ? formatTime((Date.now() - STATE.inicioPartido) / 1000) : "?";
                    sendAnnouncement(`${resT} · ⚽${pS.goles} 🎁${pS.asistencias || 0} · 💰+${mG} ⭐+${xG} · ${lE}\n   Tiempo: ${tj}`, p.id, col, "small-bold", 0);
                    actualizarTitulo(p);
                    verificarBadgesPostPartido(p, s, pS.goles);
                    verificarMisionDiaria(p, s, pS.goles);
                    verificarMisionSemanal(p, s);
                }
            });
            for (const [kA, inf] of STATE.abandonos) {
                const s = STATE.baseDatos[kA]; if (!s) continue;
                s.partidos++; s.derrotas++; s.racha = 0;
                s.ragequits = (s.ragequits || 0) + 1;
                s.goles += inf.stats.goles || 0;
                if (!s.escudo_mmr_activo) { const eR = inf.team === 1 ? ma : mr; const c = calcularCambioElo(s.mmr, eR, 0, s.partidos, 0, true); aplicarCambioEloPartido(s, { eloRival: eR, resultado: 0, cambio: c, motivo: "abandono" }); }
                else s.escudo_mmr_activo = false;
                actualizarTitulo(kA, true); markDirty(kA);
            }
            STATE.abandonos.clear();
            if (gan !== 0 || (r.length && a.length)) {
                r.forEach(pr => { const kr = getPlayerKey(pr), sr = STATE.baseDatos[kr]; if (!sr) return; a.forEach(pa => { const ka = getPlayerKey(pa), sa = STATE.baseDatos[ka]; if (!sa) return; sr.historial_vs[ka] = sr.historial_vs[ka] || { victorias: 0, derrotas: 0, empates: 0 }; sa.historial_vs[kr] = sa.historial_vs[kr] || { victorias: 0, derrotas: 0, empates: 0 }; if (gan === 1) { sr.historial_vs[ka].victorias++; sa.historial_vs[kr].derrotas++; } else if (gan === 2) { sr.historial_vs[ka].derrotas++; sa.historial_vs[kr].victorias++; } else { sr.historial_vs[ka].empates++; sa.historial_vs[kr].empates++; } }); });
            }
            if (STATE.rivalidadDelPartido) {
                const { keyRojo, keyAzul, nombreRojo, nombreAzul } = STATE.rivalidadDelPartido;
                const h = STATE.baseDatos[keyRojo]?.historial_vs?.[keyAzul];
                if (h) sendAnnouncement(`⚔️ Rivalidad: ${nombreRojo} ${h.victorias}-${h.derrotas} ${nombreAzul}`, null, COLORES.oro, "small", 0);
                STATE.rivalidadDelPartido = null;
            }
            if (vR) { const kk = getPlayerKey(STATE.ArqueroRED), s = STATE.baseDatos[kk]; if (s) { s.vallas_invictas = (s.vallas_invictas || 0) + 1; if (s.vallas_invictas >= 10 && !s.badges.includes("portero_muro")) darBadge(STATE.ArqueroRED, "portero_muro"); } }
            if (vB) { const kk = getPlayerKey(STATE.ArqueroBLUE), s = STATE.baseDatos[kk]; if (s) { s.vallas_invictas = (s.vallas_invictas || 0) + 1; if (s.vallas_invictas >= 10 && !s.badges.includes("portero_muro")) darBadge(STATE.ArqueroBLUE, "portero_muro"); } }
            if (fig) { const fS = STATE.matchStats[fig.id] || { goles: 0, asistencias: 0 }; const rat = Math.min(10, (6 + fS.goles * 1.2 + fS.asistencias * 0.8)).toFixed(1); sendAnnouncement(`🌟 Figura: ${fig.name} · ⚽${fS.goles} 🎁${fS.asistencias} · ❬${rat}/10❭`, null, COLORES.oro, "small-bold", 2); }
            const tp = STATE.equipoRojoPosesion + STATE.equipoAzulPosesion;
            if (tp > 0) { const pR = ((STATE.equipoRojoPosesion / tp) * 100).toFixed(1); sendAnnouncement(`📈 Posesión: 🔴 ${pR}% : ${(100 - pR).toFixed(1)}% 🔵`, null, 0xFFFFFF, "small", 0); }
            iniciarVotacionMVP(fig);
            if (msgR.act.length) msgGame(`🔥 Racha: ${msgR.act.join(", ")}`, null, 0xFF6600, 1);
            if (msgR.rot.length) msgGame(`💀 Racha cortada: ${msgR.rot.join(", ")}`, null, 0x8888FF, 0);
            calcularPosesion();
            const rT = gan === 0 ? `⏱️ Empate ${sc.red}-${sc.blue}` : `⏱️ Victoria ${gan === 1 ? "ROJA 🔴" : "AZUL 🔵"} ${sc.red}-${sc.blue}`;
            sendAnnouncement(rT, null, 0xFFFFFF, "small-bold", 2);
            sendAnnouncement(`📊 ELO promedio: 🔴 ${Math.round(mr)} - 🔵 ${Math.round(ma)}`, null, 0xFFFFFF, "small", 0);
            const cR = gan === 1 ? 0xFF3366 : gan === 2 ? 0x00BFFF : 0xFFD700;
            const cam = [
                { name: "Resultado", value: `🔴 ROJO ${sc.red} — ${sc.blue} AZUL 🔵`, inline: false },
                { name: "⏱️ Duración", value: formatTime((Date.now() - STATE.inicioPartido) / 1000), inline: true },
                { name: "⚖️ Posesión", value: `🔴 ${STATE.equipoRojoPosesion || 0} vs 🔵 ${STATE.equipoAzulPosesion || 0}`, inline: true },
            ];
            if (fig) { const fS = STATE.matchStats[fig.id] || { goles: 0, asistencias: 0 }; cam.push({ name: "🌟 Figura", value: `${fig.name} — ⚽${fS.goles} 🎁${fS.asistencias}`, inline: false }); }
            notificarEstadisticas(construirEmbed({ title: "📊 Partido finalizado", description: rT, color: cR, fields: cam, footer: "🏆 Bahía Blanca Futsal" }));
            actualizarHistorial();
            saveDatabase().catch(e => logMsg('errors.log', `[${ROOM_ID}] Error guardando ELO: ${e.message}`));
            handleFairPlay(sc); handleGanaSigue(gan);
            if (STATE.automatizadoActivado) setTimeout(() => ejecutarAutomatizado(true), 800);
            STATE.ultimoMarcadorConocido = null; markDirty();
        } catch (e) { logMsg('errors.log', `[${ROOM_ID}] Error onGameStop: ${e.message}\n${e.stack}`); }
    };

    STATE.room.onPlayerChat = function(player, message) {
        try {
            const stats = getStats(player);
            const isAdmin = STATE.room.getPlayer(player.id).admin;
            const key = getPlayerKey(player);
            if (STATE.mutesTemporales.find(m => m.auth === key)) { msgError("Estás muteado", player.id); return false; }
            if (!isAdmin && checkFlood(player)) { msgError(`Pará un poco. Muteado ${Math.round(CONFIG.FLOOD_MUTE_MS / 1000)}s`, player.id); return false; }
            if (message.startsWith("t ") && player.team !== 0) { const tm = message.slice(2); STATE.room.getPlayerList().filter(p => p.team === player.team).forEach(p => sendAnnouncement(`🔒 [TEAM] ${player.name}: ${tm}`, p.id, player.team === 1 ? COLORES.equipo_rojo : COLORES.equipo_azul, "small-bold", 1)); return false; }
            if (message.startsWith("c ")) { const sc = stats; if (sc?.clan && STATE.clanes[sc.clan]) { const cm = message.slice(2), nc = STATE.clanes[sc.clan].nombre; STATE.room.getPlayerList().filter(p => STATE.baseDatos[getPlayerKey(p)]?.clan === sc.clan).forEach(p => sendAnnouncement(`⚔️ [${nc}] ${player.name}: ${cm}`, p.id, 0xFF00FF, "small-bold", 1)); return false; } }
            if (message.startsWith("@@")) { const m = message.match(/^@@(\S+)\s+(.+)$/); if (m) { const t = findOnlinePlayer(m[1]); if (t) { sendAnnouncement(`📨 [PM de ${player.name}]: ${m[2]}`, t.id, COLORES.advertencia, "small-bold", 2); sendAnnouncement(`📨 → ${t.name}: ${m[2]}`, player.id, COLORES.exito, "small", 0); } return false; } }
            const msg = message.toLowerCase().trim();
            if (!msg.startsWith("!")) {
                notificarMensaje(`**${player.name}**: ${message}`);
                const t = obtenerTitulo(player), b = obtenerBadges(player);
                const rango = getRango(player);
                let color = t.color, estilo = "small-bold", pre;
                const nRSE = formatTituloDisplay(t).replace(/^\S+\s*/, "");
                const nT = `Nv.${stats?.nivel ?? 1} · #${player.id}`;
                const sB = b ? ` ${b}` : "";
                if (esOwner(player)) { color = 0xFFD700; pre = `〔👑 · ${nT}〕${sB}`; }
                else if (rango === "coowner") { color = 0xDA70D6; pre = `〔✨ · ${nT}〕${sB}`; }
                else if (rango === "admin" || isAdmin) { color = 0xFFA500; pre = `〔🛠️ · ${nT}〕${sB}`; }
                else if (rango === "modplus") { color = 0x00BFFF; pre = `〔🛡️ · ${nT}〕${sB}`; }
                else if (rango === "mod") { color = 0x1E90FF; pre = `〔🛡️ · ${nT}〕${sB}`; }
                else if (stats?.vip) { const tc = tierVipDe(stats); color = tc.chatColor; pre = `〔${tc.emoji} ${nRSE} · ${nT}〕${sB}`; }
                else { color = 0xFFFFFF; estilo = "small"; pre = `〔${formatTituloDisplay(t)} · ${nT}〕${sB}`; }
                const eSF = esOwner(player) || ["coowner", "admin", "modplus", "mod"].includes(rango) || isAdmin;
                if (!eSF && stats?.color_nombre) color = stats.color_nombre;
                sendAnnouncement(`${pre} ${player.name}: ${message}`, null, color, estilo, 1);
                return false;
            }
            const partes = message.trim().split(/\s+/);
            const cmd = partes[0].toLowerCase(), args = partes.slice(1);
            if (commands[cmd]) {
                if (cmd !== "!clave" && enCooldown(key, cmd)) return false;
                commands[cmd](player, args, isAdmin);
                return false;
            }
            msgError("Ese comando no existe, probá !comandos", player.id);
            return false;
        } catch (e) { logMsg('errors.log', `[${ROOM_ID}] Error onPlayerChat: ${e.message}`); return false; }
    };
}

// ─── ARRANQUE ───
process.on('uncaughtException', (err) => { console.error('No capturado:', err); logMsg('errors.log', `[${ROOM_ID}] Uncaught: ${err.message}\n${err.stack}`); });
process.on('unhandledRejection', (reason) => { console.error('Promesa rechazada:', reason); logMsg('errors.log', `[${ROOM_ID}] UnhandledRejection: ${reason}`); });

let apagando = false;
async function shutdown(señal) {
    if (apagando) return; apagando = true;
    console.log(`\n🛑 [${ROOM_ID}] Señal ${señal}. Guardando...`);
    clearInterval(STATE.liveStatsTimer); clearInterval(STATE.historialTimer);
    clearInterval(STATE.progEcoInterval);
    clearInterval(STATE.afkCheckInterval);
    clearTimeout(STATE.eventoTimer);
    clearTimeout(STATE.vipBallColorTimeout);
    clearTimeout(STATE.fS);
    const fS = setTimeout(() => { console.error("⏱️ Timeout apagando."); process.exit(1); }, 15000);
    fS.unref?.();
    try {
        marcarProcesoApagado();
        STATE.isDirty = true;
        await saveDatabase();
        console.log("✅ Guardado.");
    } catch (e) { console.error("Error guardando:", e.message); }
    finally { await closePool().catch((e) => console.error("Error cerrando pool:", e.message)); }
    clearTimeout(fS); process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

function validarConfiguracion() {
    const reqs = Object.values(TITULOS).map(t => t.req);
    for (let i = 1; i < reqs.length; i++) if (reqs[i] <= reqs[i - 1]) { console.error(`❌ TITULOS mal ordenado posición ${i}`); process.exit(1); }
    const req = ["ADMIN_PASSWORD", "BOT_HTTP_SECRETO", "VERIFICACION_HTTP_SECRETO"];
    const f = req.filter(k => !CONFIG[k]);
    if (f.length) { console.error(`❌ Faltan env vars: ${f.join(", ")}`); process.exit(1); }
    if (!CONFIG.HB_TOKEN) { console.error("❌ Falta HB_TOKEN."); process.exit(1); }
}
async function crearSalaConReintentos(max = 5) {
    for (let i = 1; i <= max; i++) {
        try { const HB = await HaxballJS(); return HB({ roomName: CONFIG.NOMBRE_SALA, playerName: "『𝗕𝗮𝗵𝗜𝗔』", maxPlayers: CONFIG.MAX_JUGADORES_SALA, public: true, geo: { code: "ar", lat: -38.7167, lon: -62.2667 }, token: CONFIG.HB_TOKEN, noPlayer: false }); }
        catch (e) { console.error(`⚠️ Intento ${i}/${max}: ${e.message}`); logMsg('errors.log', `[${ROOM_ID}] Fallo crear sala ${i}: ${e.message}`); if (i === max) throw e; await new Promise(r => setTimeout(r, Math.min(30000, 2000 * i))); }
    }
}

setInterval(async () => {
    if (!RETRY_QUEUE.length) return;
    const ahora = Date.now();
    for (let i = RETRY_QUEUE.length - 1; i >= 0; i--) {
        const it = RETRY_QUEUE[i];
        if (ahora - it.ts < 5000) continue;
        it.ts = ahora;
        try { await it.fn(); RETRY_QUEUE.splice(i, 1); }
        catch (e) { it.intentos++; if (it.intentos >= it.intentosMax) { logMsg('errors.log', `[${ROOM_ID}] Retry agotado (${it.descripcion}): ${e.message}`); RETRY_QUEUE.splice(i, 1); } }
    }
}, 5000);

const VERIF_FILE = path.join(CONFIG.BACKUP_DIR, "verificaciones.json");
function guardarVerif() { try { fsSync.writeFileSync(VERIF_FILE, JSON.stringify(STATE.verificacionesPendientes), "utf8"); } catch (e) { } }
function cargarVerif() {
    try {
        if (!fsSync.existsSync(VERIF_FILE)) return;
        const p = JSON.parse(fsSync.readFileSync(VERIF_FILE, "utf8"));
        const ahora = Date.now();
        for (const [c, v] of Object.entries(p)) if (v && v.expira > ahora) STATE.verificacionesPendientes[c] = v;
    } catch (e) { }
}
setInterval(guardarVerif, 30000);

(async () => {
    [CONFIG.LOG_DIR, CONFIG.BACKUP_DIR].forEach(d => { if (!fsSync.existsSync(d)) fsSync.mkdirSync(d, { recursive: true }); });
    validarConfiguracion();
    cargarVerif();
    await loadDatabase();
    if (typeof STATE.siguienteIdPermanente !== "number") STATE.siguienteIdPermanente = 1;
    inicializarIdsPermanentes();
    limpiarBaseDatos();

    STATE.room = await crearSalaConReintentos();
    const wd = setTimeout(async () => { console.error("⚠️ No llegó link en 20s. Reiniciando."); await logMsg('errors.log', `[${ROOM_ID}] Watchdog onRoomLink 20s.`); process.exit(1); }, 20000);
    STATE.room.setDefaultStadium("Rounded");
    STATE.room.setScoreLimit(3);
    STATE.room.setTimeLimit(5);
    console.log(`\n🏆 Bahía Blanca Futsal — ${ROOM_ID} (${CONFIG.NOMBRE_SALA})\n`);

    STATE.room.onRoomLink = link => {
        clearTimeout(wd);
        console.log(`✅ Link: ${link}`);
        STATE.roomLink = link;
        STATE.inicioSala = Date.now();
        safeOperation(() => STATE.room.setPlayerTeam(STATE.BOT_ID, 0));
        // Reusar el live message id si está persistido, sino crear.
        (async () => {
            const idGuardado = await getBotState("live_message_id");
            if (idGuardado) {
                STATE.liveStatsMessageId = Number(idGuardado);
                await editarMensajeLive(STATE.liveStatsMessageId, embedEstadoSala());
                if (STATE.liveStatsMessageId) return;
            }
            const id = await crearMensajeLive(embedEstadoSala());
            STATE.liveStatsMessageId = id;
            if (id) setBotState("live_message_id", id).catch(() => { });
        })();
        clearInterval(STATE.liveStatsTimer);
        STATE.liveStatsTimer = setInterval(() => { if (STATE.liveStatsMessageId) editarMensajeLive(STATE.liveStatsMessageId, embedEstadoSala()); }, CONFIG.LIVE_STATS_INTERVALO_MS);
        actualizarHistorial();
        clearInterval(STATE.historialTimer);
        STATE.historialTimer = setInterval(actualizarHistorial, 10 * 60 * 1000);
        if (STATE.automatizadoActivado) anunciarModoAutomatizado();
    };

    setupEvents();
    iniciarServidorVerificacion();

    setInterval(saveDatabase, 15000);
    setTimeout(() => { setInterval(() => { if (STATE.partidoEnCurso) checkAFKKickAutomatico(); }, 15000); }, 7000);
    setInterval(() => { if (STATE.automatizadoActivado) ejecutarAutomatizado(); }, 3000);
    setInterval(() => { if (STATE.automatizadoActivado && STATE.room && STATE.room.getPlayerList().length <= 1) anunciarModoAutomatizado(); }, CONFIG.AUTOMATED_MODE_ANNOUNCE_IDLE_MS);
    setInterval(limpiarCache, CONFIG.CACHE_TTL);
    setInterval(backupDatabase, CONFIG.BACKUP_INTERVAL_MS);
    setInterval(pollGlobalSync, CONFIG.BAN_POLL_INTERVAL_MS);
    setInterval(() => { if (!STATE.partidoEnCurso) return; STATE.tipIndex = ((STATE.tipIndex ?? -1) + 1) % TIPS_SALA.length; msgSmall(TIPS_SALA[STATE.tipIndex], null, COLORES.info, "small", 0); }, CONFIG.TIP_INTERVALO_MS);
    setTimeout(() => { setInterval(pollGlobalesJugadores, CONFIG.BAN_POLL_INTERVAL_MS); }, 5000);

    let elTick = Date.now();
    setInterval(() => { const a = Date.now(); const lag = a - elTick - 500; elTick = a; if (lag > 50) logMsg('perf.log', `[${ROOM_ID}] Event loop bloqueado ~${lag}ms`); }, 500);

    STATE.progEcoInterval = setInterval(() => {
        if (STATE.room && !STATE.partidoEnCurso) {
            sendAnnouncement(`\ud83d\udce2 ${ANUNCIOS[STATE.anuncioIndex % ANUNCIOS.length]}`, null, COLORES.info, "small", 1);
            STATE.anuncioIndex++;
        }
    }, 180000 + Math.floor(Math.random() * 120000));
    progEco();
    setInterval(() => { if (STATE.room) { sendAnnouncement(`📢 ${ANUNCIOS_DISCORD[STATE.anuncioDiscordIndex % ANUNCIOS_DISCORD.length]}`, null, 0x5865F2, "small", 1); STATE.anuncioDiscordIndex++; } }, 45000);
    STATE.afkCheckInterval = setInterval(() => { if (STATE.partidoEnCurso) checkAFK(); }, 3000);

    setInterval(() => {
        const ahora = Date.now();
        STATE.mutesTemporales = STATE.mutesTemporales.filter(m => ahora - m.timestamp < m.duracion);
        for (const [c, v] of Object.entries(STATE.verificacionesPendientes)) if (v.expira < ahora) delete STATE.verificacionesPendientes[c];
        for (const [k, ts] of STATE.afkCooldown.entries()) if (ts < ahora) STATE.afkCooldown.delete(k);
        for (const [k, ts] of STATE.cooldownsCmd.entries()) if (ts < ahora) STATE.cooldownsCmd.delete(k);
        for (const [k, inv] of Object.entries(STATE.clanInvitaciones)) if (inv.expira && inv.expira < ahora) delete STATE.clanInvitaciones[k];
        for (const [k, h] of Object.entries(STATE.mensajesRecientes)) if (!h || !h.length) delete STATE.mensajesRecientes[k];
        if (STATE.partidoEnCurso) {
            STATE.room.getPlayerList().forEach(pl => {
                const s = STATE.baseDatos[getPlayerKey(pl)];
                if (s && !s.vip_perma && s.vip_expira && ahora > s.vip_expira) { s.vip = false; s.vip_expira = null; s.vip_tier = "vip"; markDirty(getPlayerKey(pl)); msgSmall("⌛ Tu VIP expiró", pl.id, COLORES.advertencia, "small", 0); }
            });
        }
        if (STATE.adminsAutomaticos.size) STATE.room.getPlayerList().forEach(pl => { const a = STATE.authPorId.get(pl.id); if (a && STATE.adminsAutomaticos.has(a) && !pl.admin) safeOperation(() => STATE.room.setPlayerAdmin(pl.id, true)); });
        if (STATE.partidoEnCurso) STATE.room.getPlayerList().forEach(pl => { if (pl.team !== 0 && !STATE.afkPlayers.has(pl.id)) { const k = getPlayerKey(pl); const s = STATE.baseDatos[k]; if (s) { s.segundos_jugados = (s.segundos_jugados || 0) + 60; markDirty(k); } } });
    }, 60000);

    console.log(`✅ Sala ${ROOM_ID} arrancada`);
})().catch(err => {
    console.error("❌ FATAL arranque:", err);
    logMsg('errors.log', `[${ROOM_ID}] FATAL: ${err.message}\n${err.stack}`).finally(() => process.exit(1));
});