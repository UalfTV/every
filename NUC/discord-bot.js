// discord-bot.js
// ─────────────────────────────────────────────────────────────────────────
// Bot de Discord que recibe eventos desde index.js por HTTP (POST /evento)
// y expone slash commands para admins. Cada sala (HA/H4) corre su propia
// instancia, hablando con el server de verificación/admin de esa sala.
//
// Pasada de calidad (ver CHANGELOG abajo del todo) — los fixes importantes:
//   · Race condition al actualizar el mensaje de historial combinado (dos
//     eventos concurrentes creaban DOS mensajes en vez de uno).
//   · `resolverCanalDeWebhook` colgaba sin timeout si Discord no respondía.
//   · Handlers async (messageCreate, interactionCreate, /evento) sin catch
//     → unhandled rejections silenciosas.
//   · `server.listen` sin error handler → EADDRINUSE tiraba el proceso.
//   · Filename de replay sin sanitizar → path traversal potencial.
//   · `res.writeHead` después de abortar request → crash si el socket ya
//     estaba cerrado.
//   · BOM al inicio del archivo → warnings en algunos parsers.
//   · `client.isReady()` deprecado (usar `client.readyAt`).
//   · `MessageFlags.Ephemeral` vs `ephemeral:true` — depende de la versión
//     de discord.js; verificado que la que usás lo soporta.
// ─────────────────────────────────────────────────────────────────────────
require("dotenv").config();
const http = require("http");
const https = require("https");
const fs = require("fs");
const crypto = require("crypto");
const {
    Client,
    GatewayIntentBits,
    EmbedBuilder,
    REST,
    Routes,
    SlashCommandBuilder,
    PermissionFlagsBits,
    AttachmentBuilder,
    MessageFlags,
} = require("discord.js");

// ROOM_ID identifica a qué sala (HA/H4) atiende esta instancia del bot de
// Discord. Se usa sólo para loguear con claridad cuando corren dos
// instancias al mismo tiempo; no cambia funcionalidad.
const ROOM_ID = process.env.BOT_ROOM_ID || "HA";

// ── Logging con timestamp ────────────────────────────────────────────────
function ahora() { return new Date().toISOString(); }
const log = {
    info: (...args) => console.log(`[${ahora()}] [${ROOM_ID}] ℹ️`, ...args),
    ok: (...args) => console.log(`[${ahora()}] [${ROOM_ID}]`, ...args),
    warn: (...args) => console.warn(`[${ahora()}] [${ROOM_ID}] ⚠️`, ...args),
    error: (...args) => console.error(`[${ahora()}] [${ROOM_ID}] ❌`, ...args),
    debug: (...args) => { if (process.env.DEBUG === "1") console.debug(`[${ahora()}] [${ROOM_ID}] 🐛`, ...args); },
};

// ── Variables de entorno ─────────────────────────────────────────────────
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const SECRETO = process.env.BOT_HTTP_SECRETO;
const PUERTO = Number(process.env.BOT_HTTP_PUERTO) || 8789;
// QUALITY: host configurable. Antes estaba hardcodeado a 127.0.0.1, lo que
// impedía correr el bot en otra máquina/contenedor distinto de index.js.
const HOST_LISTEN = process.env.BOT_HTTP_HOST || "127.0.0.1";

// Servidor de verificación / ranking / admin dentro de index.js.
const VERIFICACION_HOST = process.env.VERIFICACION_HTTP_HOST || "127.0.0.1";
const VERIFICACION_PUERTO = Number(process.env.VERIFICACION_HTTP_PUERTO) || 8788;
const VERIFICACION_SECRETO = process.env.VERIFICACION_HTTP_SECRETO;
// QUALITY: canal de verificación configurable vía env, con fallback al ID
// histórico para no romper instalaciones existentes.
const CANAL_VERIFICACION_ID = process.env.CANAL_VERIFICACION_ID || "1523704682105667584";

// ── Registro de salas ────────────────────────────────────────────────────
const SALAS = {
    HA: {
        host: VERIFICACION_HOST,
        port: VERIFICACION_PUERTO,
        secreto: VERIFICACION_SECRETO,
        label: process.env.NOMBRE_SALA_HA || "HA (principal)",
    },
    H4: {
        host: process.env.VERIFICACION_HTTP_HOST_H4 || VERIFICACION_HOST,
        port: Number(process.env.VERIFICACION_HTTP_PUERTO_H4) || 8790,
        secreto: process.env.VERIFICACION_HTTP_SECRETO_H4 || VERIFICACION_SECRETO,
        label: process.env.NOMBRE_SALA_H4 || "H4 (secundaria)",
    },
};

// ── Validación de env vars obligatorias ──────────────────────────────────
const VARIABLES_REQUERIDAS = {
    DISCORD_TOKEN,
    DISCORD_CLIENT_ID: CLIENT_ID,
    DISCORD_GUILD_ID: GUILD_ID,
    BOT_HTTP_SECRETO: SECRETO,
    VERIFICACION_HTTP_SECRETO: VERIFICACION_SECRETO,
};
const faltantes = Object.entries(VARIABLES_REQUERIDAS)
    .filter(([, valor]) => !valor)
    .map(([nombre]) => nombre);

if (faltantes.length) {
    log.error(`Faltan variables de entorno obligatorias: ${faltantes.join(", ")}. Revisá el .env.`);
    process.exit(1);
}

// ── Agentes HTTP salientes (keep-alive) ──────────────────────────────────
// QUALITY: sin agent reutilizable, cada request a index.js abría una conexión
// TCP nueva. Con decenas de eventos por minuto (chat, goals, joins) eso suma.
const HTTP_AGENT_LOCAL = new http.Agent({ keepAlive: true, maxSockets: 8 });
const HTTPS_AGENT_SALIENTE = new https.Agent({ keepAlive: true, maxSockets: 4 });

// ── Canal puente Discord → Hax ───────────────────────────────────────────
const CHAT_RELAY_WEBHOOK_URL = process.env.CHAT_RELAY_WEBHOOK_URL || "";
let CHAT_RELAY_CANAL_ID = null;

