// discord-bot.js
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
// instancias de bot.js al mismo tiempo (una por sala); no cambia
// funcionalidad. Definir BOT_ROOM_ID=HA o BOT_ROOM_ID=H4 en el .env de cada
// instancia (junto con puertos y secretos propios de esa sala).
const ROOM_ID = process.env.BOT_ROOM_ID || "HA";

// ── Logging con timestamp ──
// Reemplaza los console.log/error/warn sueltos por un helper consistente
// (fecha/hora + sala) para que los logs sean legibles cuando corren dos
// instancias (HA y H4) mezcladas en la misma consola/journalctl.
function ahora() { return new Date().toISOString(); }
const log = {
    info: (...args) => console.log(`[${ahora()}] [${ROOM_ID}] ℹ️`, ...args),
    ok: (...args) => console.log(`[${ahora()}] [${ROOM_ID}]`, ...args),
    warn: (...args) => console.warn(`[${ahora()}] [${ROOM_ID}] ⚠️`, ...args),
    error: (...args) => console.error(`[${ahora()}] [${ROOM_ID}] ❌`, ...args),
};

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID = process.env.DISCORD_GUILD_ID;
// Sin fallback hardcodeado: si no está definido en el .env, el servidor no
// arranca (ver validación más abajo) en vez de quedar con un secreto
// conocido/expuesto por defecto.
const SECRETO = process.env.BOT_HTTP_SECRETO;
const PUERTO = process.env.BOT_HTTP_PUERTO || 8789;

// Servidor de verificación / ranking / admin que corre dentro de index.js (puerto
// separado del /evento)
const VERIFICACION_HOST = process.env.VERIFICACION_HTTP_HOST || "127.0.0.1";
const VERIFICACION_PUERTO = process.env.VERIFICACION_HTTP_PUERTO || 8788;
const VERIFICACION_SECRETO = process.env.VERIFICACION_HTTP_SECRETO;
const CANAL_VERIFICACION_ID = "1523704682105667584";

// ── Registro de salas ──
// Este bot de Discord puede hablar con las DOS salas (HA y H4) al mismo
// tiempo: cada una corre su propio servidor de verificación/admin dentro de
// su proceso de index.js, en un puerto distinto. Se usa el mismo secreto
// (VERIFICACION_HTTP_SECRETO) para ambas, ya que comparten el .env.
// El host/puerto de H4 se puede pisar con VERIFICACION_HTTP_HOST_H4 /
// VERIFICACION_HTTP_PUERTO_H4 si corre en otra máquina o puerto distinto.
const SALAS = {
    HA: {
        host: VERIFICACION_HOST,
        port: VERIFICACION_PUERTO,
        secreto: VERIFICACION_SECRETO,
        label: process.env.NOMBRE_SALA_HA || "HA (principal)",
    },
    H4: {
        host: process.env.VERIFICACION_HTTP_HOST_H4 || VERIFICACION_HOST,
        port: process.env.VERIFICACION_HTTP_PUERTO_H4 || 8790,
        secreto: process.env.VERIFICACION_HTTP_SECRETO_H4 || VERIFICACION_SECRETO,
        label: process.env.NOMBRE_SALA_H4 || "H4 (secundaria)",
    },
};

// ── Validación de variables de entorno obligatorias ──
// Un solo bloque, en vez de tres chequeos repartidos por el archivo (antes
// había un chequeo duplicado de DISCORD_TOKEN que ya había sido validado
// más arriba). Así el mensaje de error también dice EXACTAMENTE cuáles
// faltan, en vez de listar siempre las mismas tres variables.
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

// Webhook del canal que se usa como "chat puente": todo lo que se escriba en ese canal
// de Discord se manda como mensaje al chat del juego (vía /admin -> acción "mensaje").
// OJO: un webhook solo sirve para MANDAR mensajes a Discord, no para leerlos. Para leer
// los mensajes de ese canal igual necesitamos el bot escuchando "messageCreate" ahí, así
// que en el arranque resolvemos el channel_id real pegándole una vez a la URL del webhook.
// Sin fallback hardcodeado: cada sala define su propio webhook en el .env.
const CHAT_RELAY_WEBHOOK_URL = process.env.CHAT_RELAY_WEBHOOK_URL || "";
let CHAT_RELAY_CANAL_ID = null;