// ── Mapeo tipo de evento → canal de Discord, POR SALA ────────────────────
const CANALES_POR_SALA = {
    HA: {
        sala:         "1434542955611553822",
        mensaje:      "1434544190435495937",
        joinleave:    "1434544480903757966",
        estadisticas: "1434544763377287188",
        replay:       "1523704432263696464",
    },
    H4: {
        mensaje:      "1525178988035571713",
        joinleave:    "1525179044750954546",
        estadisticas: "1525179096584163368",
        replay:       "1525179134228041868",
        sala:         "1525179740967927930",
    },
};

// Historial es UN SOLO canal compartido entre HA y H4.
const CANAL_HISTORIAL = process.env.CANAL_HISTORIAL || "1524667059806408835";

const TIPO_A_CLAVE_CANAL = {
    online: "sala",
    live_crear: "sala",
    live_editar: "sala",
    mensaje: "mensaje",
    joinleave: "joinleave",
    estadisticas: "estadisticas",
    replay: "replay",
};

function normalizarRoomId(roomId) {
    const r = String(roomId || "HA").toUpperCase();
    return CANALES_POR_SALA[r] ? r : "HA";
}

const COLORES_EVENTO = {
    online: 0x00BFFF,
    mensaje: 0x5865F2,
    joinleave: 0xFFA500,
    estadisticas: 0x00FF88,
    live_crear: 0x00BFFF,
    live_editar: 0x00BFFF,
    replay: 0x9B59B6,
    historial_actualizar: 0x9B59B6,
};

const CATEGORIAS_RANKING = {
    elo:          { label: "ELO",         emoji: "🏆" },
    goles:        { label: "Goles",       emoji: "⚽" },
    asistencias:  { label: "Asistencias", emoji: "🎯" },
    victorias:    { label: "Victorias",   emoji: "🥇" },
    partidos:     { label: "Partidos",    emoji: "📋" },
};
const MEDALLAS = ["🥇", "🥈", "🥉"];

const COLOR_OK = 0x00FF88;
const COLOR_ERROR = 0xFF3366;
const COLOR_WARN = 0xFFA500;
const COLOR_INFO = 0x5865F2;

// ── Helpers de respuesta consistente ─────────────────────────────────────
function embedRespuesta(descripcion, color = COLOR_INFO, titulo = null) {
    const embed = new EmbedBuilder().setDescription(descripcion).setColor(color);
    if (titulo) embed.setTitle(titulo);
    return embed;
}
function respuestaOk(descripcion, titulo = null) { return { embeds: [embedRespuesta(descripcion, COLOR_OK, titulo)] }; }
function respuestaError(descripcion, titulo = null) { return { embeds: [embedRespuesta(descripcion, COLOR_ERROR, titulo)] }; }
function respuestaWarn(descripcion, titulo = null) { return { embeds: [embedRespuesta(descripcion, COLOR_WARN, titulo)] }; }

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
});

// ── Comparación segura de secretos ───────────────────────────────────────
function secretoValido(recibido, esperado) {
    if (typeof recibido !== "string" || typeof esperado !== "string") return false;
    if (recibido.length !== esperado.length) return false;
    try {
        return crypto.timingSafeEqual(Buffer.from(recibido), Buffer.from(esperado));
    } catch {
        return false;
    }
}