// ── Mapeo de tipo de evento -> canal de Discord, POR SALA ──
// Cada sala (HA/H4) tiene su propio set de canales. El roomId que decide cuál
// usar viene en el body del evento (data.roomId), mandado por index.js.
// "sala" agrupa online/live_crear/live_editar (el mensaje único de estado de
// la sala que se va editando).
const CANALES_POR_SALA = {
    HA: {
        sala:         "1434542955611553822", // creación de sala / live stats (un solo mensaje que se edita)
        mensaje:      "1434544190435495937", // chat
        joinleave:    "1434544480903757966", // ingresos y salidas
        estadisticas: "1434544763377287188", // estadística
        replay:       "1523704432263696464", // replays (.hbr2) de cada partido
    },
    H4: {
        mensaje:      "1525178988035571713", // chat
        joinleave:    "1525179044750954546", // ingresos y salidas
        estadisticas: "1525179096584163368", // estadística
        replay:       "1525179134228041868", // replays (.hbr2) de cada partido
        sala:         "1525179740967927930", // creación de sala / live stats (un solo mensaje que se edita)
    },
};

// El historial es UN SOLO canal compartido entre HA y H4 (no uno por sala):
// el bot junta el embed que manda cada sala y los muestra juntos en UN ÚNICO
// mensaje que se va editando (ver manejarHistorial más abajo).
const CANAL_HISTORIAL = "1524667059806408835";

// tipo de evento -> clave dentro de CANALES_POR_SALA[roomId]
const TIPO_A_CLAVE_CANAL = {
    online: "sala",
    live_crear: "sala",
    live_editar: "sala",
    mensaje: "mensaje",
    joinleave: "joinleave",
    estadisticas: "estadisticas",
    replay: "replay",
};

// Normaliza el roomId que manda index.js (por las dudas de que venga vacío,
// en minúscula, o de una versión vieja que todavía no lo manda).
function normalizarRoomId(roomId) {
    const r = String(roomId || "HA").toUpperCase();
    return CANALES_POR_SALA[r] ? r : "HA";
}

// Colores por defecto por tipo de evento, para cuando index.js no manda uno propio.
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

// Categorías disponibles para /ranking: nombre mostrado, emoji y unidad
const CATEGORIAS_RANKING = {
    elo:          { label: "ELO",         emoji: "🏆", unidad: "" },
    goles:        { label: "Goles",       emoji: "⚽", unidad: "" },
    asistencias:  { label: "Asistencias", emoji: "🎯", unidad: "" },
    victorias:    { label: "Victorias",   emoji: "🥇", unidad: "" },
    partidos:     { label: "Partidos",    emoji: "📋", unidad: "" },
};
const MEDALLAS = ["🥇", "🥈", "🥉"];

// Paleta consistente para las respuestas de comandos (embeds en vez de texto
// plano suelto): así todos los mensajes del bot se ven parejos.
const COLOR_OK = 0x00FF88;
const COLOR_ERROR = 0xFF3366;
const COLOR_WARN = 0xFFA500;
const COLOR_INFO = 0x5865F2;

// Arma una respuesta de comando prolija y consistente (embed simple con
// descripción), en vez de mandar strings sueltos con `content`.
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
        GatewayIntentBits.MessageContent, // necesario para leer el texto de los mensajes del canal puente
    ],
});

// ── Comparación segura de secretos ──
// Evita timing attacks al comparar el secreto recibido contra el esperado
// (antes se usaba `!==`, que compara caracter por caracter y puede filtrar
// por cuánto tarda la comparación cuántos caracteres coinciden). Es un
// endpoint HTTP interno de bajo riesgo, pero la comparación segura es
// gratis y evita tener que volver a pensarlo si el puerto se expone más
// adelante.
function secretoValido(recibido, esperado) {
    if (typeof recibido !== "string" || typeof esperado !== "string") return false;
    const a = Buffer.from(recibido);
    const b = Buffer.from(esperado);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

// ── Registro de slash commands ───────────────────────────────────────────
// Opción "sala" reutilizable para elegir a qué sala (HA/H4) aplica una
// acción administrativa. Por defecto HA, para no cambiar el comportamiento
// de instalaciones existentes de una sola sala.
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
    .addStringOption((opt) =>
    opt.setName("codigo").setDescription("El código que te dio el bot en el juego").setRequired(true)
    )
    .addStringOption(opcionSala),
    new SlashCommandBuilder()
    .setName("ranking")
    .setDescription("Mostrá el top de jugadores de la sala")
    .addStringOption((opt) =>
    opt
    .setName("categoria")
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
    opt
    .setName("sala")
    .setDescription("Qué sala mostrar (por defecto: ambas)")
    .setRequired(false)
    .addChoices(
        { name: "Ambas salas", value: "ambas" },
        { name: "HA (principal)", value: "HA" },
                { name: "H4 (secundaria)", value: "H4" },
    )
    )
    .addIntegerOption((opt) =>
    opt
    .setName("top")
    .setDescription("Cuántos jugadores mostrar (por defecto: 10, máximo: 25)")
    .setMinValue(1)
    .setMaxValue(25)
    .setRequired(false)
    ),
// ── Comandos administrativos: todos ocultos/bloqueados para quien no tenga el
// permiso de Administrador en el servidor de Discord (Discord lo filtra solo). ──
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

// Antes: si el registro fallaba una sola vez al arrancar (Discord lento,
// rate limit momentáneo), los slash commands quedaban desactualizados hasta
// el próximo restart manual. Ahora reintenta con backoff.
async function registrarComandos(intentos = 3, esperaBaseMs = 3000) {
    const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
    for (let i = 1; i <= intentos; i++) {
        try {
            await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: comandos });
            log.ok(`✅ Slash commands registrados correctamente (${comandos.length} comandos: /codigo, /ranking, y los administrativos).`);
            return;
        } catch (e) {
            log.error(`No se pudieron registrar los slash commands (intento ${i}/${intentos}):`, e.message);
            if (i < intentos) await new Promise((r) => setTimeout(r, esperaBaseMs * i));
        }
    }
    log.error("Se agotaron los reintentos para registrar los slash commands. Van a quedar desactualizados hasta el próximo restart o un registro manual.");
}

// ── Retry genérico con backoff para llamadas HTTP salientes ─────────────
// Solo reintenta fallos DE RED/TIMEOUT (status === 0), nunca respuestas
// HTTP válidas con error (4xx/5xx), porque esas ya son una respuesta real
// del servidor (ej. "código inválido") y reintentar no cambiaría nada.
async function conReintentos(fn, intentos = 3, esperaBaseMs = 400) {
    let ultimoResultado;
    for (let i = 1; i <= intentos; i++) {
        ultimoResultado = await fn();
        if (ultimoResultado.status !== 0) return ultimoResultado;
        if (i < intentos) await new Promise((r) => setTimeout(r, esperaBaseMs * i));
    }
    return ultimoResultado;
}

// ── Llama al servidor de verificación dentro de index.js ────────────────
function confirmarCodigoSinReintento(codigo, discordId, sala = "HA", discordTag = null) {
    const destino = SALAS[sala] || SALAS.HA;
    return new Promise((resolve) => {
        const body = JSON.stringify({ codigo, discordId, discordTag });
        const req = http.request(
            {
                hostname: destino.host,
                port: destino.port,
                path: "/verificar",
                method: "POST",
                timeout: 5000,
                headers: {
                    "Content-Type": "application/json",
                    "Content-Length": Buffer.byteLength(body),
                                 "x-verificacion-secreto": destino.secreto,
                },
            },
            (res) => {
                let respuesta = "";
                res.on("data", (chunk) => (respuesta += chunk));
                res.on("end", () => {
                    try {
                        resolve({ status: res.statusCode, ...JSON.parse(respuesta || "{}") });
                    } catch {
                        resolve({ status: res.statusCode, ok: false });
                    }
                });
            }
        );
        req.on("timeout", () => req.destroy(new Error("timeout")));
        req.on("error", () => resolve({ status: 0, ok: false }));
        req.write(body);
        req.end();
    });
}
function confirmarCodigo(codigo, discordId, sala = "HA", discordTag = null) {
    return conReintentos(() => confirmarCodigoSinReintento(codigo, discordId, sala, discordTag));
}