// ── Utilidades de saneamiento ────────────────────────────────────────────
// Saca texto plano de un footer que puede venir como string ("Bahía Blanca
// Futsal") o como objeto { text: "..." } (que es como lo arma construirEmbed
// en index.js). Antes esto siempre hacía String(footer) y cuando llegaba
// como objeto mostraba literalmente "[object Object]".
function textoFooter(footer) {
    if (!footer) return null;
    if (typeof footer === "string") return footer;
    if (typeof footer === "object" && typeof footer.text === "string") return footer.text;
    return null;
}
function textoSeguro(valor, fallback = "") {
    if (valor === null || valor === undefined) return fallback;
    if (typeof valor === "string" || typeof valor === "number") return String(valor);
    if (typeof valor === "object") {
        if (typeof valor.text === "string") return valor.text;
        if (typeof valor.value === "string") return valor.value;
        return fallback;
    }
    return String(valor);
}
// Sanitiza nombres de archivo que vienen desde el exterior (replay de index.js).
// Sin esto, un `nombreArchivo` como "../../etc/passwd" podría hacer que
// AttachmentBuilder reciba un nombre raro. Discord no escribe en disco, pero
// es defensa en profundidad + evita caracteres raros que rompan la UI.
function sanitizarNombreArchivo(nombre, fallback) {
    const base = String(nombre || fallback).replace(/[\/\\:*?"<>|\x00-\x1f]/g, "_").trim();
    return base.slice(0, 200) || fallback;
}

// ── Slash commands ───────────────────────────────────────────────────────
function opcionSala(opt) {
    return opt
        .setName("sala")
        .setDescription("Sala a la que aplicar la acción (por defecto: HA)")
        .setRequired(false)
        .addChoices(
            { name: "HA (principal)", value: "HA" },
            { name: "H4 (secundaria)", value: "H4" },
        );
}

const comandos = [
    new SlashCommandBuilder()
        .setName("codigo")
        .setDescription("Verificá tu cuenta de la sala con el código que te dio !verificacion en el juego")
        .addStringOption((opt) => opt.setName("codigo").setDescription("El código que te dio el bot en el juego").setRequired(true))
        .addStringOption(opcionSala),

    new SlashCommandBuilder()
        .setName("ranking")
        .setDescription("Mostrá el top de jugadores de la sala")
        .addStringOption((opt) =>
            opt.setName("categoria")
                .setDescription("Por qué ordenar el ranking (por defecto: ELO)")
                .setRequired(false)
                .addChoices(
                    { name: "ELO", value: "elo" },
                    { name: "Goles", value: "goles" },
                    { name: "Asistencias", value: "asistencias" },
                    { name: "Victorias", value: "victorias" },
                    { name: "Partidos jugados", value: "partidos" },
                )
        )
        .addStringOption((opt) =>
            opt.setName("sala")
                .setDescription("Qué sala mostrar (por defecto: ambas)")
                .setRequired(false)
                .addChoices(
                    { name: "Ambas salas", value: "ambas" },
                    { name: "HA (principal)", value: "HA" },
                    { name: "H4 (secundaria)", value: "H4" },
                )
        )
        .addIntegerOption((opt) =>
            opt.setName("top")
                .setDescription("Cuántos jugadores mostrar (por defecto: 10, máximo: 25)")
                .setMinValue(1)
                .setMaxValue(25)
                .setRequired(false)
        ),

    new SlashCommandBuilder()
        .setName("reiniciar")
        .setDescription("Reinicia el partido o la sala del juego")
        .addStringOption(opcionSala)
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
        .setName("minutos")
        .setDescription("Setea el tiempo límite del próximo partido (solo si no hay uno en curso)")
        .addIntegerOption((opt) => opt.setName("minutos").setDescription("Minutos (0 = sin límite)").setMinValue(0).setMaxValue(60).setRequired(true))
        .addStringOption(opcionSala)
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
        .setName("goles")
        .setDescription("Setea el límite de goles del próximo partido (solo si no hay uno en curso)")
        .addIntegerOption((opt) => opt.setName("goles").setDescription("Goles (0 = sin límite)").setMinValue(0).setMaxValue(50).setRequired(true))
        .addStringOption(opcionSala)
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
        .setName("decir")
        .setDescription("Manda un mensaje desde Discord al chat del juego")
        .addStringOption((opt) => opt.setName("mensaje").setDescription("Texto a mandar").setMaxLength(200).setRequired(true))
        .addStringOption(opcionSala)
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
        .setName("dar-admin")
        .setDescription("Le da admin en la sala a un jugador conectado")
        .addStringOption((opt) => opt.setName("jugador").setDescription("Nombre del jugador (tiene que estar conectado)").setRequired(true))
        .addStringOption(opcionSala)
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
        .setName("kickear")
        .setDescription("Expulsa a un jugador de la sala (no es baneo)")
        .addStringOption((opt) => opt.setName("jugador").setDescription("Nombre del jugador (tiene que estar conectado)").setRequired(true))
        .addStringOption((opt) => opt.setName("motivo").setDescription("Motivo").setMaxLength(100).setRequired(false))
        .addStringOption(opcionSala)
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
        .setName("banear")
        .setDescription("Banea la cuenta de un jugador por X días")
        .addStringOption((opt) => opt.setName("jugador").setDescription("Nombre del jugador (tiene que estar conectado)").setRequired(true))
        .addIntegerOption((opt) => opt.setName("dias").setDescription("Duración en días (por defecto: la del servidor)").setMinValue(1).setRequired(false))
        .addStringOption((opt) => opt.setName("motivo").setDescription("Motivo").setMaxLength(100).setRequired(false))
        .addStringOption(opcionSala)
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
        .setName("banear-ip")
        .setDescription("Banea a un jugador por cuenta Y por red (más difícil de esquivar)")
        .addStringOption((opt) => opt.setName("jugador").setDescription("Nombre del jugador (tiene que estar conectado)").setRequired(true))
        .addIntegerOption((opt) => opt.setName("dias").setDescription("Duración en días (por defecto: la del servidor)").setMinValue(1).setRequired(false))
        .addStringOption((opt) => opt.setName("motivo").setDescription("Motivo").setMaxLength(100).setRequired(false))
        .addStringOption(opcionSala)
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
        .setName("desbanear")
        .setDescription("Le saca el baneo a un jugador (no hace falta que esté conectado)")
        .addStringOption((opt) => opt.setName("jugador").setDescription("Nombre exacto o parcial del jugador baneado").setRequired(true))
        .addStringOption(opcionSala)
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
].map((c) => c.toJSON());

// ── Registro de comandos con reintentos ──────────────────────────────────
async function registrarComandos(intentos = 3, esperaBaseMs = 3000) {
    const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
    for (let i = 1; i <= intentos; i++) {
        try {
            await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: comandos });
            log.ok(`✅ Slash commands registrados (${comandos.length} comandos).`);
            return true;
        } catch (e) {
            log.error(`No se pudieron registrar los slash commands (intento ${i}/${intentos}):`, e.message);
            if (i < intentos) await new Promise((r) => setTimeout(r, esperaBaseMs * i));
        }
    }
    log.error("Se agotaron los reintentos para registrar los slash commands. Van a quedar desactualizados hasta el próximo restart.");
    return false;
}

// ── Retry genérico con backoff ───────────────────────────────────────────
// Solo reintenta fallos DE RED/TIMEOUT (status === 0), nunca respuestas
// HTTP válidas con error (4xx/5xx) — esas ya son una respuesta real del
// servidor y reintentar no cambiaría nada.
async function conReintentos(fn, intentos = 3, esperaBaseMs = 400) {
    let ultimo;
    for (let i = 1; i <= intentos; i++) {
        ultimo = await fn();
        if (ultimo.status !== 0) return ultimo;
        if (i < intentos) await new Promise((r) => setTimeout(r, esperaBaseMs * i));
    }
    return ultimo;
}

// ── Request helper unificado (POST a index.js) ───────────────────────────
function requestIndexPost({ destino, path, body, timeoutMs = 5000 }) {
    return new Promise((resolve) => {
        const bodyStr = JSON.stringify(body);
        let req;
        try {
            req = http.request(
                {
                    hostname: destino.host,
                    port: destino.port,
                    path,
                    method: "POST",
                    timeout: timeoutMs,
                    agent: HTTP_AGENT_LOCAL,
                    headers: {
                        "Content-Type": "application/json",
                        "Content-Length": Buffer.byteLength(bodyStr),
                        "x-verificacion-secreto": destino.secreto,
                    },
                },
                (res) => {
                    const chunks = [];
                    res.on("data", (c) => chunks.push(c));
                    res.on("end", () => {
                        const raw = Buffer.concat(chunks).toString("utf8");
                        try {
                            resolve({ status: res.statusCode, ...JSON.parse(raw || "{}") });
                        } catch {
                            resolve({ status: res.statusCode, ok: false, raw: raw.slice(0, 200) });
                        }
                    });
                }
            );
        } catch (e) {
            log.error(`Error creando request a ${destino.host}:${destino.port}${path}:`, e.message);
            return resolve({ status: 0, ok: false });
        }
        req.on("timeout", () => req.destroy(new Error("timeout")));
        req.on("error", (e) => {
            log.debug(`Request a ${path} falló: ${e.message}`);
            resolve({ status: 0, ok: false });
        });
        req.write(bodyStr);
        req.end();
    });
}

function confirmarCodigoSinReintento(codigo, discordId, sala = "HA", discordTag = null) {
    const destino = SALAS[sala] || SALAS.HA;
    return requestIndexPost({ destino, path: "/verificar", body: { codigo, discordId, discordTag } });
}
function confirmarCodigo(codigo, discordId, sala = "HA", discordTag = null) {
    return conReintentos(() => confirmarCodigoSinReintento(codigo, discordId, sala, discordTag));
}

// Nota: acciones administrativas NO se reintentan por defecto para evitar
// duplicar el efecto si el primer intento en realidad sí llegó a destino y
// solo se perdió la respuesta (ej. banear dos veces, o mandar el mismo
// mensaje dos veces).
function llamarAdmin(accion, payload = {}, sala = "HA") {
    const destino = SALAS[sala] || SALAS.HA;
    return requestIndexPost({ destino, path: "/admin", body: { accion, ...payload } });
}

// ── Resolver channel_id detrás de un webhook ─────────────────────────────
// FIX: antes no tenía timeout. Si Discord no respondía, el promise quedaba
// pendiente para siempre y el arranque del bot se colgaba.
function resolverCanalDeWebhook(webhookUrl, timeoutMs = 8000) {
    return new Promise((resolve) => {
        let req;
        try {
            req = https.get(webhookUrl, { timeout: timeoutMs, agent: HTTPS_AGENT_SALIENTE }, (res) => {
                if (res.statusCode !== 200) {
                    res.resume();
                    return resolve(null);
                }
                let data = "";
                res.on("data", (chunk) => { data += chunk; if (data.length > 200_000) req.destroy(); });
                res.on("end", () => {
                    try {
                        const info = JSON.parse(data);
                        resolve(info.channel_id || null);
                    } catch {
                        resolve(null);
                    }
                });
            });
        } catch (e) {
            log.error("Error creando request al webhook:", e.message);
            return resolve(null);
        }
        req.on("timeout", () => req.destroy(new Error("timeout")));
        req.on("error", () => resolve(null));
    });
}

async function resolverCanalDeWebhookConReintentos(webhookUrl, intentos = 5, esperaBaseMs = 2000) {
    for (let i = 1; i <= intentos; i++) {
        const canalId = await resolverCanalDeWebhook(webhookUrl);
        if (canalId) return canalId;
        if (i < intentos) {
            log.warn(`No se pudo resolver el canal del webhook (intento ${i}/${intentos}), reintentando en ${esperaBaseMs * i}ms...`);
            await new Promise((r) => setTimeout(r, esperaBaseMs * i));
        }
    }
    return null;
}