// ── Pide una acción administrativa al servidor dentro de index.js ───────
function llamarAdminSinReintento(accion, payload = {}, sala = "HA") {
    const destino = SALAS[sala] || SALAS.HA;
    return new Promise((resolve) => {
        const body = JSON.stringify({ accion, ...payload });
        const req = http.request(
            {
                hostname: destino.host,
                port: destino.port,
                path: "/admin",
                method: "POST",
                timeout: 5000,
                headers: {
                    "Content-Type": "application/json",
                    "Content-Length": Buffer.byteLength(body),
                                 "x-verificacion-secreto": destino.secreto,
                },
            },
            (res) => {
                let respuesta = "";
                res.on("data", (chunk) => (respuesta += chunk));
                res.on("end", () => {
                    try {
                        resolve({ status: res.statusCode, ...JSON.parse(respuesta || "{}") });
                    } catch {
                        resolve({ status: res.statusCode, ok: false });
                    }
                });
            }
        );
        req.on("timeout", () => req.destroy(new Error("timeout")));
        req.on("error", () => resolve({ status: 0, ok: false }));
        req.write(body);
        req.end();
    });
}
// Nota: acciones administrativas (kick, ban, etc.) NO se reintentan por
// defecto para evitar duplicar el efecto si el primer intento en realidad sí
// llegó a destino y solo se perdió la respuesta (ej. banear dos veces con
// distinto "dias", o mandar el mismo mensaje de chat dos veces). Se deja
// disponible `conReintentos` para quien quiera usarlo caso por caso.
function llamarAdmin(accion, payload = {}, sala = "HA") {
    return llamarAdminSinReintento(accion, payload, sala);
}

// Resuelve el channel_id real detrás de un webhook, pegándole una vez con GET.
// Un webhook solo permite MANDAR mensajes; para escuchar mensajes de ese canal el bot
// necesita el id real y el intent de mensajes (ver messageCreate más abajo).
function resolverCanalDeWebhook(webhookUrl) {
    return new Promise((resolve) => {
        https.get(webhookUrl, (res) => {
            let data = "";
            res.on("data", (chunk) => (data += chunk));
            res.on("end", () => {
                try {
                    const info = JSON.parse(data);
                    resolve(info.channel_id || null);
                } catch {
                    resolve(null);
                }
            });
        }).on("error", () => resolve(null));
    });
}

// Igual que resolverCanalDeWebhook, pero con reintentos con backoff.
// ANTES: si la resolución fallaba una sola vez al arrancar (glitch de red,
// Discord momentáneamente lento, etc.), el puente Discord → Hax quedaba
// roto HASTA EL PRÓXIMO RESTART del proceso, sin ningún reintento automático.
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

// ── Pide el ranking al servidor dentro de index.js ───────────────────────
// Es un GET idempotente, así que acá sí conviene reintentar ante glitches
// de red en vez de mostrarle al usuario un error por un simple timeout.
function pedirRankingSinReintento(categoria, limite, sala = "HA") {
    const destino = SALAS[sala] || SALAS.HA;
    return new Promise((resolve) => {
        const path = `/ranking?categoria=${encodeURIComponent(categoria)}&limite=${encodeURIComponent(limite)}`;
        const req = http.request(
            {
                hostname: destino.host,
                port: destino.port,
                path,
                method: "GET",
                timeout: 5000,
                headers: { "x-verificacion-secreto": destino.secreto },
            },
            (res) => {
                let respuesta = "";
                res.on("data", (chunk) => (respuesta += chunk));
                res.on("end", () => {
                    try {
                        resolve({ status: res.statusCode, ...JSON.parse(respuesta || "{}") });
                    } catch {
                        resolve({ status: res.statusCode, ok: false });
                    }
                });
            }
        );
        req.on("timeout", () => req.destroy(new Error("timeout")));
        req.on("error", () => resolve({ status: 0, ok: false }));
        req.end();
    });
}
function pedirRanking(categoria, limite, sala = "HA") {
    return conReintentos(() => pedirRankingSinReintento(categoria, limite, sala));
}