// ── Ranking ──────────────────────────────────────────────────────────────
function pedirRankingSinReintento(categoria, limite, sala = "HA") {
    const destino = SALAS[sala] || SALAS.HA;
    return new Promise((resolve) => {
        const path = `/ranking?categoria=${encodeURIComponent(categoria)}&limite=${encodeURIComponent(limite)}`;
        let req;
        try {
            req = http.request(
                {
                    hostname: destino.host,
                    port: destino.port,
                    path,
                    method: "GET",
                    timeout: 5000,
                    agent: HTTP_AGENT_LOCAL,
                    headers: { "x-verificacion-secreto": destino.secreto },
                },
                (res) => {
                    const chunks = [];
                    res.on("data", (c) => chunks.push(c));
                    res.on("end", () => {
                        try {
                            resolve({ status: res.statusCode, ...JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") });
                        } catch {
                            resolve({ status: res.statusCode, ok: false });
                        }
                    });
                }
            );
        } catch (e) {
            log.error("Error creando request de ranking:", e.message);
            return resolve({ status: 0, ok: false });
        }
        req.on("timeout", () => req.destroy(new Error("timeout")));
        req.on("error", () => resolve({ status: 0, ok: false }));
        req.end();
    });
}
function pedirRanking(categoria, limite, sala = "HA") {
    return conReintentos(() => pedirRankingSinReintento(categoria, limite, sala));
}

function embedRanking(categoria, ranking, salaLabel = null) {
    const meta = CATEGORIAS_RANKING[categoria] || CATEGORIAS_RANKING.elo;
    const sufijoSala = salaLabel ? ` · ${salaLabel}` : "";

    if (!ranking.length) {
        return new EmbedBuilder()
            .setTitle(`${meta.emoji}  Ranking · ${meta.label}${sufijoSala}`)
            .setDescription("_Todavía nadie jugó lo suficiente como para entrar en este ranking. Volvé a probar después de unos partidos._")
            .setColor(0x808080)
            .setFooter({ text: "🏆 Bahía Blanca Futsal" })
            .setTimestamp();
    }

    const lineas = ranking.map((j, i) => {
        const puesto = MEDALLAS[i] || `\`#${String(i + 1).padStart(2, "0")}\``;
        const stats = `⚽ **${j.goles}**  ·  🎯 **${j.asistencias}**  ·  🏆 **${j.mmr}** ELO  ·  📋 ${j.victorias}/${j.partidos}`;
        return `${puesto} **${j.nombre}** — \`${j.valor}\` ${meta.label.toLowerCase()}\n${" ".repeat(4)}${stats}`;
    });

    return new EmbedBuilder()
        .setTitle(`${meta.emoji}  Ranking · ${meta.label}${sufijoSala}`)
        .setDescription(lineas.join("\n\n"))
        .setColor(0xFFD700)
        .setFooter({ text: `🏆 Bahía Blanca Futsal · Top ${ranking.length}` })
        .setTimestamp();
}

// ════════════════════════════════════════════════════════════════════════
// HANDLERS DE INTERACCIÓN
// FIX: el handler es async y no tenía try/catch. Cualquier throw (fetch
// caído, respuesta malformada de index.js) se convertía en una unhandled
// rejection silenciosa. Ahora todo va adentro de try/catch y si algo revienta
// se intenta responder con un error genérico.
// ════════════════════════════════════════════════════════════════════════
client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    try {
        // ── /codigo ─────────────────────────────────────────────────────
        if (interaction.commandName === "codigo") {
            if (interaction.channelId !== CANAL_VERIFICACION_ID) {
                return interaction.reply({
                    ...respuestaWarn(`Este comando solo funciona en <#${CANAL_VERIFICACION_ID}>. ¡Nos vemos ahí! 👋`),
                    flags: MessageFlags.Ephemeral,
                });
            }

            const codigo = interaction.options.getString("codigo", true).trim();
            const sala = interaction.options.getString("sala") || "HA";
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });

            const discordTag = interaction.user.globalName || interaction.user.username || interaction.user.tag;
            const resultado = await confirmarCodigo(codigo, interaction.user.id, sala, discordTag);

            if (resultado.ok) {
                await interaction.editReply(respuestaOk(
                    "Tu cuenta quedó vinculada. Ya podés volver al juego y disfrutar de las ventajas de estar verificado. 🎮",
                    "✅ ¡Cuenta verificada!"
                ));
            } else if (resultado.status === 404) {
                await interaction.editReply(respuestaError(
                    "Ese código no es válido o ya venció. Escribí `!verificacion` de nuevo en el juego para pedir uno nuevo.",
                    "❌ Código inválido o expirado"
                ));
            } else {
                await interaction.editReply(respuestaError(
                    "No pude confirmar el código ahora mismo — puede que el servidor del juego esté reiniciando. Probá de nuevo en unos segundos.",
                    "❌ No se pudo verificar"
                ));
            }
            return;
        }

        // ── /ranking ────────────────────────────────────────────────────
        if (interaction.commandName === "ranking") {
            const categoria = interaction.options.getString("categoria") || "elo";
            const top = interaction.options.getInteger("top") || 10;
            const salaElegida = interaction.options.getString("sala") || "ambas";

            await interaction.deferReply();

            const salasAConsultar = salaElegida === "ambas" ? ["HA", "H4"] : [salaElegida];
            const resultados = await Promise.all(
                salasAConsultar.map(async (sala) => ({ sala, ...(await pedirRanking(categoria, top, sala)) }))
            );

            const embeds = [];
            const fallos = [];
            for (const r of resultados) {
                if (!r.ok) { fallos.push(SALAS[r.sala]?.label || r.sala); continue; }
                embeds.push(embedRanking(r.categoria || categoria, r.ranking || [], SALAS[r.sala]?.label || r.sala));
            }

            if (!embeds.length) {
                return interaction.editReply(respuestaError(
                    "No pude traer el ranking ahora mismo — puede que el/los servidor(es) del juego estén reiniciando. Probá de nuevo en unos segundos.",
                    "❌ No se pudo obtener el ranking"
                ));
            }

            const aviso = fallos.length ? `\n⚠️ No se pudo traer el ranking de: ${fallos.join(", ")}.` : "";
            await interaction.editReply({ content: aviso || undefined, embeds });
            return;
        }

        // ── Administrativos ─────────────────────────────────────────────
        const ACCIONES_ADMIN = ["reiniciar", "minutos", "goles", "decir", "dar-admin", "kickear", "banear", "banear-ip", "desbanear"];
        if (!ACCIONES_ADMIN.includes(interaction.commandName)) return;

        if (!interaction.memberPermissions?.has("Administrator")) {
            return interaction.reply({
                ...respuestaError("Este comando es solo para administradores del servidor de Discord.", "🔒 Sin permiso"),
                flags: MessageFlags.Ephemeral,
            });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const autor = interaction.member?.displayName || interaction.user.username;
        const sala = interaction.options.getString("sala") || "HA";
        let resultado;

        switch (interaction.commandName) {
            case "reiniciar":
                resultado = await llamarAdmin("reiniciar", {}, sala);
                break;
            case "minutos":
                resultado = await llamarAdmin("minutos", { valor: interaction.options.getInteger("minutos", true) }, sala);
                break;
            case "goles":
                resultado = await llamarAdmin("goles", { valor: interaction.options.getInteger("goles", true) }, sala);
                break;
            case "decir":
                resultado = await llamarAdmin("mensaje", { texto: interaction.options.getString("mensaje", true), autor }, sala);
                break;
            case "dar-admin":
                resultado = await llamarAdmin("admin", { jugador: interaction.options.getString("jugador", true) }, sala);
                break;
            case "kickear":
                resultado = await llamarAdmin("kick", {
                    jugador: interaction.options.getString("jugador", true),
                    motivo: interaction.options.getString("motivo") || undefined,
                }, sala);
                break;
            case "banear":
                resultado = await llamarAdmin("ban", {
                    jugador: interaction.options.getString("jugador", true),
                    dias: interaction.options.getInteger("dias") || undefined,
                    motivo: interaction.options.getString("motivo") || undefined,
                }, sala);
                break;
            case "banear-ip":
                resultado = await llamarAdmin("banip", {
                    jugador: interaction.options.getString("jugador", true),
                    dias: interaction.options.getInteger("dias") || undefined,
                    motivo: interaction.options.getString("motivo") || undefined,
                }, sala);
                break;
            case "desbanear":
                resultado = await llamarAdmin("unban", {
                    jugador: interaction.options.getString("jugador", true),
                }, sala);
                break;
        }

        if (!resultado || resultado.status === 0) {
            return interaction.editReply(respuestaError(
                "No se pudo contactar al servidor del juego. Puede estar reiniciando — probá de nuevo en unos segundos.",
                "❌ Sin conexión"
            ));
        }
        if (!resultado.ok) {
            return interaction.editReply(respuestaError(resultado.error || "No se pudo completar la acción.", "❌ No se pudo completar"));
        }

        const mensajesOk = {
            reiniciar: () => respuestaOk(resultado.mensaje || "Listo.", "🔄 Sala reiniciada"),
            minutos: () => respuestaOk(resultado.mensaje || "Listo.", "⏱️ Tiempo límite actualizado"),
            goles: () => respuestaOk(resultado.mensaje || "Listo.", "⚽ Límite de goles actualizado"),
            decir: () => respuestaOk(`Tu mensaje llegó al chat del juego: *"${interaction.options.getString("mensaje")}"*`, "💬 Mensaje enviado"),
            "dar-admin": () => respuestaOk(`**${resultado.nombre ?? "?"}** ahora es administrador en la sala.`, "🛠️ Admin otorgado"),
            kickear: () => respuestaOk(`**${resultado.nombre ?? "?"}** fue expulsado de la sala. Puede volver a entrar cuando quiera.`, "👢 Jugador expulsado"),
            banear: () => respuestaOk(`**${resultado.nombre ?? "?"}** fue baneado por **${resultado.dias ?? "?"} día(s)**.`, "⛔ Jugador baneado"),
            "banear-ip": () => respuestaOk(`**${resultado.nombre ?? "?"}** fue baneado por cuenta y por red durante **${resultado.dias ?? "?"} día(s)**.`, "⛔ Baneo reforzado (cuenta + red)"),
            desbanear: () => respuestaOk(`**${resultado.nombre ?? "?"}** ya no está baneado.`, "✅ Jugador desbaneado"),
        };
        await interaction.editReply(mensajesOk[interaction.commandName]());
    } catch (e) {
        log.error(`Error procesando interacción "${interaction.commandName}":`, e.message);
        try {
            if (interaction.deferred || interaction.replied) {
                await interaction.editReply(respuestaError("Algo se rompió procesando el comando. Probá de nuevo en unos segundos.", "❌ Error interno"));
            } else {
                await interaction.reply({ ...respuestaError("Algo se rompió procesando el comando.", "❌ Error interno"), flags: MessageFlags.Ephemeral });
            }
        } catch (_) { /* si el reply también falla, no podemos hacer nada */ }
    }
});