// Arma el embed del ranking a partir de la data que devuelve index.js
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

client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === "codigo") {
        // Solo tiene sentido usarlo en el canal de verificación (opcional, pero evita ruido en otros canales)
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

    // ── Comandos administrativos: todos pegan a /admin en index.js. Discord ya se
    // encarga de que solo los vea/use alguien con permiso de Administrador (ver
    // setDefaultMemberPermissions en cada SlashCommandBuilder), pero igual chequeamos acá
    // por las dudas de que el permiso se haya sobreescrito a mano en el server.
    const ACCIONES_ADMIN = ["reiniciar", "minutos", "goles", "decir", "dar-admin", "kickear", "banear", "banear-ip", "desbanear"];
    if (ACCIONES_ADMIN.includes(interaction.commandName)) {
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

        // Fallback "?" para campos que el servidor del juego podría no mandar
        // (ej. `dias` en un ban): antes, si faltaba, el mensaje mostraba
        // literalmente "undefined día(s)".
        const mensajesOk = {
            reiniciar: () => respuestaOk(resultado.mensaje || "Listo.", "🔄 Sala reiniciada"),
          minutos: () => respuestaOk(resultado.mensaje, "⏱️ Tiempo límite actualizado"),
          goles: () => respuestaOk(resultado.mensaje, "⚽ Límite de goles actualizado"),
          decir: () => respuestaOk(`Tu mensaje llegó al chat del juego: *"${interaction.options.getString("mensaje")}"*`, "💬 Mensaje enviado"),
          "dar-admin": () => respuestaOk(`**${resultado.nombre ?? "?"}** ahora es administrador en la sala.`, "🛠️ Admin otorgado"),
          kickear: () => respuestaOk(`**${resultado.nombre ?? "?"}** fue expulsado de la sala. Puede volver a entrar cuando quiera.`, "👢 Jugador expulsado"),
          banear: () => respuestaOk(`**${resultado.nombre ?? "?"}** fue baneado por **${resultado.dias ?? "?"} día(s)**.`, "⛔ Jugador baneado"),
          "banear-ip": () => respuestaOk(`**${resultado.nombre ?? "?"}** fue baneado por cuenta y por red durante **${resultado.dias ?? "?"} día(s)**.`, "⛔ Baneo reforzado (cuenta + red)"),
          desbanear: () => respuestaOk(`**${resultado.nombre ?? "?"}** ya no está baneado.`, "✅ Jugador desbaneado"),
        };
        await interaction.editReply(mensajesOk[interaction.commandName]());
        return;
    }
});

// ── Canal puente: todo lo que se escriba en el canal detrás de CHAT_RELAY_WEBHOOK_URL
// se manda como mensaje al chat del juego. ──────────────────────────────
// Límite defensivo de longitud: el chat del juego no necesita mensajes de
// varios miles de caracteres, y mandarlos tal cual podría romper el parser
// del lado de index.js o saturar el chat in-game.
const RELAY_MAX_LARGO = 300;

client.on("messageCreate", async (message) => {
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
});

client.once("clientReady", async () => {
    log.ok(`Bot de Discord conectado como ${client.user.tag}`);
    await registrarComandos();

    if (CHAT_RELAY_WEBHOOK_URL) {
        CHAT_RELAY_CANAL_ID = await resolverCanalDeWebhookConReintentos(CHAT_RELAY_WEBHOOK_URL);
        if (CHAT_RELAY_CANAL_ID) {
            log.ok(`Canal puente Discord → Hax resuelto correctamente (canal ${CHAT_RELAY_CANAL_ID}).`);
        } else {
            log.error("No se pudo resolver el canal del webhook CHAT_RELAY_WEBHOOK_URL tras varios intentos. El puente Discord → Hax no va a funcionar hasta que se reinicie el bot o se resuelva el problema de red.");
        }
    } else {
        log.warn("CHAT_RELAY_WEBHOOK_URL no está definido; el puente Discord → Hax queda desactivado.");
    }
});