// ════════════════════════════════════════════════════════════════════════
// CANAL PUENTE: todo lo que se escribe en el canal detrás del webhook se
// manda como mensaje al chat del juego.
// ════════════════════════════════════════════════════════════════════════
const RELAY_MAX_LARGO = 300;

client.on("messageCreate", async (message) => {
    try {
        if (!CHAT_RELAY_CANAL_ID) return;
        if (message.channelId !== CHAT_RELAY_CANAL_ID) return;
        if (message.author.bot) return;
        const contenido = message.content?.trim();
        if (!contenido) return;

        const texto = contenido.length > RELAY_MAX_LARGO
            ? `${contenido.slice(0, RELAY_MAX_LARGO)}… (recortado)`
            : contenido;

        const autor = message.member?.displayName || message.author.username;
        const resultado = await llamarAdmin("mensaje", { texto, autor });
        if (!resultado.ok) {
            log.warn(`No se pudo mandar al chat del juego el mensaje de ${autor}: ${resultado.error || "sin detalle"}`);
            message.react("⚠️").catch(() => {});
        }
    } catch (e) {
        log.error("Error procesando messageCreate:", e.message);
    }
});

// ════════════════════════════════════════════════════════════════════════
// READY
// FIX: antes se registraba sólo con `clientReady` (nombre nuevo de v15).
// En discord.js v14 el evento es `ready`. Se registran los dos con un guard
// idempotente para que funcione en cualquier versión.
// ════════════════════════════════════════════════════════════════════════
let yaListo = false;
const onReady = async () => {
    if (yaListo) return;
    yaListo = true;

    try {
        log.ok(`Bot de Discord conectado como ${client.user.tag}`);
        await registrarComandos();

        if (CHAT_RELAY_WEBHOOK_URL) {
            CHAT_RELAY_CANAL_ID = await resolverCanalDeWebhookConReintentos(CHAT_RELAY_WEBHOOK_URL);
            if (CHAT_RELAY_CANAL_ID) {
                log.ok(`Canal puente Discord → Hax resuelto (canal ${CHAT_RELAY_CANAL_ID}).`);
            } else {
                log.error("No se pudo resolver el canal del webhook CHAT_RELAY_WEBHOOK_URL tras varios intentos. El puente Discord → Hax no va a funcionar hasta que se reinicie el bot.");
            }
        } else {
            log.warn("CHAT_RELAY_WEBHOOK_URL no está definido; el puente Discord → Hax queda desactivado.");
        }

        log.info("Recordá que 'Message Content Intent' tiene que estar habilitado en el portal de Discord Developers → Bot → Privileged Gateway Intents.");
    } catch (e) {
        log.error("Error en el handler de ready:", e.message);
    }
};
client.once("clientReady", onReady);
client.once("ready", onReady);

// ── Eventos del cliente ──────────────────────────────────────────────────
client.on("error", (e) => log.error("Error del cliente de Discord:", e.message));
client.on("warn", (msg) => log.warn("Aviso del cliente de Discord:", msg));
client.on("shardDisconnect", (event, shardId) => log.warn(`Shard ${shardId} desconectado (código ${event?.code ?? "?"}). discord.js va a intentar reconectar solo.`));
client.on("shardReconnecting", (shardId) => log.warn(`Shard ${shardId} reconectando...`));
client.on("shardResume", (shardId) => log.ok(`Shard ${shardId} reconectado correctamente.`));

client.login(DISCORD_TOKEN).catch((e) => {
    log.error("No se pudo iniciar sesión en Discord (revisá DISCORD_TOKEN):", e.message);
    process.exit(1);
});

// ════════════════════════════════════════════════════════════════════════
// HISTORIAL COMBINADO (HA + H4 en UN SOLO mensaje)
// ════════════════════════════════════════════════════════════════════════
const HISTORIAL_ESTADO_PATH = process.env.HISTORIAL_ESTADO_PATH || "./historial-estado.json";
let historialEmbeds = { HA: null, H4: null };
let historialMessageId = null;

try {
    const guardado = JSON.parse(fs.readFileSync(HISTORIAL_ESTADO_PATH, "utf8"));
    historialMessageId = guardado.messageId || null;
    if (historialMessageId) log.info(`Estado de historial recuperado (messageId=${historialMessageId})`);
} catch {
    // No hay estado previo o el archivo está corrupto: arranca de cero.
}