client.on("error", (e) => log.error("Error del cliente de Discord:", e.message));
client.on("warn", (msg) => log.warn("Aviso del cliente de Discord:", msg));
client.on("shardDisconnect", (event, shardId) => log.warn(`Shard ${shardId} desconectado (código ${event?.code ?? "?"}). discord.js va a intentar reconectar solo.`));
client.on("shardReconnecting", (shardId) => log.warn(`Shard ${shardId} reconectando...`));
client.on("shardResume", (shardId) => log.ok(`Shard ${shardId} reconectado correctamente.`));

client.login(DISCORD_TOKEN).catch((e) => {
    log.error("No se pudo iniciar sesión en Discord (revisá DISCORD_TOKEN):", e.message);
    process.exit(1);
});

// Saca texto plano de un footer que puede venir como string ("Bahía Blanca Futsal")
// o como objeto { text: "..." } (que es como lo arma construirEmbed() en index.js).
// FIX: antes esto siempre hacía String(data.embed.footer), y cuando footer llegaba
// como objeto {text: "..."} eso daba literalmente "[object Object]" pegado abajo de
// TODOS los embeds. Por eso se veía siempre ese texto feo al pie de cada mensaje.
function textoFooter(footer) {
    if (!footer) return null;
    if (typeof footer === "string") return footer;
    if (typeof footer === "object" && typeof footer.text === "string") return footer.text;
    return null;
}

// Igual que textoFooter pero genérico, por si algún campo llega mal formado desde
// index.js (objeto en vez de string/número): evita otro "[object Object]" suelto.
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

// ── Historial combinado (HA + H4 en UN SOLO mensaje) ────────────────────
// Cada sala manda su propio embed vía "historial_actualizar"; acá los
// guardamos en memoria (uno por roomId) y armamos SIEMPRE un único mensaje
// con ambos embeds juntos, editándolo en vez de mandar uno nuevo cada vez.
// El messageId se persiste en un archivito en disco para que, si el bot se
// reinicia, siga editando el mismo mensaje en vez de crear uno duplicado.
const HISTORIAL_ESTADO_PATH = process.env.HISTORIAL_ESTADO_PATH || "./historial-estado.json";
let historialEmbeds = { HA: null, H4: null };
let historialMessageId = null;

try {
    const guardado = JSON.parse(fs.readFileSync(HISTORIAL_ESTADO_PATH, "utf8"));
    historialMessageId = guardado.messageId || null;
} catch {
    // No hay estado previo (primera vez, o archivo corrupto/borrado): arranca de cero.
}

function guardarEstadoHistorial() {
    try {
        fs.writeFileSync(HISTORIAL_ESTADO_PATH, JSON.stringify({ messageId: historialMessageId }));
    } catch (e) {
        log.error("No se pudo persistir el estado del historial:", e.message);
    }
}

// Recibe el embed ya armado de UNA sala (HA o H4), lo guarda, y actualiza el
// único mensaje del canal de historial con los embeds de las salas que ya
// mandaron algo (así funciona bien aunque una de las dos todavía no arrancó).
async function manejarHistorial(roomId, embedData) {
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
}

// Arma un EmbedBuilder de discord.js a partir del objeto plano {title,
// description, color, fields, footer, thumbnail} que manda index.js (mismo
// formato que se usa para el resto de los eventos).
function construirEmbedDiscord(data) {
    const embed = new EmbedBuilder()
    .setTitle(textoSeguro(data?.title, "📚 Historial de la liga"))
    .setDescription(textoSeguro(data?.description, ""))
    .setColor(data?.color ?? COLORES_EVENTO.historial_actualizar);

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

// Límite de tamaño de body: los eventos más pesados son los replays en
// base64 (~algunos MB), así que dejamos margen generoso pero acotado para
// no permitir que un body gigante (por error o abuso) tire abajo el proceso
// por consumo de memoria.
const BODY_MAX_BYTES = 25 * 1024 * 1024; // 25 MB

const server = http.createServer((req, res) => {
    // Endpoint de salud simple, sin secreto, para monitoreo externo (uptime
    // checks, healthcheck de systemd/docker, etc.). No expone información
    // sensible, solo confirma que el proceso está vivo y respondiendo.
    if (req.method === "GET" && req.url === "/salud") {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ ok: true, sala: ROOM_ID, discordListo: client.isReady() }));
    }

    if (req.method !== "POST" || req.url !== "/evento") {
        res.writeHead(404);
        return res.end();
    }

    let body = "";
    let largoRecibido = 0;
    let abortado = false;

    // Si el cliente (index.js) se queda colgado a mitad de mandar el body,
    // no dejamos el socket abierto para siempre.
    req.setTimeout(15000, () => {
        abortado = true;
        res.writeHead(408);
        res.end("Timeout esperando el cuerpo de la petición");
        req.destroy();
    });

    req.on("data", (chunk) => {
        if (abortado) return;
        largoRecibido += chunk.length;
        if (largoRecibido > BODY_MAX_BYTES) {
            abortado = true;
            res.writeHead(413);
            res.end("Cuerpo de la petición demasiado grande");
            req.destroy();
            return;
        }
        body += chunk;
    });

    req.on("end", async () => {
        if (abortado) return;
        try {
            const data = JSON.parse(body);

            if (!secretoValido(data.secreto, SECRETO)) {
                res.writeHead(401);
                return res.end("No autorizado: secreto inválido");
            }
            if (typeof data.tipo !== "string" || !data.tipo) {
                res.writeHead(400);
                return res.end('Falta o es inválido el campo "tipo" del evento');
            }

            const roomId = normalizarRoomId(data.roomId);

            // Historial: un único mensaje compartido entre HA y H4, con el embed
            // de cada sala. Se maneja aparte porque no es "un canal fijo por
            // tipo", sino un mensaje que combina lo que mandan las dos salas.
            if (data.tipo === "historial_actualizar") {
                try {
                    const messageId = await manejarHistorial(roomId, data.embed);
                    res.writeHead(200);
                    return res.end(JSON.stringify({ ok: true, messageId }));
                } catch (e) {
                    log.error("Error actualizando el historial combinado:", e.message);
                    res.writeHead(500);
                    return res.end("Error actualizando el historial");
                }
            }

            const claveCanal = TIPO_A_CLAVE_CANAL[data.tipo];
            const canalId = claveCanal && CANALES_POR_SALA[roomId][claveCanal];
            if (!canalId) {
                log.error(`Evento recibido con tipo sin canal asignado: "${data.tipo}" (sala ${roomId}). Revisá el mapeo CANALES_POR_SALA en discord-bot.js.`);
                res.writeHead(400);
                return res.end(`Tipo de evento "${data.tipo}" no tiene canal asignado para la sala ${roomId}`);
            }

            let canal;
            try {
                canal = await client.channels.fetch(canalId);
            } catch (e) {
                log.error(`No se pudo obtener el canal de Discord para el tipo "${data.tipo}" (sala ${roomId}, canalId=${canalId}). Motivo de Discord: [${e.code ?? "?"}] ${e.message}. Chequeá que el canal exista, que el bot esté en ese servidor, y que tenga permiso "Ver canal" ahí.`);
                res.writeHead(500);
                return res.end(`Canal de Discord no accesible: [${e.code ?? "?"}] ${e.message}`);
            }
            if (!canal) {
                log.error(`El canal de Discord para el tipo "${data.tipo}" (sala ${roomId}, canalId=${canalId}) no existe o el bot no tiene acceso.`);
                res.writeHead(500);
                return res.end("Canal de Discord no encontrado");
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

            // live_editar necesita editar un mensaje existente en vez de mandar uno nuevo (el "estado de
            // la sala" es UN SOLO mensaje que se va actualizando). Si ese mensaje fue borrado a mano en
            // Discord (o el canal cambió), el fetch/edit tira error y el panel se quedaba "muerto" para
            // siempre (index.js seguía intentando editar un id que ya no existe). Ahora, si falla, se
            // manda un mensaje NUEVO y se devuelve ese id para que index.js actualice el que tiene
            // guardado y siga editando ese de ahí en adelante.
            if (data.tipo === "live_editar" && data.messageId) {
                try {
                    const msg = await canal.messages.fetch(data.messageId);
                    await msg.edit({ embeds: [embed] });
                    res.writeHead(200);
                    return res.end(JSON.stringify({ ok: true, messageId: msg.id }));
                } catch (e) {
                    log.warn(`No se pudo editar el mensaje ${data.messageId} de "${data.tipo}" (¿lo borraron?), mando uno nuevo:`, e.message);
                    const nuevo = await canal.send({ embeds: [embed] });
                    res.writeHead(200);
                    return res.end(JSON.stringify({ ok: true, messageId: nuevo.id, recreado: true }));
                }
            }

            // Replay: viene con el archivo .hbr2 en base64 (data.archivoBase64 +
            // data.nombreArchivo), se manda como adjunto junto con el embed.
            if (data.tipo === "replay" && data.archivoBase64) {
                try {
                    const buffer = Buffer.from(data.archivoBase64, "base64");
                    const nombre = data.nombreArchivo || `replay_${Date.now()}.hbr2`;
                    const adjunto = new AttachmentBuilder(buffer, { name: nombre });
                    const enviado = await canal.send({ embeds: [embed], files: [adjunto] });
                    res.writeHead(200);
                    return res.end(JSON.stringify({ ok: true, messageId: enviado.id }));
                } catch (e) {
                    log.error("Error mandando el archivo de la replay a Discord:", e.message);
                    res.writeHead(500);
                    return res.end("Error mandando la replay");
                }
            }

            const enviado = await canal.send({ embeds: [embed] });
            res.writeHead(200);
            res.end(JSON.stringify({ ok: true, messageId: enviado.id }));
        } catch (e) {
            log.error("Error procesando evento del juego:", e.message);
            if (!res.headersSent) {
                res.writeHead(500);
                res.end("Error interno procesando el evento");
            }
        }
    });
});