function guardarEstadoHistorial() {
    try {
        const tmp = `${HISTORIAL_ESTADO_PATH}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify({ messageId: historialMessageId }));
        fs.renameSync(tmp, HISTORIAL_ESTADO_PATH);
    } catch (e) {
        log.error("No se pudo persistir el estado del historial:", e.message);
    }
}

// FIX: race condition. Si HA y H4 mandaban `historial_actualizar` casi
// al mismo tiempo (arranque en simultáneo, o dos partidos terminando juntos),
// ambos veían `historialMessageId=null` y ambos mandaban un mensaje NUEVO al
// canal → mensajes duplicados. Serializamos todas las actualizaciones con un
// lock tipo promise-chain.
let historialLock = Promise.resolve();
function conLockHistorial(fn) {
    const resultado = historialLock.then(fn, fn);
    historialLock = resultado.then(() => {}, () => {});
    return resultado;
}

async function manejarHistorial(roomId, embedData) {
    return conLockHistorial(async () => {
        historialEmbeds[roomId] = embedData;
        const embeds = [historialEmbeds.HA, historialEmbeds.H4]
            .filter(Boolean)
            .map((e) => construirEmbedDiscord(e));

        let canal;
        try {
            canal = await client.channels.fetch(CANAL_HISTORIAL);
        } catch (e) {
            log.error(`No se pudo obtener el canal de historial (canalId=${CANAL_HISTORIAL}). Motivo de Discord: [${e.code ?? "?"}] ${e.message}. Chequeá que el canal exista y que el bot tenga permiso "Ver canal" ahí.`);
            return null;
        }
        if (!canal) {
            log.error(`El canal de historial (canalId=${CANAL_HISTORIAL}) no existe o el bot no tiene acceso.`);
            return null;
        }

        if (historialMessageId) {
            try {
                const msg = await canal.messages.fetch(historialMessageId);
                await msg.edit({ embeds });
                return historialMessageId;
            } catch (e) {
                log.warn(`No se pudo editar el mensaje de historial ${historialMessageId} (¿lo borraron?), mando uno nuevo:`, e.message);
            }
        }

        const nuevo = await canal.send({ embeds });
        historialMessageId = nuevo.id;
        guardarEstadoHistorial();
        return historialMessageId;
    });
}

// Convierte el objeto plano {title, description, color, fields, footer} que
// manda index.js en un EmbedBuilder de discord.js.
function construirEmbedDiscord(data) {
    const embed = new EmbedBuilder()
        .setTitle(textoSeguro(data?.title, "📚 Historial de la liga"))
        .setDescription(textoSeguro(data?.description, ""))
        .setColor(data?.color ?? COLORES_EVENTO.historial_actualizar)
        // QUALITY: antes no seteaba timestamp, quedaba desprolijo.
        .setTimestamp();

    if (data?.fields?.length) {
        embed.addFields(
            data.fields.map((f) => ({
                name: textoSeguro(f.name, "—").slice(0, 256),
                value: textoSeguro(f.value, "—").slice(0, 1024),
                inline: !!f.inline,
            }))
        );
    }
    const footer = textoFooter(data?.footer);
    if (footer) embed.setFooter({ text: footer.slice(0, 2048) });
    return embed;
}

// ════════════════════════════════════════════════════════════════════════
// SERVIDOR HTTP /evento
// ════════════════════════════════════════════════════════════════════════
const BODY_MAX_BYTES = 25 * 1024 * 1024;

// Helper: responde sólo si headers aún no se enviaron, y swallowea errores
// de socket cerrado. Antes, si el cliente había cortado la conexión,
// `res.writeHead()` tiraba y se propagaba a unhandled exception.
function responder(res, status, body) {
    if (res.headersSent || res.writableEnded) return;
    try {
        res.writeHead(status);
        if (body !== undefined) res.end(typeof body === "string" ? body : JSON.stringify(body));
        else res.end();
    } catch (e) {
        log.debug(`No se pudo responder al cliente: ${e.message}`);
    }
}

const server = http.createServer((req, res) => {
    // Healthcheck simple, sin secreto, para monitoreo externo.
    if (req.method === "GET" && req.url === "/salud") {
        return responder(res, 200, {
            ok: true,
            sala: ROOM_ID,
            // QUALITY: `isReady()` está deprecado en v14+; `readyAt` es el
            // campo correcto (null hasta el primer ready).
            discordListo: !!client.readyAt,
        });
    }

    if (req.method !== "POST" || req.url !== "/evento") {
        return responder(res, 404, "");
    }

    // Acumular como Buffer[] es más eficiente que concatenar strings,
    // especialmente con bodies de varios MB (replays en base64).
    const chunks = [];
    let largoRecibido = 0;
    let abortado = false;

    req.setTimeout(15000, () => {
        if (abortado) return;
        abortado = true;
        responder(res, 408, "Timeout esperando el cuerpo de la petición");
        req.destroy();
    });

    req.on("data", (chunk) => {
        if (abortado) return;
        largoRecibido += chunk.length;
        if (largoRecibido > BODY_MAX_BYTES) {
            abortado = true;
            responder(res, 413, "Cuerpo de la petición demasiado grande");
            req.destroy();
            return;
        }
        chunks.push(chunk);
    });

    req.on("aborted", () => { abortado = true; });

    req.on("end", async () => {
        if (abortado) return;
        const body = Buffer.concat(chunks).toString("utf8");

        try {
            let data;
            try { data = JSON.parse(body); }
            catch { return responder(res, 400, "JSON inválido"); }

            if (!secretoValido(data.secreto, SECRETO)) {
                return responder(res, 401, "No autorizado: secreto inválido");
            }
            if (typeof data.tipo !== "string" || !data.tipo) {
                return responder(res, 400, 'Falta o es inválido el campo "tipo" del evento');
            }

            const roomId = normalizarRoomId(data.roomId);

            // Historial: un único mensaje compartido entre HA y H4.
            if (data.tipo === "historial_actualizar") {
                try {
                    const messageId = await manejarHistorial(roomId, data.embed);
                    return responder(res, 200, { ok: true, messageId });
                } catch (e) {
                    log.error("Error actualizando el historial combinado:", e.message);
                    return responder(res, 500, "Error actualizando el historial");
                }
            }

            const claveCanal = TIPO_A_CLAVE_CANAL[data.tipo];
            const canalId = claveCanal && CANALES_POR_SALA[roomId][claveCanal];
            if (!canalId) {
                log.error(`Evento con tipo sin canal asignado: "${data.tipo}" (sala ${roomId}).`);
                return responder(res, 400, `Tipo de evento "${data.tipo}" no tiene canal asignado para la sala ${roomId}`);
            }

            let canal;
            try {
                canal = await client.channels.fetch(canalId);
            } catch (e) {
                log.error(`No se pudo obtener el canal para "${data.tipo}" (sala ${roomId}, canalId=${canalId}). Motivo: [${e.code ?? "?"}] ${e.message}.`);
                return responder(res, 500, `Canal de Discord no accesible: [${e.code ?? "?"}] ${e.message}`);
            }
            if (!canal) {
                log.error(`El canal para "${data.tipo}" (sala ${roomId}, canalId=${canalId}) no existe o el bot no tiene acceso.`);
                return responder(res, 500, "Canal de Discord no encontrado");
            }

            const embed = new EmbedBuilder()
                .setTitle(textoSeguro(data.embed?.title, "📢 Evento del juego"))
                .setDescription(textoSeguro(data.embed?.description, ""))
                .setColor(data.embed?.color ?? COLORES_EVENTO[data.tipo] ?? 0x00ff88)
                .setTimestamp();

            if (data.embed?.fields?.length) {
                embed.addFields(
                    data.embed.fields.map((f) => ({
                        name: textoSeguro(f.name, "—").slice(0, 256),
                        value: textoSeguro(f.value, "—").slice(0, 1024),
                        inline: !!f.inline,
                    }))
                );
            }

            const footer = textoFooter(data.embed?.footer);
            embed.setFooter({ text: footer ? footer.slice(0, 2048) : "🏆 Bahía Blanca Futsal" });

            if (data.embed?.thumbnail) {
                const thumbUrl = typeof data.embed.thumbnail === "string" ? data.embed.thumbnail : data.embed.thumbnail?.url;
                if (thumbUrl) embed.setThumbnail(thumbUrl);
            }

            // live_editar: edita el mensaje existente. Si fue borrado a mano,
            // manda uno nuevo y devuelve el id para que index.js actualice el
            // que tiene guardado.
            if (data.tipo === "live_editar" && data.messageId) {
                try {
                    const msg = await canal.messages.fetch(data.messageId);
                    await msg.edit({ embeds: [embed] });
                    return responder(res, 200, { ok: true, messageId: msg.id });
                } catch (e) {
                    log.warn(`No se pudo editar el mensaje ${data.messageId} de "${data.tipo}" (¿lo borraron?), mando uno nuevo:`, e.message);
                    const nuevo = await canal.send({ embeds: [embed] });
                    return responder(res, 200, { ok: true, messageId: nuevo.id, recreado: true });
                }
            }

            // replay: archivo .hbr2 en base64 como adjunto.
            if (data.tipo === "replay" && data.archivoBase64) {
                try {
                    const buffer = Buffer.from(data.archivoBase64, "base64");
                    const nombre = sanitizarNombreArchivo(data.nombreArchivo, `replay_${Date.now()}.hbr2`);
                    const adjunto = new AttachmentBuilder(buffer, { name: nombre });
                    const enviado = await canal.send({ embeds: [embed], files: [adjunto] });
                    return responder(res, 200, { ok: true, messageId: enviado.id });
                } catch (e) {
                    log.error("Error mandando la replay a Discord:", e.message);
                    return responder(res, 500, "Error mandando la replay");
                }
            }

            const enviado = await canal.send({ embeds: [embed] });
            responder(res, 200, { ok: true, messageId: enviado.id });
        } catch (e) {
            log.error("Error procesando evento del juego:", e.message);
            responder(res, 500, "Error interno procesando el evento");
        }
    });
});

// Requests HTTP malformados que llegan a nivel socket (no a nivel de handler).
server.on("clientError", (err, socket) => {
    if (socket.writable) {
        try { socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"); } catch (_) {}
    }
});

// FIX: si el puerto está ocupado (EADDRINUSE) o no tenemos permiso (EACCES),
// antes el proceso crasheaba con un uncaught exception feo. Ahora se loguea
// claro y se sale con código 1.
server.on("error", (e) => {
    log.error(`Error en el servidor HTTP (${HOST_LISTEN}:${PUERTO}):`, e.message);
    if (e.code === "EADDRINUSE") log.error(`El puerto ${PUERTO} ya está en uso. ¿Tenés otra instancia corriendo?`);
    if (e.code === "EACCES") log.error(`Sin permisos para bindear ${HOST_LISTEN}:${PUERTO}. ¿Puerto privilegiado?`);
    process.exit(1);
});

server.listen(PUERTO, HOST_LISTEN, () => {
    log.ok(`✅ Escuchando eventos del servidor del juego en http://${HOST_LISTEN}:${PUERTO}/evento (salud: /salud)`);
});