server.on("clientError", (err, socket) => {
    // Requests HTTP malformados que llegan a nivel socket (no a nivel de
    // nuestro handler). Sin esto, node puede dejar el socket colgado.
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
});

server.listen(PUERTO, "127.0.0.1", () => {
    log.ok(`✅ Escuchando eventos del servidor del juego en http://127.0.0.1:${PUERTO}/evento (salud: /salud)`);
});

process.on("uncaughtException", (err) => {
    log.error("💥 Error no capturado en bot.js (el proceso sigue corriendo):", err);
});
process.on("unhandledRejection", (reason) => {
    log.error("💥 Promesa rechazada sin manejar en bot.js (el proceso sigue corriendo):", reason);
});

// ── Apagado prolijo ──
// A diferencia de index.js, bot.js no tiene estado que persistir en
// PostgreSQL; alcanza con cerrar el servidor HTTP y la conexión a Discord
// de forma ordenada para no dejar sockets colgados.
let apagandoBot = false;
async function shutdownBot(señal) {
    if (apagandoBot) return; apagandoBot = true;
    log.warn(`\n🛑 Señal ${señal} recibida. Cerrando bot.js...`);

    const forzarSalida = setTimeout(() => {
        log.error("⏱️ Timeout apagando bot.js; forzando salida.");
        process.exit(1);
    }, 10000);
    forzarSalida.unref?.();

    await new Promise((resolve) => server.close(() => resolve())).catch(() => {});
    try {
        client.destroy();
    } catch (e) {
        log.error("Error cerrando cliente de Discord:", e.message);
    }
    clearTimeout(forzarSalida);
    process.exit(0);
}
process.on("SIGINT", () => shutdownBot("SIGINT"));
process.on("SIGTERM", () => shutdownBot("SIGTERM"));