// ── Handlers globales ────────────────────────────────────────────────────
process.on("uncaughtException", (err) => {
    log.error("💥 Error no capturado (el proceso sigue corriendo):", err);
});
process.on("unhandledRejection", (reason) => {
    log.error("💥 Promesa rechazada sin manejar (el proceso sigue corriendo):", reason);
});

// ── Apagado prolijo ──────────────────────────────────────────────────────
let apagandoBot = false;
async function shutdownBot(señal) {
    if (apagandoBot) return;
    apagandoBot = true;
    log.warn(`\n🛑 Señal ${señal} recibida. Cerrando bot.js...`);

    const forzarSalida = setTimeout(() => {
        log.error("⏱️ Timeout apagando bot.js; forzando salida.");
        process.exit(1);
    }, 10000);
    forzarSalida.unref?.();

    await new Promise((resolve) => {
        // server.close puede quedar colgado si hay requests abiertos; el
        // timeout de arriba fuerza salida igual.
        server.close(() => resolve());
        server.closeAllConnections?.();
    }).catch(() => {});

    try { client.destroy(); } catch (e) { log.error("Error cerrando cliente de Discord:", e.message); }

    clearTimeout(forzarSalida);
    process.exit(0);
}
process.on("SIGINT", () => shutdownBot("SIGINT"));
process.on("SIGTERM", () => shutdownBot("SIGTERM"));
