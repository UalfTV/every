// BahiaClient — servidor de presencia, amigos, clanes, voz, beta keys, admin, stats, party
// Node puro + pg para stats.
//
// v5 — Pasada de calidad:
//   · /admin requiere BETA_ADMIN_KEY (antes servía el HTML a cualquiera)
//   · bind a 127.0.0.1 por defecto (BIND_HOST override)
//   · Comparación de secretos con timingSafeEqual
//   · /admin/user/block y /delete limpian party huérfana
//   · getPresenceForPlayer O(1) via índice inverso
//   · flushAndExit async: espera cierre del pool de Postgres (con techo)
//   · readBody rechaza con 413 explícito (BodyTooLargeError)
//   · new URL con fallback a "localhost" si falta Host header
//   · fetch() con fallback a http.get para Node 16/17
//   · RATE_SSE_CONNECTIONS → MAX_SSE_CONNECTIONS_PER_PLAYER (es cap, no rate)
//
// v4 — Fixes post-publish:
//   · Privacy: friends_of_friends ahora se aplica (antes se ignoraba)
//   · Anti-impersonación en /heartbeat (playerId debe pertenecer al clientId)
//   · Perfiles/avatares dual-key (pid:playerId estable + nick legacy)
//   · /match/end en transacción (evita stats parciales si falla)
//   · /match/start evita duplicados en la misma sala
//   · SSE se cierra al bloquear/borrar usuario
//   · Rate limit heartbeat relajado para NAT compartido
//   · Cache de admin.html con revalidación por mtime
//   · server.on('error') handler
//   · db.shutdown() en flushAndExit
//   · Validación estricta de /voice/signal
//   · Nuevo endpoint /player/update-nick
//   · discordId persistido en players
//
// LIMITACIÓN BETA: auth con API key compartida.

const http = require('http')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

let db = null
try { db = require('./db') } catch (e) {
  console.warn('[bc-presence] pg no disponible, stats deshabilitadas:', e.message)
}

const _origLog = console.log.bind(console)
const _origWarn = console.warn.bind(console)
const _origError = console.error.bind(console)
function _ts(){ return new Date().toISOString().replace('T', ' ').slice(0, 19) }
console.log = (...a) => _origLog(`[${_ts()}]`, ...a)
console.warn = (...a) => _origWarn(`[${_ts()}]`, ...a)
console.error = (...a) => _origError(`[${_ts()}]`, ...a)

const PORT = parseInt(process.env.PORT || '8787', 10)
// Por defecto bindeamos solo a localhost. Si necesitás exponer el server a
// otra interfaz (ej. otro contenedor en la misma red Docker), seteá
// BIND_HOST=0.0.0.0 o la IP correspondiente en el .env.
const BIND_HOST = process.env.BIND_HOST || '127.0.0.1'
const API_KEY = process.env.API_KEY || ''
const BETA_ADMIN_KEY = process.env.BETA_ADMIN_KEY || ''
const DATA_DIR = process.env.DATA_DIR || '/opt/bc-presence/data'
const AVATARS_PATH = path.join(DATA_DIR, 'avatars.json')
const PROFILES_PATH = path.join(DATA_DIR, 'profiles.json')
const BETA_KEYS_PATH = path.join(DATA_DIR, 'beta-keys.json')
const USERS_PATH = path.join(DATA_DIR, 'users.json')
const PLAYERS_PATH = path.join(DATA_DIR, 'players.json')
const CLANS_PATH = path.join(DATA_DIR, 'clans.json')
const FRIENDS_PATH = path.join(DATA_DIR, 'friendships.json')
const FRIENDS_BACKUP_PATH = path.join(DATA_DIR, 'friendships.json.pre-playerid.bak')
const NOTIFICATIONS_PATH = path.join(DATA_DIR, 'notifications.json')
const PARTIES_PATH = path.join(DATA_DIR, 'parties.json')
const ADMIN_HTML_PATH = path.join(__dirname, 'admin.html')
let _adminHtmlCache = null

const TRUST_PROXY = process.env.TRUST_PROXY === '1'

const TTL_MS = 20_000
const SWEEP_MS = 15_000
const VOICE_TTL_MS = 15_000
const MAX_NICKS_PER_QUERY = 50

// Heartbeat: clientes mandan cada 5s. Con NAT compartido necesitamos margen.
const RATE_HEARTBEAT_MAX = 30
const RATE_HEARTBEAT_WINDOW_MS = 5000
const RATE_MAX_NICKS_PER_IP = 60
const RATE_MAX_PRESENCE_QUERIES = 20
const RATE_MAX_VOICE_SIGNALS = 30
const RATE_CLEANUP_MS = 60_000
const RATE_AVATAR_UPLOADS = 5
const RATE_AVATAR_WINDOW_MS = 60_000
const RATE_PROFILE_UPDATES = 10
const RATE_PROFILE_WINDOW_MS = 60_000
const RATE_BETA_CHECKS = 20
const RATE_BETA_WINDOW_MS = 60_000
const RATE_ADMIN_ACTIONS = 20
const RATE_ADMIN_WINDOW_MS = 1000
const RATE_PLAYER_CHECKS = 30
const RATE_PLAYER_WINDOW_MS = 60_000
const RATE_MATCH_CALLS = 60
const RATE_MATCH_WINDOW_MS = 60_000

const RATE_FRIEND_REQUESTS = 10
const RATE_FRIEND_REQUESTS_WINDOW_MS = 60_000
const RATE_PLAY_INVITES = 5
const RATE_PLAY_INVITES_WINDOW_MS = 60_000
const RATE_PARTY_INVITES = 5
const RATE_PARTY_INVITES_WINDOW_MS = 60_000
const RATE_PLAYER_SEARCHES = 30
const RATE_PLAYER_SEARCHES_WINDOW_MS = 60_000
const RATE_PRIVACY_UPDATES = 5
const RATE_PRIVACY_UPDATES_WINDOW_MS = 60_000
// No es un rate limit sino un cap duro de conexiones concurrentes por player
// (múltiples tabs, reconexiones zombie). Al llegar al cap, se cierra la más
// vieja para hacerle lugar a la nueva.
const MAX_SSE_CONNECTIONS_PER_PLAYER = 5

const RATE_PARTY_CREATES = 3
const RATE_PARTY_CREATES_WINDOW_MS = 5 * 60 * 1000
const PARTY_MAX_SIZE_DEFAULT = 5
const PARTY_MAX_SIZE_LIMIT   = 10
const PARTY_TTL_MS           = 24 * 60 * 60 * 1000

const MAX_EPHEMERAL_NOTIFS = 50
const MAX_PERSISTENT_NOTIFS = 100
const EPHEMERAL_TTL_MS = 10 * 60 * 1000
const PERSISTENT_TTL_MS = 30 * 24 * 60 * 60 * 1000
const SSE_KEEPALIVE_MS = 25_000

const MAX_AVATAR_BYTES = 2_000_000
const MAX_TOTAL_AVATARS = 500
const MAX_TOTAL_STORAGE = 200_000_000
const SAVE_DEBOUNCE_MS = 2000
const SAVE_RETRY_MS = 15000
const SAFETY_SAVE_MS = 60000

const MAX_BIO_LENGTH = 80
const ALLOWED_BANNERS = ['violet','ocean','sunset','forest','fire','ice','matrix','rainbow','mono','candy','neon','deep']
const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i

const PLAYER_ID_MIN = 3
const PLAYER_ID_MAX = 20
const PLAYER_ID_RE = /^[a-zA-Z0-9_-]+$/
const PLAYER_ID_RESERVED = new Set(['admin','bahia','bahiaclient','system','bot','mod','moderator','staff','root','null','undefined','api','support','help','login','register','play','me','search','player','players','user','users'])

const ALLOWED_ROLES = ['member', 'helper', 'tester', 'beta_tester', 'mod', 'admin', 'dev']
const DEFAULT_ROLE = 'member'
function normalizeRole(raw){
  const r = String(raw || '').trim().toLowerCase()
  return ALLOWED_ROLES.includes(r) ? r : DEFAULT_ROLE
}

const NICKNAME_MIN = 1
const NICKNAME_MAX = 25
const NICKNAME_RE = /^[\p{L}\p{N}\s._\-+()\[\]#@!?]{1,25}$/u

const GEO_CACHE_TTL = 24 * 60 * 60 * 1000
const GEO_RATE_MS = 1500
const GEO_FETCH_TIMEOUT_MS = 5000
// fetch() global es de Node 18+. Para Node 16/17 tiramos de http.get con
// AbortSignal. Detectamos una vez al arranque.
const HAS_GLOBAL_FETCH = typeof fetch === 'function'

const NOTIF_TYPES_PERSISTENT = new Set([
  'friend_request', 'friend_accepted', 'clan_invite',
  'tournament_invite', 'clan_announcement',
])
const NOTIF_TYPES_EPHEMERAL = new Set([
  'invite_to_play', 'party_invite',
])

const DEFAULT_PRIVACY = {
  friendRequests: 'everyone',
  onlineStatus:   'friends',
  currentRoom:    'friends',
  allowInvites:   true,
  notifyFriendOnline: true,
}
const VALID_PRIVACY_VALUES = new Set(['everyone', 'friends_of_friends', 'friends', 'nobody'])

if (!API_KEY) console.warn('[bc-presence] OJO: sin API_KEY.')
if (!BETA_ADMIN_KEY) console.warn('[bc-presence] OJO: sin BETA_ADMIN_KEY.')
if (TRUST_PROXY) console.log('[bc-presence] TRUST_PROXY=1.')

const presence = new Map()
// Índice inverso playerIdLower → nickLower del presence activo. Se mantiene
// sincronizado desde /heartbeat, /leave y cleanup(). Evita iterar toda la
// presencia cada vez que alguien pregunta por un jugador.
const presenceByPlayerId = new Map()
const friendships = new Map()
const notificationsPersistent = new Map()
const notificationsEphemeral = new Map()
const sseClients = new Map()
const playerIdStats = new Map()
const clans = new Map()
let clanCounter = 0
const voiceChannels = new Map()
const voiceMailbox = new Map()
const ipStats = new Map()
const userAvatars = new Map()
const userProfiles = new Map()
const betaKeys = new Map()
const users = new Map()
const players = new Map()
const playersByRecovery = new Map()
const geoCache = new Map()
let lastGeoRequest = 0
const geoQueue = []
let geoProcessing = false
const activeMatches = new Map()

const parties = new Map()
const partyByPlayer = new Map()

function now() { return Date.now() }
function nickL(n) { return String(n || '').toLowerCase().trim() }
function playerIdL(id) { return String(id || '').toLowerCase().trim() }

// Clave dual-key para perfiles/avatares: si hay playerId usamos "pid:<id>",
// si no caemos al nick legacy.
function profileKeyFor({ playerId, nick }){
  if(playerId){
    const p = players.get(playerIdL(playerId))
    if(p) return `pid:${p.idLower}`
  }
  const nk = nickL(nick)
  return nk || null
}

function loadJsonFile(p){
  try { if(!fs.existsSync(p)) return null; return JSON.parse(fs.readFileSync(p, 'utf8')) }
  catch(e){ console.warn(`[bc-presence] load fail ${p}:`, e.message); return null }
}
function saveJsonFile(p, obj){
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    const tmp = p + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(obj))
    fs.renameSync(tmp, p)
  } catch(e){ console.error(`[bc-presence] save fail ${p}:`, e.message); throw e }
}
function objFromMap(map, mapper){
  const out = {}
  for(const [k, v] of map) out[k] = mapper(v)
  return out
}

// ============================================================
// PRESENCE INDEX
// ============================================================

function _indexPresence(nickLower, entry){
  const pid = entry && entry.playerId ? playerIdL(entry.playerId) : null
  if(pid) presenceByPlayerId.set(pid, nickLower)
}
function _unindexPresence(nickLower){
  for(const [pid, nk] of presenceByPlayerId){ if(nk === nickLower){ presenceByPlayerId.delete(pid); return } }
}

// ============================================================
// AUTH HELPERS
// ============================================================

// Comparación timing-safe: dos secretos del mismo largo se comparan en tiempo
// constante. Si los largos difieren, return false rápido (esa info ya es
// pública vía Content-Length).
function secretoValido(recibido, esperado){
  if(typeof recibido !== 'string' || typeof esperado !== 'string') return false
  if(!recibido.length || !esperado.length) return false
  const a = Buffer.from(recibido)
  const b = Buffer.from(esperado)
  if(a.length !== b.length) return false
  try { return crypto.timingSafeEqual(a, b) } catch { return false }
}

class BodyTooLargeError extends Error {
  constructor(maxBytes){ super(`body too large (max ${maxBytes} bytes)`); this.code = 'BODY_TOO_LARGE'; this.status = 413 }
}

// ============================================================
// LOADERS
// ============================================================

function loadAvatarsFromDisk(){
  const parsed = loadJsonFile(AVATARS_PATH); if(!parsed) return
  let count = 0, totalBytes = 0
  for(const [nk, e] of Object.entries(parsed || {})){
    if(!e || typeof e.dataUrl !== 'string' || e.dataUrl.length > MAX_AVATAR_BYTES) continue
    userAvatars.set(nk, { dataUrl: e.dataUrl, updatedAt: e.updatedAt || now(), bytes: e.dataUrl.length })
    count++; totalBytes += e.dataUrl.length
  }
  console.log(`[bc-presence] avatares: ${count} (${(totalBytes/1024/1024).toFixed(1)}MB)`)
}
function loadProfilesFromDisk(){
  const parsed = loadJsonFile(PROFILES_PATH); if(!parsed) return
  let count = 0
  for(const [nk, e] of Object.entries(parsed || {})){
    if(!e || typeof e !== 'object') continue
    userProfiles.set(nk, {
      avatarColor: typeof e.avatarColor === 'string' && HEX_COLOR_RE.test(e.avatarColor) ? e.avatarColor : null,
      banner: typeof e.banner === 'string' && ALLOWED_BANNERS.includes(e.banner) ? e.banner : null,
      bio: typeof e.bio === 'string' ? e.bio.slice(0, MAX_BIO_LENGTH) : '',
      updatedAt: e.updatedAt || now(),
    })
    count++
  }
  console.log(`[bc-presence] perfiles: ${count}`)
}
function loadBetaKeysFromDisk(){
  const parsed = loadJsonFile(BETA_KEYS_PATH); if(!parsed) return
  let count = 0, used = 0
  for(const [key, e] of Object.entries(parsed || {})){
    if(!e || typeof e !== 'object') continue
    betaKeys.set(key, {
      createdAt: e.createdAt || now(), usedAt: e.usedAt || null,
      usedBy: e.usedBy || null, nickname: e.nickname || null, notes: e.notes || '',
    })
    count++; if(e.usedBy) used++
  }
  console.log(`[bc-presence] beta keys: ${count} (usadas: ${used})`)
}
function loadUsersFromDisk(){
  const parsed = loadJsonFile(USERS_PATH); if(!parsed) return
  let count = 0, blocked = 0
  for(const [cid, e] of Object.entries(parsed || {})){
    if(!e || typeof e !== 'object') continue
    users.set(cid, {
      clientId: cid,
      nickname: e.nickname || null,
      playerId: e.playerId || null,
      playerIdDisplay: e.playerIdDisplay || null,
      key: e.key || null,
      ips: Array.isArray(e.ips) ? e.ips.slice(0, 20) : [],
      geo: e.geo || null,
      preciseGeo: e.preciseGeo || null,
      firstSeen: e.firstSeen || now(),
      lastSeen: e.lastSeen || now(),
      blocked: !!e.blocked,
      blockReason: e.blockReason || null,
      notes: e.notes || '',
    })
    count++; if(e.blocked) blocked++
  }
  console.log(`[bc-presence] users: ${count} (bloqueados: ${blocked})`)
}
function loadPlayersFromDisk(){
  const parsed = loadJsonFile(PLAYERS_PATH); if(!parsed) return
  let count = 0
  for(const [idLower, e] of Object.entries(parsed || {})){
    if(!e || typeof e !== 'object' || !e.id) continue
    const key = String(idLower).toLowerCase()
    players.set(key, {
      id: e.id,
      idLower: key,
      nickname: e.nickname || null,
      recoveryCode: e.recoveryCode || null,
      createdByClientId: e.createdByClientId || null,
      discordId: e.discordId || null,
      createdAt: e.createdAt || now(),
      nicknameHistory: Array.isArray(e.nicknameHistory) ? e.nicknameHistory.slice(-50) : [],
      privacy: normalizePrivacy(e.privacy),
      role: normalizeRole(e.role),
    })
    if(e.recoveryCode) playersByRecovery.set(e.recoveryCode, key)
    count++
  }
  console.log(`[bc-presence] players: ${count}`)
}

function migrateOldFriendships(oldObj){
  const byNick = new Map()
  for(const [idLower, p] of players){
    if(p.nickname){
      const nk = nickL(p.nickname)
      if(!byNick.has(nk)) byNick.set(nk, [])
      byNick.get(nk).push({ idLower, createdAt: p.createdAt })
    }
  }
  for(const [nk, arr] of byNick){ arr.sort((a, b) => a.createdAt - b.createdAt) }

  function resolveNickToPlayerId(nick){
    const nk = nickL(nick)
    if(players.has(nk)) return nk
    const arr = byNick.get(nk)
    if(arr && arr.length) return arr[0].idLower
    return null
  }

  const migrated = new Map()
  let resolved = 0, dropped = 0
  const droppedList = []

  for(const [nickA, list] of Object.entries(oldObj)){
    if(!Array.isArray(list)) continue
    const pidA = resolveNickToPlayerId(nickA)
    if(!pidA){ dropped += list.length; droppedList.push(nickA); continue }
    if(!migrated.has(pidA)) migrated.set(pidA, new Set())
    for(const nickB of list){
      const pidB = resolveNickToPlayerId(nickB)
      if(!pidB){ dropped++; droppedList.push(`${nickA}→${nickB}`); continue }
      if(pidB === pidA) continue
      migrated.get(pidA).add(pidB)
      resolved++
    }
  }

  const out = new Map()
  for(const [pidA, friendsSet] of migrated){
    out.set(pidA, { accepted: new Set(friendsSet), favorites: new Set(), incoming: new Set(), outgoing: new Set() })
  }
  for(const [pidA, entry] of out){
    for(const pidB of entry.accepted){
      if(!out.has(pidB)) out.set(pidB, { accepted: new Set(), favorites: new Set(), incoming: new Set(), outgoing: new Set() })
      out.get(pidB).accepted.add(pidA)
    }
  }
  return { migrated: out, resolved, dropped, droppedList }
}

function loadFriendsFromDisk(){
  const parsed = loadJsonFile(FRIENDS_PATH); if(!parsed) return
  const firstVal = Object.values(parsed)[0]
  const isOldFormat = Array.isArray(firstVal)

  if(isOldFormat){
    console.log('[bc-presence] friendships.json en formato viejo (nick-keyed). Migrando…')
    try {
      fs.writeFileSync(FRIENDS_BACKUP_PATH, JSON.stringify(parsed))
      console.log(`[bc-presence] backup guardado en ${FRIENDS_BACKUP_PATH}`)
    } catch(e){ console.warn('[bc-presence] no se pudo guardar backup:', e.message) }

    const { migrated, resolved, dropped, droppedList } = migrateOldFriendships(parsed)
    for(const [k, v] of migrated) friendships.set(k, v)
    console.log(`[bc-presence] migración: ${migrated.size} jugadores, ${resolved} aristas resueltas, ${dropped} dropeadas`)
    if(droppedList.length){ console.warn(`[bc-presence] entradas dropeadas (primeras 20):`, droppedList.slice(0, 20)) }
    friendsDirtyRef.v = true
    // Defer para garantizar que las declaraciones de abajo ya existan.
    setImmediate(() => scheduleSaveFriendships())
    return
  }

  let count = 0
  for(const [pidLower, e] of Object.entries(parsed)){
    if(!e || typeof e !== 'object') continue
    friendships.set(pidLower, {
      accepted: new Set(Array.isArray(e.accepted) ? e.accepted : []),
      favorites: new Set(Array.isArray(e.favorites) ? e.favorites : []),
      incoming: new Set(Array.isArray(e.incoming) ? e.incoming : []),
      outgoing: new Set(Array.isArray(e.outgoing) ? e.outgoing : []),
    })
    count++
  }
  console.log(`[bc-presence] amistades: ${count} jugadores`)
}

function loadNotificationsFromDisk(){
  const parsed = loadJsonFile(NOTIFICATIONS_PATH); if(!parsed) return
  let count = 0
  for(const [pidLower, arr] of Object.entries(parsed || {})){
    if(!Array.isArray(arr)) continue
    const clean = arr.filter(e => e && typeof e === 'object' && e.id && e.type && NOTIF_TYPES_PERSISTENT.has(e.type))
    if(clean.length) { notificationsPersistent.set(pidLower, clean); count += clean.length }
  }
  console.log(`[bc-presence] notificaciones persistentes: ${count}`)
}

function loadClansFromDisk(){
  const parsed = loadJsonFile(CLANS_PATH); if(!parsed) return
  let count = 0
  for(const [id, e] of Object.entries(parsed || {})){
    if(!e || typeof e !== 'object' || !e.id) continue
    const members = new Set(Array.isArray(e.members) ? e.members : [])
    if(!members.size) continue
    clans.set(id, {
      id: e.id, name: e.name || 'Sin nombre', tag: e.tag || '???',
      owner: e.owner || [...members][0], members, createdAt: e.createdAt || now(),
    })
    const m = String(id).match(/^c([0-9a-z]+)/)
    if(m){ const n = parseInt(m[1], 36); if(!isNaN(n) && n > clanCounter) clanCounter = n }
    count++
  }
  console.log(`[bc-presence] clanes: ${count}`)
}

function loadPartiesFromDisk(){
  const parsed = loadJsonFile(PARTIES_PATH); if(!parsed) return
  let count = 0
  const cutoff = now() - PARTY_TTL_MS
  for(const [pid, e] of Object.entries(parsed || {})){
    if(!e || typeof e !== 'object' || !e.partyId) continue
    if((e.createdAt || 0) < cutoff) continue
    const members = new Set(Array.isArray(e.members) ? e.members.filter(m => players.has(m)) : [])
    if(!members.size) continue
    let leader = String(e.leaderId || '').toLowerCase()
    if(!members.has(leader)) leader = members.values().next().value
    parties.set(e.partyId, {
      partyId: e.partyId, leaderId: leader, members,
      maxSize: Math.min(PARTY_MAX_SIZE_LIMIT, Math.max(2, e.maxSize || PARTY_MAX_SIZE_DEFAULT)),
      createdAt: e.createdAt || now(),
      roomId: e.roomId || null, roomName: e.roomName || null,
    })
    for(const m of members) partyByPlayer.set(m, e.partyId)
    count++
  }
  console.log(`[bc-presence] parties: ${count}`)
}

// ============================================================
// SAVE / TIMERS
// ============================================================

const avatarsTimer = { t: null }, avatarsDirtyRef = { v: false }
const profilesTimer = { t: null }, profilesDirtyRef = { v: false }
const betaKeysTimer = { t: null }, betaKeysDirtyRef = { v: false }
const usersTimer = { t: null }, usersDirtyRef = { v: false }
const playersTimer = { t: null }, playersDirtyRef = { v: false }
const clansTimer = { t: null }, clansDirtyRef = { v: false }
const friendsTimer = { t: null }, friendsDirtyRef = { v: false }
const notificationsTimer = { t: null }, notificationsDirtyRef = { v: false }
const partiesTimer = { t: null }, partiesDirtyRef = { v: false }

function scheduleSave(map, path, timerRef, dirtyRef, serializer, label){
  dirtyRef.v = true
  if(timerRef.t) return
  timerRef.t = setTimeout(() => {
    timerRef.t = null
    if(!dirtyRef.v) return
    try {
      saveJsonFile(path, objFromMap(map, serializer))
      dirtyRef.v = false
      console.log(`[bc-presence] guardado ${label} → ${map.size} entradas`)
    } catch(e){
      console.error(`[bc-presence] FALLO guardando ${label}:`, e.message)
      timerRef.t = setTimeout(() => {
        timerRef.t = null
        if(dirtyRef.v) scheduleSave(map, path, timerRef, dirtyRef, serializer, label)
      }, SAVE_RETRY_MS).unref()
    }
  }, SAVE_DEBOUNCE_MS).unref()
}

function scheduleSaveAvatars(){ scheduleSave(userAvatars, AVATARS_PATH, avatarsTimer, avatarsDirtyRef, e => ({ dataUrl: e.dataUrl, updatedAt: e.updatedAt }), 'avatares') }
function scheduleSaveProfiles(){ scheduleSave(userProfiles, PROFILES_PATH, profilesTimer, profilesDirtyRef, e => ({ avatarColor: e.avatarColor, banner: e.banner, bio: e.bio, updatedAt: e.updatedAt }), 'perfiles') }
function scheduleSaveBetaKeys(){ scheduleSave(betaKeys, BETA_KEYS_PATH, betaKeysTimer, betaKeysDirtyRef, e => ({ createdAt: e.createdAt, usedAt: e.usedAt, usedBy: e.usedBy, nickname: e.nickname, notes: e.notes }), 'beta keys') }
function scheduleSaveUsers(){ scheduleSave(users, USERS_PATH, usersTimer, usersDirtyRef, e => ({ nickname: e.nickname, playerId: e.playerId, playerIdDisplay: e.playerIdDisplay, key: e.key, ips: e.ips, geo: e.geo, preciseGeo: e.preciseGeo, firstSeen: e.firstSeen, lastSeen: e.lastSeen, blocked: e.blocked, blockReason: e.blockReason, notes: e.notes }), 'usuarios') }
function scheduleSavePlayers(){ scheduleSave(players, PLAYERS_PATH, playersTimer, playersDirtyRef, e => ({ id: e.id, nickname: e.nickname, recoveryCode: e.recoveryCode, createdByClientId: e.createdByClientId, discordId: e.discordId || null, createdAt: e.createdAt, nicknameHistory: e.nicknameHistory, privacy: e.privacy, role: e.role || 'member' }), 'players') }
function scheduleSaveClans(){ scheduleSave(clans, CLANS_PATH, clansTimer, clansDirtyRef, e => ({ id: e.id, name: e.name, tag: e.tag, owner: e.owner, members: [...e.members], createdAt: e.createdAt }), 'clanes') }
function scheduleSaveFriendships(){
  scheduleSave(friendships, FRIENDS_PATH, friendsTimer, friendsDirtyRef, e => ({
    accepted: [...e.accepted],
    favorites: [...e.favorites],
    incoming: [...e.incoming],
    outgoing: [...e.outgoing],
  }), 'amistades')
}
function scheduleSaveNotifications(){
  scheduleSave(notificationsPersistent, NOTIFICATIONS_PATH, notificationsTimer, notificationsDirtyRef, arr => arr, 'notificaciones')
}
function scheduleSaveParties(){
  scheduleSave(parties, PARTIES_PATH, partiesTimer, partiesDirtyRef, p => ({
    partyId: p.partyId, leaderId: p.leaderId,
    members: [...p.members], maxSize: p.maxSize,
    createdAt: p.createdAt, roomId: p.roomId, roomName: p.roomName,
  }), 'parties')
}

const SAFETY_TARGETS = [
  { map: userAvatars, path: AVATARS_PATH, dirtyRef: avatarsDirtyRef, label: 'avatares', serializer: e => ({ dataUrl: e.dataUrl, updatedAt: e.updatedAt }) },
  { map: userProfiles, path: PROFILES_PATH, dirtyRef: profilesDirtyRef, label: 'perfiles', serializer: e => ({ avatarColor: e.avatarColor, banner: e.banner, bio: e.bio, updatedAt: e.updatedAt }) },
  { map: betaKeys, path: BETA_KEYS_PATH, dirtyRef: betaKeysDirtyRef, label: 'beta keys', serializer: e => ({ createdAt: e.createdAt, usedAt: e.usedAt, usedBy: e.usedBy, nickname: e.nickname, notes: e.notes }) },
  { map: users, path: USERS_PATH, dirtyRef: usersDirtyRef, label: 'usuarios', serializer: e => ({ nickname: e.nickname, playerId: e.playerId, playerIdDisplay: e.playerIdDisplay, key: e.key, ips: e.ips, geo: e.geo, preciseGeo: e.preciseGeo, firstSeen: e.firstSeen, lastSeen: e.lastSeen, blocked: e.blocked, blockReason: e.blockReason, notes: e.notes }) },
  { map: players, path: PLAYERS_PATH, dirtyRef: playersDirtyRef, label: 'players', serializer: e => ({ id: e.id, nickname: e.nickname, recoveryCode: e.recoveryCode, createdByClientId: e.createdByClientId, discordId: e.discordId || null, createdAt: e.createdAt, nicknameHistory: e.nicknameHistory, privacy: e.privacy, role: e.role || 'member' }) },
  { map: clans, path: CLANS_PATH, dirtyRef: clansDirtyRef, label: 'clanes', serializer: e => ({ id: e.id, name: e.name, tag: e.tag, owner: e.owner, members: [...e.members], createdAt: e.createdAt }) },
  { map: friendships, path: FRIENDS_PATH, dirtyRef: friendsDirtyRef, label: 'amistades', serializer: e => ({ accepted: [...e.accepted], favorites: [...e.favorites], incoming: [...e.incoming], outgoing: [...e.outgoing] }) },
  { map: notificationsPersistent, path: NOTIFICATIONS_PATH, dirtyRef: notificationsDirtyRef, label: 'notificaciones', serializer: arr => arr },
  { map: parties, path: PARTIES_PATH, dirtyRef: partiesDirtyRef, label: 'parties', serializer: p => ({ partyId: p.partyId, leaderId: p.leaderId, members: [...p.members], maxSize: p.maxSize, createdAt: p.createdAt, roomId: p.roomId, roomName: p.roomName }) },
]

setInterval(() => {
  for(const { map, path, dirtyRef, serializer, label } of SAFETY_TARGETS){
    if(!dirtyRef.v) continue
    try {
      saveJsonFile(path, objFromMap(map, serializer))
      dirtyRef.v = false
      console.log(`[bc-presence] safety-save ${label} → ${map.size}`)
    } catch(e){ console.error(`[bc-presence] safety-save FALLO ${label}:`, e.message) }
  }
}, SAFETY_SAVE_MS).unref()

function enforceAvatarLimits(){
  if(userAvatars.size > MAX_TOTAL_AVATARS){
    const sorted = [...userAvatars.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt)
    const toRemove = userAvatars.size - MAX_TOTAL_AVATARS
    for(let i = 0; i < toRemove; i++) userAvatars.delete(sorted[i][0])
    avatarsDirtyRef.v = true
  }
  let totalBytes = 0
  for(const e of userAvatars.values()) totalBytes += e.bytes
  if(totalBytes > MAX_TOTAL_STORAGE){
    const sorted = [...userAvatars.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt)
    for(const [nk, e] of sorted){
      if(totalBytes <= MAX_TOTAL_STORAGE * 0.8) break
      userAvatars.delete(nk); totalBytes -= e.bytes
    }
    avatarsDirtyRef.v = true
  }
}

async function flushAndExit(signal){
  console.log(`[bc-presence] ${signal}, guardando...`)

  // 1) Esperar a que el pool de Postgres cierre (con timeout de seguridad).
  try {
    const shutdownPromise = (db && typeof db.shutdown === 'function')
      ? db.shutdown()
      : (db && db.pool && typeof db.pool.end === 'function' ? db.pool.end() : Promise.resolve())
    await Promise.race([
      Promise.resolve(shutdownPromise).catch(e => console.warn('[bc-presence] db.shutdown error:', e.message)),
      new Promise(r => setTimeout(r, 3000)),
    ])
  } catch(_) {}

  // 2) Cancelar timers debounced (evita que un save async pise el save sync).
  for(const t of [avatarsTimer, profilesTimer, betaKeysTimer, usersTimer, playersTimer, clansTimer, friendsTimer, notificationsTimer, partiesTimer]){ if(t.t){ clearTimeout(t.t); t.t = null } }

  // 3) Saves sincrónicos finales.
  try { saveJsonFile(AVATARS_PATH, objFromMap(userAvatars, e => ({ dataUrl: e.dataUrl, updatedAt: e.updatedAt }))) } catch(_){}
  try { saveJsonFile(PROFILES_PATH, objFromMap(userProfiles, e => ({ avatarColor: e.avatarColor, banner: e.banner, bio: e.bio, updatedAt: e.updatedAt }))) } catch(_){}
  try { saveJsonFile(BETA_KEYS_PATH, objFromMap(betaKeys, e => ({ createdAt: e.createdAt, usedAt: e.usedAt, usedBy: e.usedBy, nickname: e.nickname, notes: e.notes }))) } catch(_){}
  try { saveJsonFile(USERS_PATH, objFromMap(users, e => ({ nickname: e.nickname, playerId: e.playerId, playerIdDisplay: e.playerIdDisplay, key: e.key, ips: e.ips, geo: e.geo, preciseGeo: e.preciseGeo, firstSeen: e.firstSeen, lastSeen: e.lastSeen, blocked: e.blocked, blockReason: e.blockReason, notes: e.notes }))) } catch(_){}
  try { saveJsonFile(PLAYERS_PATH, objFromMap(players, e => ({ id: e.id, nickname: e.nickname, recoveryCode: e.recoveryCode, createdByClientId: e.createdByClientId, discordId: e.discordId || null, createdAt: e.createdAt, nicknameHistory: e.nicknameHistory, privacy: e.privacy, role: e.role || 'member' }))) } catch(_){}
  try { saveJsonFile(CLANS_PATH, objFromMap(clans, e => ({ id: e.id, name: e.name, tag: e.tag, owner: e.owner, members: [...e.members], createdAt: e.createdAt }))) } catch(_){}
  try { saveJsonFile(FRIENDS_PATH, objFromMap(friendships, e => ({ accepted: [...e.accepted], favorites: [...e.favorites], incoming: [...e.incoming], outgoing: [...e.outgoing] }))) } catch(_){}
  try { saveJsonFile(NOTIFICATIONS_PATH, objFromMap(notificationsPersistent, arr => arr)) } catch(_){}
  try { saveJsonFile(PARTIES_PATH, objFromMap(parties, p => ({ partyId: p.partyId, leaderId: p.leaderId, members: [...p.members], maxSize: p.maxSize, createdAt: p.createdAt, roomId: p.roomId, roomName: p.roomName }))) } catch(_){}

  process.exit(0)
}
process.on('SIGTERM', () => { flushAndExit('SIGTERM').catch(() => process.exit(1)) })
process.on('SIGINT',  () => { flushAndExit('SIGINT').catch(() => process.exit(1)) })

process.on('uncaughtException', (err) => { console.error('[bc-presence] uncaughtException:', err && err.stack || err) })
process.on('unhandledRejection', (reason) => { console.error('[bc-presence] unhandledRejection:', (reason && reason.stack) || reason) })

// ============================================================
// IP / GEO
// ============================================================

function normalizeIp(ip){
  if(!ip) return ''
  let raw = String(ip)
  if(raw.startsWith('::ffff:')) raw = raw.slice(7)
  if(raw.includes('%')) raw = raw.split('%')[0]
  return raw
}
function isPrivateIp(ip){
  if(!ip) return true
  const raw = normalizeIp(ip)
  if(raw === 'unknown' || raw === '::1' || raw === '127.0.0.1') return true
  if(raw.startsWith('10.')) return true
  if(raw.startsWith('192.168.')) return true
  if(raw.startsWith('169.254.')) return true
  if(raw.startsWith('172.')){ const s = parseInt(raw.split('.')[1], 10); if(s >= 16 && s <= 31) return true }
  if(raw.startsWith('fc') || raw.startsWith('fd') || raw.startsWith('fe80')) return true
  return false
}
function getGeoForIp(ip){
  const raw = normalizeIp(ip)
  if(isPrivateIp(raw)) return { status: 'private', city: 'Red local', country: 'LAN', lat: null, lon: null, isp: '' }
  const cached = geoCache.get(raw)
  if(cached && (now() - cached.ts) < GEO_CACHE_TTL) return cached
  return null
}
const pendingGeo = new Map()
function queueGeoLookup(ip, callback){
  const raw = normalizeIp(ip)
  if(isPrivateIp(raw)){ callback(getGeoForIp(raw)); return }
  const cached = geoCache.get(raw)
  if(cached && (now() - cached.ts) < GEO_CACHE_TTL){ callback(cached); return }
  if(pendingGeo.has(raw)){ pendingGeo.get(raw).push(callback); return }
  pendingGeo.set(raw, [callback])
  geoQueue.push({ ip: raw, onResolve: (geo) => {
    const cbs = pendingGeo.get(raw) || []
    pendingGeo.delete(raw)
    for(const fn of cbs){ try { fn(geo) } catch(_){} }
  }})
  processGeoQueue()
}

// Wrapper JSON con fallback: fetch() global si está, si no http.get con
// AbortSignal. Necesario para Node 16/17 (fetch recién desde 18).
function _getJson(url, signal){
  if(HAS_GLOBAL_FETCH){ return fetch(url, { method: 'GET', signal }).then(async r => r.ok ? r.json() : null).catch(() => null) }
  return new Promise((resolve) => {
    let req
    try {
      req = http.get(url, { signal, timeout: GEO_FETCH_TIMEOUT_MS }, (res) => {
        if(res.statusCode !== 200){ res.resume(); return resolve(null) }
        let d = ''
        res.on('data', c => { d += c; if(d.length > 64_000) req.destroy() })
        res.on('end', () => { try { resolve(JSON.parse(d)) } catch { resolve(null) } })
      })
    } catch(e){ return resolve(null) }
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', () => resolve(null))
  })
}

async function processGeoQueue(){
  if(geoProcessing) return
  if(!geoQueue.length) return
  geoProcessing = true
  while(geoQueue.length){
    const elapsed = now() - lastGeoRequest
    if(elapsed < GEO_RATE_MS) await new Promise(r => setTimeout(r, GEO_RATE_MS - elapsed))
    const { ip, onResolve } = geoQueue.shift()
    lastGeoRequest = now()
    const ctrl = new AbortController()
    const to = setTimeout(() => ctrl.abort(), GEO_FETCH_TIMEOUT_MS)
    try {
      const data = await _getJson(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,country,countryCode,regionName,city,lat,lon,isp,query`, ctrl.signal)
      clearTimeout(to)
      if(data && data.status === 'success'){
        const geo = { status: 'ok', country: data.country || '', countryCode: data.countryCode || '', regionName: data.regionName || '', city: data.city || '', lat: data.lat, lon: data.lon, isp: data.isp || '', ts: now() }
        geoCache.set(ip, geo); onResolve(geo)
      } else {
        onResolve(null)
      }
    } catch(e){ clearTimeout(to); console.warn('[bc-presence] geo lookup falló:', e.message); onResolve(null) }
  }
  geoProcessing = false
}

// ============================================================
// PARTY HELPERS
// ============================================================

function makePartyId(){ return 'p' + crypto.randomBytes(6).toString('hex') }

function getPartyForPlayer(idLower){
  const pid = partyByPlayer.get(idLower)
  return pid ? (parties.get(pid) || null) : null
}

function getPresenceForPlayer(idLower){
  const nk = presenceByPlayerId.get(idLower)
  if(nk){
    const v = presence.get(nk)
    if(v && (now() - v.updatedAt) < TTL_MS) return v
    presenceByPlayerId.delete(idLower)
  }
  // Fallback: cubre entries que todavía no tienen índice (arranque, migración).
  for(const [nkFallback, v] of presence){
    if(v.playerId && playerIdL(v.playerId) === idLower && (now() - v.updatedAt) < TTL_MS){
      presenceByPlayerId.set(idLower, nkFallback)
      return v
    }
    if(!v.playerId && v.clientId){
      const u = users.get(v.clientId)
      if(u && u.playerId && playerIdL(u.playerId) === idLower && (now() - v.updatedAt) < TTL_MS){
        presenceByPlayerId.set(idLower, nkFallback)
        return v
      }
    }
  }
  return null
}

function buildPartyView(party, observerLower){
  const members = []
  for(const idLower of party.members){
    const p = players.get(idLower)
    if(!p) continue
    const pres = getPresenceForPlayer(idLower)
    const base = {
      playerId: p.id,
      nickname: p.nickname,
      online: !!pres,
      roomId: pres ? pres.roomId : null,
      roomName: pres ? pres.roomName : null,
      isLeader: idLower === party.leaderId,
    }
    members.push(applyPresencePrivacy(observerLower, idLower, base))
  }
  members.sort((a, b) => {
    if(a.isLeader !== b.isLeader) return b.isLeader ? 1 : -1
    if(a.online !== b.online) return b.online ? 1 : -1
    return (a.nickname || '').localeCompare(b.nickname || '')
  })
  return {
    partyId: party.partyId,
    leaderId: (players.get(party.leaderId) || {}).id || party.leaderId,
    maxSize: party.maxSize,
    createdAt: party.createdAt,
    roomId: party.roomId,
    roomName: party.roomName,
    memberCount: members.length,
    members,
  }
}

function broadcastPartyUpdate(party){
  if(!party) return
  for(const idLower of party.members){
    const clients = sseClients.get(idLower)
    if(!clients || !clients.size) continue
    const view = buildPartyView(party, idLower)
    for(const res of clients) sendSSE(res, 'party_update', view)
  }
}

function broadcastPartyTo(playerIdLower, event, payload){
  const clients = sseClients.get(playerIdLower)
  if(!clients || !clients.size) return
  for(const res of clients) sendSSE(res, event, payload)
}

function disbandParty(partyId, reason = 'disbanded'){
  const party = parties.get(partyId)
  if(!party) return
  for(const idLower of party.members){
    partyByPlayer.delete(idLower)
    broadcastPartyTo(idLower, 'party_disbanded', { partyId, reason })
  }
  parties.delete(partyId)
  partiesDirtyRef.v = true
  scheduleSaveParties()
}

function removeMemberFromParty(party, idLower, reason = 'left'){
  if(!party.members.has(idLower)) return party
  party.members.delete(idLower)
  partyByPlayer.delete(idLower)
  broadcastPartyTo(idLower, 'party_left', { partyId: party.partyId, reason })

  if(party.members.size === 0){
    parties.delete(party.partyId)
    partiesDirtyRef.v = true
    scheduleSaveParties()
    return null
  }
  if(party.leaderId === idLower){
    party.leaderId = party.members.values().next().value
  }
  partiesDirtyRef.v = true
  scheduleSaveParties()
  broadcastPartyUpdate(party)
  return party
}

// ============================================================
// CLEANUP
// ============================================================

function cleanup(){
  const cutoff = now() - TTL_MS
  for(const [key, v] of presence){ if(v.updatedAt < cutoff){ presence.delete(key); _unindexPresence(key) } }
  const vcut = now() - VOICE_TTL_MS
  for(const [roomId, ch] of voiceChannels){
    for(const [nk, p] of ch) if(p.lastSeen < vcut) ch.delete(nk)
    if(!ch.size) voiceChannels.delete(roomId)
  }
  const scut = now() - 30_000
  for(const [nk, arr] of voiceMailbox){
    const fresh = arr.filter(m => m.ts >= scut)
    if(fresh.length) voiceMailbox.set(nk, fresh); else voiceMailbox.delete(nk)
  }
  const ipCutoff = now() - RATE_CLEANUP_MS
  for(const [ip, s] of ipStats) if(s.lastSeen < ipCutoff) ipStats.delete(ip)
  for(const [ip, g] of geoCache) if((now() - g.ts) > GEO_CACHE_TTL) geoCache.delete(ip)
  const matchCutoff = now() - 4 * 60 * 60 * 1000
  for(const [roomId, m] of activeMatches){ if(m.createdAt < matchCutoff) activeMatches.delete(roomId) }

  const ephCut = now() - EPHEMERAL_TTL_MS
  for(const [pidLower, arr] of notificationsEphemeral){
    const fresh = arr.filter(n => n.ts >= ephCut)
    if(fresh.length) notificationsEphemeral.set(pidLower, fresh)
    else notificationsEphemeral.delete(pidLower)
  }

  for(const [pidLower, arr] of notificationsPersistent){
    const fresh = arr.filter(n => (now() - n.ts) < PERSISTENT_TTL_MS)
    if(fresh.length > MAX_PERSISTENT_NOTIFS) fresh.splice(0, fresh.length - MAX_PERSISTENT_NOTIFS)
    if(fresh.length !== arr.length){
      if(fresh.length) notificationsPersistent.set(pidLower, fresh)
      else notificationsPersistent.delete(pidLower)
      notificationsDirtyRef.v = true
    }
  }

  for(const [pidLower, s] of playerIdStats){
    if((now() - s.lastSeen) > RATE_CLEANUP_MS) playerIdStats.delete(pidLower)
  }

  const partyCutoff = now() - PARTY_TTL_MS
  for(const [pid, p] of parties){
    if(p.createdAt < partyCutoff){ disbandParty(pid, 'ttl_expired') }
  }
}
setInterval(cleanup, SWEEP_MS).unref()

// ============================================================
// HTTP HELPERS
// ============================================================

function sendJson(res, status, obj){
  if(res.writableEnded) return
  const body = JSON.stringify(obj)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, x-bc-key, x-admin-key',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  })
  res.end(body)
}
function sendHtml(res, status, html){
  if(res.writableEnded) return
  const body = Buffer.from(html, 'utf8')
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length })
  res.end(body)
}
function readBody(req, maxBytes = 16384){
  return new Promise((resolve, reject) => {
    let data = '', bytes = 0
    req.on('data', chunk => {
      bytes += chunk.length
      if(bytes > maxBytes){ reject(new BodyTooLargeError(maxBytes)); req.destroy(); return }
      data += chunk
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}
function parseJsonBody(raw){
  try { return JSON.parse(raw || '{}') }
  catch(e){ const err = new Error('invalid_json'); err.status = 400; throw err }
}
function checkAuth(req){ if(!API_KEY) return true; return secretoValido(req.headers['x-bc-key'], API_KEY) }
function checkAdminAuth(req){ if(!BETA_ADMIN_KEY) return false; return secretoValido(req.headers['x-admin-key'], BETA_ADMIN_KEY) }
function safeStr(v, max){ if(typeof v !== 'string') return ''; return v.slice(0, max) }
function getClientIp(req){
  if(TRUST_PROXY){
    const cf = req.headers['cf-connecting-ip']; if(cf) return normalizeIp(String(cf))
    const xff = req.headers['x-forwarded-for']; if(xff) return normalizeIp(String(xff).split(',')[0].trim())
  }
  return normalizeIp(req.socket.remoteAddress || 'unknown')
}

// ============================================================
// RATE LIMITS
// ============================================================

function getIpStats(ip){
  const raw = normalizeIp(ip)
  if(!ipStats.has(raw)) ipStats.set(raw, { heartbeats: [], presenceQueries: [], voiceSignals: [], avatarUploads: [], profileUpdates: [], betaChecks: [], adminActions: [], playerChecks: [], matchCalls: [], nicks: new Set(), lastSeen: now() })
  const s = ipStats.get(raw); s.lastSeen = now(); return s
}
function checkRate(ip, bucket, max, windowMs){
  const s = getIpStats(ip)
  const cutoff = now() - windowMs
  if(!s[bucket]) s[bucket] = []
  s[bucket] = s[bucket].filter(t => t >= cutoff)
  if(s[bucket].length >= max) return false
  s[bucket].push(now()); return true
}
function checkNickLimit(ip, nickLower){
  const s = getIpStats(ip)
  if(s.nicks.has(nickLower)) return true
  if(s.nicks.size >= RATE_MAX_NICKS_PER_IP) return false
  s.nicks.add(nickLower); return true
}

function getPlayerIdStats(pidLower){
  if(!playerIdStats.has(pidLower)) playerIdStats.set(pidLower, {
    friendRequests: [], playInvites: [], partyInvites: [], partyCreates: [],
    searches: [], privacyUpdates: [], lastSeen: now(),
  })
  const s = playerIdStats.get(pidLower); s.lastSeen = now(); return s
}
function checkPlayerIdRate(pidLower, bucket, max, windowMs){
  const s = getPlayerIdStats(pidLower)
  const cutoff = now() - windowMs
  if(!s[bucket]) s[bucket] = []
  s[bucket] = s[bucket].filter(t => t >= cutoff)
  if(s[bucket].length >= max) return false
  s[bucket].push(now()); return true
}

// ============================================================
// FRIENDSHIP HELPERS
// ============================================================

function emptyFriendEntry(){
  return { accepted: new Set(), favorites: new Set(), incoming: new Set(), outgoing: new Set() }
}
function getFriendEntry(pidLower){
  if(!friendships.has(pidLower)) friendships.set(pidLower, emptyFriendEntry())
  return friendships.get(pidLower)
}
function getFriendEntryReadOnly(pidLower){
  return friendships.get(pidLower) || emptyFriendEntry()
}
function areFriends(aLower, bLower){
  const e = friendships.get(aLower)
  return !!(e && e.accepted.has(bLower))
}
function createFriendRequest(fromLower, toLower){
  if(fromLower === toLower) return { ok: false, reason: 'self' }
  if(!players.has(fromLower)) return { ok: false, reason: 'from_not_found' }
  if(!players.has(toLower)) return { ok: false, reason: 'to_not_found' }
  if(areFriends(fromLower, toLower)) return { ok: false, reason: 'already_friends' }

  const fromE = getFriendEntry(fromLower)
  const toE = getFriendEntry(toLower)

  if(toE.outgoing.has(fromLower) && fromE.incoming.has(toLower)){
    fromE.incoming.delete(toLower)
    toE.outgoing.delete(fromLower)
    fromE.accepted.add(toLower)
    toE.accepted.add(fromLower)
    scheduleSaveFriendships()
    return { ok: true, status: 'accepted_directly', toLower }
  }

  if(fromE.outgoing.has(toLower)) return { ok: true, status: 'pending', toLower }
  if(toE.incoming.has(fromLower)) return { ok: true, status: 'pending', toLower }

  fromE.outgoing.add(toLower)
  toE.incoming.add(fromLower)
  scheduleSaveFriendships()
  return { ok: true, status: 'pending', toLower }
}
function acceptFriendRequest(pidLower, fromLower){
  const e = getFriendEntry(pidLower)
  const fromE = getFriendEntry(fromLower)
  if(!e.incoming.has(fromLower)){
    if(e.accepted.has(fromLower)) return { ok: true, already: true }
    return { ok: false, reason: 'no_pending' }
  }
  e.incoming.delete(fromLower)
  fromE.outgoing.delete(pidLower)
  e.accepted.add(fromLower)
  fromE.accepted.add(pidLower)
  scheduleSaveFriendships()
  return { ok: true }
}
function declineFriendRequest(pidLower, fromLower){
  const e = getFriendEntry(pidLower)
  const fromE = getFriendEntry(fromLower)
  e.incoming.delete(fromLower)
  fromE.outgoing.delete(pidLower)
  scheduleSaveFriendships()
  return { ok: true }
}
function removeFriendship(pidA, pidB){
  const a = getFriendEntry(pidA)
  const b = getFriendEntry(pidB)
  a.accepted.delete(pidB); a.favorites.delete(pidB)
  b.accepted.delete(pidA); b.favorites.delete(pidA)
  scheduleSaveFriendships()
  return { ok: true }
}

function findPlayerByAnyId(raw){
  if(!raw) return null
  const lower = playerIdL(raw)
  if(players.has(lower)) return players.get(lower)
  for(const [, p] of players){
    if(p.nickname && nickL(p.nickname) === lower) return p
  }
  return null
}

// ============================================================
// NOTIFICATIONS
// ============================================================

function makeNotifId(){ return crypto.randomBytes(8).toString('hex') }

function pushNotification(toPlayerIdLower, notification, { ephemeral = false } = {}){
  if(!toPlayerIdLower) return
  const target = ephemeral ? notificationsEphemeral : notificationsPersistent
  if(!target.has(toPlayerIdLower)) target.set(toPlayerIdLower, [])
  const arr = target.get(toPlayerIdLower)
  arr.push(notification)
  const cap = ephemeral ? MAX_EPHEMERAL_NOTIFS : MAX_PERSISTENT_NOTIFS
  if(arr.length > cap) arr.splice(0, arr.length - cap)
  if(!ephemeral) scheduleSaveNotifications()

  const clients = sseClients.get(toPlayerIdLower)
  if(clients && clients.size){
    for(const res of clients){ sendSSE(res, 'notification', notification) }
  }
}

function markNotificationsRead(pidLower, ids){
  const arr = notificationsPersistent.get(pidLower)
  if(!arr) return 0
  let n = 0
  if(ids === 'all'){ for(const e of arr){ if(!e.read){ e.read = true; n++ } } }
  else if(Array.isArray(ids)){
    const set = new Set(ids)
    for(const e of arr){ if(set.has(e.id) && !e.read){ e.read = true; n++ } }
  }
  if(n) scheduleSaveNotifications()
  return n
}

function getUnreadNotifications(pidLower){
  const persistent = (notificationsPersistent.get(pidLower) || []).filter(n => !n.read)
  const ephemeral = notificationsEphemeral.get(pidLower) || []
  return { persistent, ephemeral, all: [...persistent, ...ephemeral] }
}

// ============================================================
// SSE
// ============================================================

function sendSSE(res, event, data){
  if(!res || res.writableEnded) return
  try {
    res.write(`event: ${event}\n`)
    res.write(`data: ${JSON.stringify(data)}\n\n`)
  } catch(e){ /* ignore */ }
}

function broadcastPresence(toPlayerIdLower, payload){
  const clients = sseClients.get(toPlayerIdLower)
  if(!clients || !clients.size) return
  for(const res of clients) sendSSE(res, 'presence', payload)
}

function notifyFriendsOfOnline(pidLower, { nick, roomId, roomName }){
  const e = friendships.get(pidLower)
  if(!e || !e.accepted.size) return
  const payload = {
    friendPlayerId: players.get(pidLower)?.id || pidLower,
    friendNick: nick || players.get(pidLower)?.nickname || null,
    online: true,
    roomId: roomId || null,
    roomName: roomName || null,
    ts: now(),
  }
  for(const friendLower of e.accepted){
    const friendPrivacy = players.get(friendLower)?.privacy
    if(friendPrivacy && friendPrivacy.notifyFriendOnline === false) continue
    broadcastPresence(friendLower, payload)
  }
}

// ============================================================
// PRIVACY
// ============================================================

function normalizePrivacy(raw){
  const d = { ...DEFAULT_PRIVACY }
  if(!raw || typeof raw !== 'object') return d
  if(VALID_PRIVACY_VALUES.has(raw.friendRequests)) d.friendRequests = raw.friendRequests
  if(VALID_PRIVACY_VALUES.has(raw.onlineStatus))   d.onlineStatus   = raw.onlineStatus
  if(VALID_PRIVACY_VALUES.has(raw.currentRoom))    d.currentRoom    = raw.currentRoom
  if(typeof raw.allowInvites === 'boolean')        d.allowInvites   = raw.allowInvites
  if(typeof raw.notifyFriendOnline === 'boolean')  d.notifyFriendOnline = raw.notifyFriendOnline
  return d
}
function getPrivacy(pidLower){
  const p = players.get(pidLower)
  return (p && p.privacy) || { ...DEFAULT_PRIVACY }
}

function _isFriendOfFriend(observerLower, targetLower){
  if(!observerLower) return false
  if(observerLower === targetLower) return true
  const targetFriends = getFriendEntryReadOnly(targetLower).accepted
  const observerFriends = getFriendEntryReadOnly(observerLower).accepted
  if(!targetFriends.size || !observerFriends.size) return false
  for(const f of targetFriends){ if(observerFriends.has(f)) return true }
  return false
}

function _privacyAllows(viewerLower, targetLower, value){
  if(viewerLower && viewerLower === targetLower) return true
  if(value === 'everyone') return true
  if(value === 'nobody') return false
  const isFriend = viewerLower && areFriends(viewerLower, targetLower)
  if(value === 'friends') return !!isFriend
  if(value === 'friends_of_friends') return !!isFriend || _isFriendOfFriend(viewerLower, targetLower)
  return false
}

function applyPresencePrivacy(observerLower, targetLower, presenceData){
  const priv = getPrivacy(targetLower)
  let online = presenceData.online
  let roomId = presenceData.roomId || null
  let roomName = presenceData.roomName || null

  if(!_privacyAllows(observerLower, targetLower, priv.onlineStatus)) online = false
  if(!_privacyAllows(observerLower, targetLower, priv.currentRoom)){ roomId = null; roomName = null }
  return { ...presenceData, online, roomId, roomName }
}

// ============================================================
// VALIDATORS / USER TOUCH
// ============================================================

function validatePlayerId(raw){
  const s = String(raw || '').trim()
  if(s.length < PLAYER_ID_MIN) return { ok: false, reason: 'too_short' }
  if(s.length > PLAYER_ID_MAX) return { ok: false, reason: 'too_long' }
  if(!PLAYER_ID_RE.test(s)) return { ok: false, reason: 'invalid_chars' }
  const lower = s.toLowerCase()
  if(PLAYER_ID_RESERVED.has(lower)) return { ok: false, reason: 'reserved' }
  return { ok: true, display: s, lower }
}
function validateNickname(raw){
  const s = String(raw || '').trim()
  if(s.length < NICKNAME_MIN) return { ok: false, reason: 'too_short' }
  if(s.length > NICKNAME_MAX) return { ok: false, reason: 'too_long' }
  if(!NICKNAME_RE.test(s)) return { ok: false, reason: 'invalid_chars' }
  return { ok: true, nickname: s }
}
function getPlayerByClientId(clientId){
  const u = users.get(clientId); if(!u || !u.playerId) return null
  return players.get(u.playerId.toLowerCase()) || null
}
function publicPlayerView(p){
  return {
    id: p.id,
    nickname: p.nickname,
    createdAt: p.createdAt,
    nicknameHistory: p.nicknameHistory || [],
    role: normalizeRole(p.role),
  }
}

function touchUser(clientId, { nickname, playerId, key, ip, lat, lon, accuracy }){
  if(!clientId) return
  let u = users.get(clientId)
  const isNew = !u
  if(!u) u = { clientId, nickname: null, playerId: null, playerIdDisplay: null, key: null, ips: [], geo: null, preciseGeo: null, firstSeen: now(), lastSeen: now(), blocked: false, blockReason: null, notes: '' }
  let changed = isNew
  u.lastSeen = now()
  if(nickname && u.nickname !== nickname){ u.nickname = nickname; changed = true }
  if(key && u.key !== key){ u.key = key; changed = true }
  if(playerId && u.playerId !== playerId){ u.playerId = playerId; u.playerIdDisplay = playerId; changed = true }
  if(typeof lat === 'number' && typeof lon === 'number' && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0)){
    const prev = u.preciseGeo
    const moved = !prev || Math.abs(prev.lat - lat) > 0.001 || Math.abs(prev.lon - lon) > 0.001
    if(moved){
      u.preciseGeo = { lat: +lat, lon: +lon, accuracy: typeof accuracy === 'number' ? accuracy : null, updatedAt: now() }
      changed = true
    }
  }
  const cleanIp = normalizeIp(ip)
  if(cleanIp && !u.ips.includes(cleanIp)){
    u.ips.unshift(cleanIp); if(u.ips.length > 20) u.ips.length = 20; changed = true
  }
  if(cleanIp && !isPrivateIp(cleanIp)){
    const cached = getGeoForIp(cleanIp)
    if(cached && !u.geo){ u.geo = cached; changed = true }
    else if(!cached){
      queueGeoLookup(cleanIp, (geo) => {
        if(geo && u.geo !== geo){ u.geo = geo; users.set(clientId, u); scheduleSaveUsers() }
      })
    }
  } else if(cleanIp && isPrivateIp(cleanIp) && !u.geo){
    u.geo = { status: 'private', city: 'Red local', country: 'LAN', lat: null, lon: null, isp: '' }
    changed = true
  }
  users.set(clientId, u)
  if(changed){
    scheduleSaveUsers()
    if(isNew) console.log(`[bc-presence] nuevo user: ${nickname || '?'} (${clientId.slice(0, 8)}…)`)
  }
}
function isBlocked(clientId){ if(!clientId) return false; const u = users.get(clientId); return !!(u && u.blocked) }

function makeClanId(){ clanCounter++; return 'c' + clanCounter.toString(36) + Date.now().toString(36).slice(-4) }

const KEY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
function makeKeyPart(){ const bytes = crypto.randomBytes(4); let s = ''; for(let i = 0; i < 4; i++) s += KEY_ALPHABET[bytes[i] % KEY_ALPHABET.length]; return s }
function makeBetaKey(){ return `BC-${makeKeyPart()}-${makeKeyPart()}-${makeKeyPart()}` }
function makeRecoveryCode(){ return `BC-REC-${makeKeyPart()}-${makeKeyPart()}-${makeKeyPart()}` }

// ============================================================
// SERVER
// ============================================================

const server = http.createServer(async (req, res) => {
  try { await handleRequest(req, res) }
  catch(e){
    // BodyTooLargeError ya fue respondido por el handler con 413, o llega acá
    // si el handler no lo atrapó. En ambos casos, no logueamos como error 500.
    if(e && e.code === 'BODY_TOO_LARGE'){ try { sendJson(res, 413, { error: 'body_too_large' }) } catch(_){}; return }
    console.error('[bc-presence] error:', e && e.stack || e)
    try { sendJson(res, 500, { error: 'internal_error' }) } catch(_){}
  }
})

async function handleRequest(req, res){
  // Fallback a "localhost" si el cliente no manda Host (HTTP/1.0, probes,
  // algunos health checks). Sin esto, new URL() throwea y el request legítimo
  // se cae con un 500 en vez de procesarse.
  const hostHeader = req.headers.host || 'localhost'
  const url = new URL(req.url, `http://${hostHeader}`)
  const ip = getClientIp(req)
  if(req.method === 'OPTIONS'){ sendJson(res, 204, {}); return }

  // ─────────────────────────────────────────────────────────
  // Health
  // ─────────────────────────────────────────────────────────
  if(url.pathname === '/health' && req.method === 'GET'){
    let totalAvatarBytes = 0
    for(const e of userAvatars.values()) totalAvatarBytes += e.bytes
    let usedKeys = 0, blockedUsers = 0, onlineUsers = 0
    for(const e of betaKeys.values()) if(e.usedBy) usedKeys++
    const cutoff = now() - TTL_MS
    for(const e of users.values()){ if(e.blocked) blockedUsers++; if(e.lastSeen > cutoff) onlineUsers++ }
    let notifCount = 0
    for(const arr of notificationsPersistent.values()) notifCount += arr.length
    let ephCount = 0
    for(const arr of notificationsEphemeral.values()) ephCount += arr.length
    sendJson(res, 200, {
      ok: true, online: presence.size, friends: friendships.size, clans: clans.size,
      voiceRooms: voiceChannels.size, ips: ipStats.size,
      avatars: userAvatars.size, avatarsMB: +(totalAvatarBytes / 1024 / 1024).toFixed(2),
      profiles: userProfiles.size, betaKeys: betaKeys.size, betaKeysUsed: usedKeys,
      users: users.size, usersOnline: onlineUsers, usersBlocked: blockedUsers,
      players: players.size, activeMatches: activeMatches.size,
      notificationsPersistent: notifCount, notificationsEphemeral: ephCount,
      sseClients: [...sseClients.values()].reduce((a, s) => a + s.size, 0),
      parties: parties.size,
      dbEnabled: !!db, uptimeSec: Math.round(process.uptime()),
    })
    return
  }

  if(url.pathname === '/debug/files' && req.method === 'GET'){
    if(!checkAdminAuth(req)){ sendJson(res, 401, { error: 'unauthorized' }); return }
    if(!checkRate(ip, 'adminActions', RATE_ADMIN_ACTIONS, RATE_ADMIN_WINDOW_MS)){ sendJson(res, 429, { error: 'rate limited' }); return }
    const out = {}
    for(const [name, p] of Object.entries({ avatars: AVATARS_PATH, profiles: PROFILES_PATH, betaKeys: BETA_KEYS_PATH, users: USERS_PATH, players: PLAYERS_PATH, clans: CLANS_PATH, friends: FRIENDS_PATH, friendsBackup: FRIENDS_BACKUP_PATH, notifications: NOTIFICATIONS_PATH, parties: PARTIES_PATH })){
      try { const st = fs.statSync(p); out[name] = { exists: true, size: st.size, mtime: st.mtime } }
      catch(e){ out[name] = { exists: false } }
    }
    out._dataDir = DATA_DIR
    out._counts = { clans: clans.size, friendships: friendships.size, profiles: userProfiles.size, users: users.size, players: players.size, notifications: notificationsPersistent.size, parties: parties.size }
    out._dirty = { avatars: avatarsDirtyRef.v, profiles: profilesDirtyRef.v, betaKeys: betaKeysDirtyRef.v, users: usersDirtyRef.v, clans: clansDirtyRef.v, friends: friendsDirtyRef.v, players: playersDirtyRef.v, notifications: notificationsDirtyRef.v, parties: partiesDirtyRef.v }
    sendJson(res, 200, out)
    return
  }

  // ─────────────────────────────────────────────────────────
  // Beta keys
  // ─────────────────────────────────────────────────────────
  if(url.pathname === '/beta/check' && req.method === 'POST'){
    if(!checkAuth(req)){ sendJson(res, 401, { error: 'unauthorized' }); return }
    if(!checkRate(ip, 'betaChecks', RATE_BETA_CHECKS, RATE_BETA_WINDOW_MS)){ sendJson(res, 429, { error: 'rate limited' }); return }
    let body; try { body = parseJsonBody(await readBody(req)) } catch(e){ sendJson(res, e.status || 400, { error: 'bad_json' }); return }
    const key = safeStr(body.key, 32).trim().toUpperCase()
    const clientId = safeStr(body.clientId, 64)
    const nickname = safeStr(body.nickname, 25).trim()
    if(!key){ sendJson(res, 400, { ok: false, error: 'missing_key' }); return }
    if(!clientId){ sendJson(res, 400, { ok: false, error: 'missing_client_id' }); return }
    if(isBlocked(clientId)){ const u = users.get(clientId); sendJson(res, 403, { ok: false, error: 'blocked', message: u && u.blockReason ? `Acceso bloqueado: ${u.blockReason}` : 'Tu acceso fue bloqueado.' }); return }
    const entry = betaKeys.get(key)
    if(!entry){ sendJson(res, 404, { ok: false, error: 'invalid_key' }); return }
    if(entry.usedBy && entry.usedBy !== clientId){ sendJson(res, 409, { ok: false, error: 'already_used' }); return }
    if(!entry.usedBy){ entry.usedBy = clientId; entry.usedAt = now(); if(nickname) entry.nickname = nickname; betaKeys.set(key, entry); scheduleSaveBetaKeys() }
    else if(nickname && entry.nickname !== nickname){ entry.nickname = nickname; betaKeys.set(key, entry); scheduleSaveBetaKeys() }
    touchUser(clientId, { nickname, key, ip })
    sendJson(res, 200, { ok: true }); return
  }
  if(url.pathname === '/beta/admin/generate' && req.method === 'POST'){
    if(!BETA_ADMIN_KEY){ sendJson(res, 403, { error: 'admin_disabled' }); return }
    if(!checkAdminAuth(req)){ sendJson(res, 401, { error: 'unauthorized' }); return }
    if(!checkRate(ip, 'adminActions', RATE_ADMIN_ACTIONS, RATE_ADMIN_WINDOW_MS)){ sendJson(res, 429, { error: 'rate limited' }); return }
    let body; try { body = parseJsonBody(await readBody(req)) } catch(e){ sendJson(res, e.status || 400, { error: 'bad_json' }); return }
    const count = Math.min(200, Math.max(1, parseInt(body.count, 10) || 1))
    const notes = safeStr(body.notes, 100)
    const generated = []
    for(let i = 0; i < count; i++){ let key, tries = 0; do { key = makeBetaKey(); tries++ } while(betaKeys.has(key) && tries < 100); if(betaKeys.has(key)) continue; betaKeys.set(key, { createdAt: now(), usedAt: null, usedBy: null, nickname: null, notes }); generated.push(key) }
    scheduleSaveBetaKeys()
    sendJson(res, 200, { ok: true, keys: generated, count: generated.length }); return
  }
  if(url.pathname === '/beta/admin/list' && req.method === 'GET'){
    if(!BETA_ADMIN_KEY){ sendJson(res, 403, { error: 'admin_disabled' }); return }
    if(!checkAdminAuth(req)){ sendJson(res, 401, { error: 'unauthorized' }); return }
    if(!checkRate(ip, 'adminActions', RATE_ADMIN_ACTIONS, RATE_ADMIN_WINDOW_MS)){ sendJson(res, 429, { error: 'rate limited' }); return }
    const onlyUsed = url.searchParams.get('used') === '1', onlyUnused = url.searchParams.get('unused') === '1'
    const list = []
    for(const [key, entry] of betaKeys){ if(onlyUsed && !entry.usedBy) continue; if(onlyUnused && entry.usedBy) continue; list.push({ key, createdAt: entry.createdAt, usedAt: entry.usedAt, usedBy: entry.usedBy, nickname: entry.nickname, notes: entry.notes, used: !!entry.usedBy }) }
    list.sort((a, b) => (b.usedAt || b.createdAt) - (a.usedAt || a.createdAt))
    sendJson(res, 200, { keys: list, total: betaKeys.size, used: [...betaKeys.values()].filter(e => e.usedBy).length }); return
  }
  if(url.pathname === '/beta/admin/revoke' && req.method === 'POST'){
    if(!BETA_ADMIN_KEY){ sendJson(res, 403, { error: 'admin_disabled' }); return }
    if(!checkAdminAuth(req)){ sendJson(res, 401, { error: 'unauthorized' }); return }
    if(!checkRate(ip, 'adminActions', RATE_ADMIN_ACTIONS, RATE_ADMIN_WINDOW_MS)){ sendJson(res, 429, { error: 'rate limited' }); return }
    let body; try { body = parseJsonBody(await readBody(req)) } catch(e){ sendJson(res, e.status || 400, { error: 'bad_json' }); return }
    const key = safeStr(body.key, 32).trim().toUpperCase()
    if(!key){ sendJson(res, 400, { error: 'missing_key' }); return }
    if(!betaKeys.has(key)){ sendJson(res, 404, { error: 'not_found' }); return }
    betaKeys.delete(key); scheduleSaveBetaKeys()
    sendJson(res, 200, { ok: true }); return
  }

  // ─────────────────────────────────────────────────────────
  // Admin users/players
  // ─────────────────────────────────────────────────────────
  if(url.pathname === '/admin/users' && req.method === 'GET'){
    if(!BETA_ADMIN_KEY){ sendJson(res, 403, { error: 'admin_disabled' }); return }
    if(!checkAdminAuth(req)){ sendJson(res, 401, { error: 'unauthorized' }); return }
    if(!checkRate(ip, 'adminActions', RATE_ADMIN_ACTIONS, RATE_ADMIN_WINDOW_MS)){ sendJson(res, 429, { error: 'rate limited' }); return }
    const cutoff = now() - TTL_MS
    const list = []
    for(const u of users.values()){
      const playerIdLower = u.playerId ? u.playerId.toLowerCase() : null
      const p = playerIdLower ? players.get(playerIdLower) : null
      list.push({ clientId: u.clientId, playerId: u.playerId || null, nickname: u.nickname, key: u.key, ips: u.ips, geo: u.geo, preciseGeo: u.preciseGeo || null, firstSeen: u.firstSeen, lastSeen: u.lastSeen, online: u.lastSeen > cutoff, blocked: u.blocked, blockReason: u.blockReason, notes: u.notes, role: p ? normalizeRole(p.role) : null })
    }
    list.sort((a, b) => b.lastSeen - a.lastSeen)
    sendJson(res, 200, { users: list, total: list.length, online: list.filter(u => u.online).length, blocked: list.filter(u => u.blocked).length }); return
  }
  if(url.pathname === '/admin/user/block' && req.method === 'POST'){
    if(!BETA_ADMIN_KEY){ sendJson(res, 403, { error: 'admin_disabled' }); return }
    if(!checkAdminAuth(req)){ sendJson(res, 401, { error: 'unauthorized' }); return }
    if(!checkRate(ip, 'adminActions', RATE_ADMIN_ACTIONS, RATE_ADMIN_WINDOW_MS)){ sendJson(res, 429, { error: 'rate limited' }); return }
    let body; try { body = parseJsonBody(await readBody(req)) } catch(e){ sendJson(res, e.status || 400, { error: 'bad_json' }); return }
    const clientId = safeStr(body.clientId, 64), reason = safeStr(body.reason, 120)
    if(!clientId){ sendJson(res, 400, { error: 'missing_clientId' }); return }
    const u = users.get(clientId); if(!u){ sendJson(res, 404, { error: 'user_not_found' }); return }
    u.blocked = true; u.blockReason = reason || 'Bloqueado por el administrador'
    users.set(clientId, u); scheduleSaveUsers()
    // Cerrar SSE activos + desvincular de cualquier party activa.
    if(u.playerId){
      const pidLower = playerIdL(u.playerId)
      const clients = sseClients.get(pidLower)
      if(clients){ for(const r of clients){ try { r.end() } catch(_){} } sseClients.delete(pidLower) }
      const party = getPartyForPlayer(pidLower)
      if(party){ removeMemberFromParty(party, pidLower, 'blocked') }
    }
    sendJson(res, 200, { ok: true }); return
  }
  if(url.pathname === '/admin/user/unblock' && req.method === 'POST'){
    if(!BETA_ADMIN_KEY){ sendJson(res, 403, { error: 'admin_disabled' }); return }
    if(!checkAdminAuth(req)){ sendJson(res, 401, { error: 'unauthorized' }); return }
    if(!checkRate(ip, 'adminActions', RATE_ADMIN_ACTIONS, RATE_ADMIN_WINDOW_MS)){ sendJson(res, 429, { error: 'rate limited' }); return }
    let body; try { body = parseJsonBody(await readBody(req)) } catch(e){ sendJson(res, e.status || 400, { error: 'bad_json' }); return }
    const clientId = safeStr(body.clientId, 64)
    if(!clientId){ sendJson(res, 400, { error: 'missing_clientId' }); return }
    const u = users.get(clientId); if(!u){ sendJson(res, 404, { error: 'user_not_found' }); return }
    u.blocked = false; u.blockReason = null
    users.set(clientId, u); scheduleSaveUsers()
    sendJson(res, 200, { ok: true }); return
  }
  if(url.pathname === '/admin/user/notes' && req.method === 'POST'){
    if(!BETA_ADMIN_KEY){ sendJson(res, 403, { error: 'admin_disabled' }); return }
    if(!checkAdminAuth(req)){ sendJson(res, 401, { error: 'unauthorized' }); return }
    if(!checkRate(ip, 'adminActions', RATE_ADMIN_ACTIONS, RATE_ADMIN_WINDOW_MS)){ sendJson(res, 429, { error: 'rate limited' }); return }
    let body; try { body = parseJsonBody(await readBody(req)) } catch(e){ sendJson(res, e.status || 400, { error: 'bad_json' }); return }
    const clientId = safeStr(body.clientId, 64), notes = safeStr(body.notes, 200)
    if(!clientId){ sendJson(res, 400, { error: 'missing_clientId' }); return }
    const u = users.get(clientId); if(!u){ sendJson(res, 404, { error: 'user_not_found' }); return }
    u.notes = notes; users.set(clientId, u); scheduleSaveUsers()
    sendJson(res, 200, { ok: true }); return
  }
  if(url.pathname === '/admin/player/set-role' && req.method === 'POST'){
    if(!BETA_ADMIN_KEY){ sendJson(res, 403, { error: 'admin_disabled' }); return }
    if(!checkAdminAuth(req)){ sendJson(res, 401, { error: 'unauthorized' }); return }
    if(!checkRate(ip, 'adminActions', RATE_ADMIN_ACTIONS, RATE_ADMIN_WINDOW_MS)){ sendJson(res, 429, { error: 'rate limited' }); return }
    let body; try { body = parseJsonBody(await readBody(req)) } catch(e){ sendJson(res, e.status || 400, { error: 'bad_json' }); return }
    const targetPidRaw = safeStr(body.playerId, 32)
    const newRoleRaw   = safeStr(body.role, 32)
    if(!targetPidRaw){ sendJson(res, 400, { error: 'missing_playerId' }); return }
    if(!ALLOWED_ROLES.includes(newRoleRaw.toLowerCase())){ sendJson(res, 400, { error: 'invalid_role', allowed: ALLOWED_ROLES }); return }
    const target = findPlayerByAnyId(targetPidRaw)
    if(!target){ sendJson(res, 404, { error: 'player_not_found' }); return }
    const oldRole = normalizeRole(target.role)
    const newRole = newRoleRaw.toLowerCase()
    if(oldRole === newRole){ sendJson(res, 200, { ok: true, unchanged: true, role: newRole }); return }
    target.role = newRole
    players.set(target.idLower, target)
    scheduleSavePlayers()
    console.log(`[bc-presence] rol de ${target.id} cambiado: ${oldRole} → ${newRole}`)
    sendJson(res, 200, { ok: true, playerId: target.id, role: newRole, previous: oldRole })
    return
  }
  if(url.pathname === '/admin/user/delete' && req.method === 'POST'){
    if(!BETA_ADMIN_KEY){ sendJson(res, 403, { error: 'admin_disabled' }); return }
    if(!checkAdminAuth(req)){ sendJson(res, 401, { error: 'unauthorized' }); return }
    if(!checkRate(ip, 'adminActions', RATE_ADMIN_ACTIONS, RATE_ADMIN_WINDOW_MS)){ sendJson(res, 429, { error: 'rate limited' }); return }
    let body; try { body = parseJsonBody(await readBody(req)) } catch(e){ sendJson(res, e.status || 400, { error: 'bad_json' }); return }
    const clientId = safeStr(body.clientId, 64)
    if(!clientId){ sendJson(res, 400, { error: 'missing_clientId' }); return }
    const u = users.get(clientId); if(!u){ sendJson(res, 404, { error: 'user_not_found' }); return }
    if(u.playerId){
      const pidLower = playerIdL(u.playerId)
      const clients = sseClients.get(pidLower)
      if(clients){ for(const r of clients){ try { r.end() } catch(_){} } sseClients.delete(pidLower) }
      const party = getPartyForPlayer(pidLower)
      if(party){ removeMemberFromParty(party, pidLower, 'deleted') }
    }
    users.delete(clientId); scheduleSaveUsers()
    sendJson(res, 200, { ok: true }); return
  }
  if(url.pathname === '/admin/players' && req.method === 'GET'){
    if(!BETA_ADMIN_KEY){ sendJson(res, 403, { error: 'admin_disabled' }); return }
    if(!checkAdminAuth(req)){ sendJson(res, 401, { error: 'unauthorized' }); return }
    if(!checkRate(ip, 'adminActions', RATE_ADMIN_ACTIONS, RATE_ADMIN_WINDOW_MS)){ sendJson(res, 429, { error: 'rate limited' }); return }
    const list = []
    for(const [idLower, p] of players){
      const owner = p.createdByClientId ? users.get(p.createdByClientId) : null
      list.push({ id: p.id, nickname: p.nickname, recoveryCode: p.recoveryCode, createdByClientId: p.createdByClientId, discordId: p.discordId || null, createdAt: p.createdAt, ownerNickname: owner ? owner.nickname : null, ownerBlocked: owner ? !!owner.blocked : false, nicknameHistory: p.nicknameHistory || [], privacy: p.privacy, role: normalizeRole(p.role) })
    }
    list.sort((a, b) => b.createdAt - a.createdAt)
    sendJson(res, 200, { players: list, total: list.length }); return
  }
  if(url.pathname === '/admin' && req.method === 'GET'){
    // El panel se sirve solo si el admin key viene en el querystring o en el
    // header. El front sigue pidiendo la key igual para llamar a /admin/*,
    // pero al menos no exponemos la estructura del panel a cualquiera que
    // pegue al puerto.
    const adminKey = safeStr(url.searchParams.get('k') || req.headers['x-admin-key'] || '', 128)
    if(!BETA_ADMIN_KEY || !secretoValido(adminKey, BETA_ADMIN_KEY)){
      sendHtml(res, 401, '<h2>401 — Falta o es inválida la admin key. Pasala como ?k=TU_KEY o header x-admin-key.</h2>')
      return
    }
    try {
      const st = fs.statSync(ADMIN_HTML_PATH)
      if(!_adminHtmlCache || _adminHtmlCache.mtime !== st.mtimeMs){
        _adminHtmlCache = { body: fs.readFileSync(ADMIN_HTML_PATH, 'utf8'), mtime: st.mtimeMs }
      }
      sendHtml(res, 200, _adminHtmlCache.body)
    } catch(e){ sendHtml(res, 500, `<h2>admin.html no encontrado</h2><p>${e.message}</p>`) }
    return
  }

  // ─────────────────────────────────────────────────────────
  // Heartbeat / leave
  // ─────────────────────────────────────────────────────────
  if(url.pathname === '/heartbeat' && req.method === 'POST'){
    if(!checkAuth(req)){ sendJson(res, 401, { error: 'unauthorized' }); return }
    if(!checkRate(ip, 'heartbeats', RATE_HEARTBEAT_MAX, RATE_HEARTBEAT_WINDOW_MS)){ sendJson(res, 429, { error: 'rate limited' }); return }
    let payload; try { payload = parseJsonBody(await readBody(req)) } catch(e){ sendJson(res, e.status || 400, { error: 'bad_json' }); return }
    const nick = safeStr(payload.nick, 25).trim()
    if(!nick){ sendJson(res, 400, { error: 'missing nick' }); return }
    if(!checkNickLimit(ip, nick.toLowerCase())){ sendJson(res, 429, { error: 'too many nicks' }); return }
    const clientId = safeStr(payload.clientId, 64)
    const betaKey = safeStr(payload.betaKey, 32).trim().toUpperCase()
    const roomId = safeStr(payload.roomId, 128)
    const roomName = safeStr(payload.roomName, 80)
    let playerIdRaw = safeStr(payload.playerId, 32) || null
    const haxballPlayerId = typeof payload.haxballPlayerId === 'number' ? payload.haxballPlayerId : null
    if(isBlocked(clientId)){ const u = users.get(clientId); sendJson(res, 403, { ok: false, error: 'blocked', message: u && u.blockReason ? u.blockReason : 'Acceso bloqueado.' }); return }

    // Anti-impersonación: playerId debe pertenecer al clientId.
    if(playerIdRaw){
      const owner = users.get(clientId)
      const expected = owner && owner.playerId ? playerIdL(owner.playerId) : null
      const claimed = playerIdL(playerIdRaw)
      if(expected && expected !== claimed){
        console.warn(`[bc-presence] heartbeat spoof bloqueado: clientId=${clientId.slice(0,8)}… claimed=${playerIdRaw} ownedBy=${expected}`)
        sendJson(res, 403, { ok: false, error: 'player_id_mismatch' }); return
      }
      if(!expected){
        const p = players.get(claimed)
        if(!p){ sendJson(res, 403, { ok: false, error: 'unknown_player_id' }); return }
      }
    }

    const nkLower = nickL(nick)
    const prev = presence.get(nkLower)
    const prevWasOnline = !!(prev && (now() - prev.updatedAt) < TTL_MS)
    const prevRoomId = prev ? prev.roomId : null

    presence.set(nkLower, { nick, roomId: roomId || null, roomName: roomName || null, clientId, playerId: playerIdRaw, haxballPlayerId, ip, updatedAt: now() })
    _indexPresence(nkLower, { playerId: playerIdRaw })
    touchUser(clientId, { nickname: nick, playerId: playerIdRaw, key: betaKey, ip, lat: typeof payload.lat === 'number' ? payload.lat : null, lon: typeof payload.lon === 'number' ? payload.lon : null, accuracy: typeof payload.accuracy === 'number' ? payload.accuracy : null })

    let pidLower = null
    if(playerIdRaw) pidLower = playerIdL(playerIdRaw)
    if(!pidLower && clientId){
      const u = users.get(clientId)
      if(u && u.playerId) pidLower = playerIdL(u.playerId)
    }

    if(pidLower){
      if(!prevWasOnline){
        notifyFriendsOfOnline(pidLower, { nick, roomId: roomId || null, roomName: roomName || null })
      }
      if(prevWasOnline && prevRoomId !== (roomId || null)){
        const e = friendships.get(pidLower)
        if(e && e.accepted.size){
          const payloadOut = {
            friendPlayerId: players.get(pidLower)?.id || pidLower,
            friendNick: nick,
            online: true,
            roomId: roomId || null,
            roomName: roomName || null,
            ts: now(),
          }
          for(const friendLower of e.accepted){
            const fp = players.get(friendLower)?.privacy
            if(fp && fp.notifyFriendOnline === false) continue
            broadcastPresence(friendLower, payloadOut)
          }
        }
      }

      const myPartyId = partyByPlayer.get(pidLower)
      if(myPartyId){
        const myParty = parties.get(myPartyId)
        if(myParty){
          const newRoomId = roomId || null
          const newRoomName = roomName || null
          const isLeader = myParty.leaderId === pidLower
          if(isLeader && myParty.roomId !== newRoomId){
            myParty.roomId = newRoomId
            myParty.roomName = newRoomName
            partiesDirtyRef.v = true
            scheduleSaveParties()
            const partyPayload = {
              partyId: myParty.partyId,
              leaderId: players.get(pidLower)?.id || pidLower,
              leaderNick: nick,
              roomId: newRoomId,
              roomName: newRoomName,
              ts: now(),
            }
            for(const memberLower of myParty.members){
              if(memberLower === pidLower) continue
              broadcastPartyTo(memberLower, 'party_leader_room_change', partyPayload)
            }
          }
          broadcastPartyUpdate(myParty)
        }
      }
    }

    sendJson(res, 200, { ok: true }); return
  }
  if(url.pathname === '/leave' && req.method === 'POST'){
    if(!checkAuth(req)){ sendJson(res, 401, { error: 'unauthorized' }); return }
    let payload; try { payload = parseJsonBody(await readBody(req)) } catch(e){ payload = {} }
    const nk = nickL(payload.nick)
    if(nk){
      presence.delete(nk)
      _unindexPresence(nk)
      const s = ipStats.get(normalizeIp(ip))
      if(s) s.nicks.delete(nk)
    }
    sendJson(res, 200, { ok: true }); return
  }

  // ─────────────────────────────────────────────────────────
  // Presence
  // ─────────────────────────────────────────────────────────
  if(url.pathname === '/presence' && req.method === 'GET'){
    if(!checkAuth(req)){ sendJson(res, 401, { error: 'unauthorized' }); return }
    if(!checkRate(ip, 'presenceQueries', RATE_MAX_PRESENCE_QUERIES, 1000)){ sendJson(res, 429, { error: 'rate limited' }); return }
    const observerPidRaw = safeStr(url.searchParams.get('as') || '', 32)
    const observerLower = observerPidRaw ? playerIdL(observerPidRaw) : null
    const nicks = (url.searchParams.get('nicks') || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, MAX_NICKS_PER_QUERY)
    cleanup()
    const results = nicks.map(nick => {
      const e = presence.get(nickL(nick))
      if(!e) return { nick, online: false, playerId: null }
      let playerId = e.playerId || null
      if(!playerId && e.clientId){ const u = users.get(e.clientId); if(u && u.playerId) playerId = u.playerId }
      const base = { nick: e.nick, playerId, online: true, roomId: e.roomId, roomName: e.roomName, secondsAgo: Math.round((now() - e.updatedAt) / 1000) }
      if(playerId){ return applyPresencePrivacy(observerLower, playerIdL(playerId), base) }
      return base
    })
    sendJson(res, 200, { results }); return
  }

  // ─────────────────────────────────────────────────────────
  // Friends
  // ─────────────────────────────────────────────────────────
  if(url.pathname === '/friends/request' && req.method === 'POST'){
    if(!checkAuth(req)){ sendJson(res, 401, { error: 'unauthorized' }); return }
    let body; try { body = parseJsonBody(await readBody(req)) } catch(e){ sendJson(res, e.status || 400, { error: 'bad_json' }); return }
    const fromRaw = safeStr(body.fromPlayerId || body.nick, 32)
    const toRaw   = safeStr(body.toPlayerId || body.friendNick, 32)
    const fromP = findPlayerByAnyId(fromRaw)
    const toP   = findPlayerByAnyId(toRaw)
    if(!fromP || !toP){ sendJson(res, 404, { error: 'player_not_found' }); return }
    if(!checkPlayerIdRate(fromP.idLower, 'friendRequests', RATE_FRIEND_REQUESTS, RATE_FRIEND_REQUESTS_WINDOW_MS)){ sendJson(res, 429, { error: 'rate limited' }); return }
    const toPriv = getPrivacy(toP.idLower)
    if(toPriv.friendRequests === 'nobody'){ sendJson(res, 403, { error: 'requests_disabled' }); return }
    if(toPriv.friendRequests === 'friends_of_friends'){
      const toFriends = getFriendEntryReadOnly(toP.idLower).accepted
      const fromFriends = getFriendEntryReadOnly(fromP.idLower).accepted
      let ok = false
      for(const f of toFriends){ if(fromFriends.has(f)){ ok = true; break } }
      if(!ok){ sendJson(res, 403, { error: 'friends_of_friends_only' }); return }
    }
    const r = createFriendRequest(fromP.idLower, toP.idLower)
    if(!r.ok){ sendJson(res, 400, { error: r.reason }); return }

    if(r.status === 'pending'){
      const notif = { id: makeNotifId(), type: 'friend_request', fromPlayerId: fromP.id, fromNick: fromP.nickname, ts: now(), read: false, payload: {} }
      pushNotification(toP.idLower, notif, { ephemeral: false })
    } else if(r.status === 'accepted_directly'){
      const notif = { id: makeNotifId(), type: 'friend_accepted', fromPlayerId: toP.id, fromNick: toP.nickname, ts: now(), read: false, payload: {} }
      pushNotification(fromP.idLower, notif, { ephemeral: false })
    }
    sendJson(res, 200, { ok: true, status: r.status }); return
  }

  if(url.pathname === '/friends/add' && req.method === 'POST'){
    if(!checkAuth(req)){ sendJson(res, 401, { error: 'unauthorized' }); return }
    let body; try { body = parseJsonBody(await readBody(req)) } catch(e){ sendJson(res, e.status || 400, { error: 'bad_json' }); return }
    const fromRaw = safeStr(body.fromPlayerId || body.nick, 32)
    const toRaw   = safeStr(body.toPlayerId || body.friendNick, 32)
    const fromP = findPlayerByAnyId(fromRaw)
    const toP   = findPlayerByAnyId(toRaw)
    if(!fromP || !toP){ sendJson(res, 404, { error: 'player_not_found' }); return }
    if(!checkPlayerIdRate(fromP.idLower, 'friendRequests', RATE_FRIEND_REQUESTS, RATE_FRIEND_REQUESTS_WINDOW_MS)){ sendJson(res, 429, { error: 'rate limited' }); return }
    const r = createFriendRequest(fromP.idLower, toP.idLower)
    if(!r.ok){ sendJson(res, 400, { error: r.reason }); return }
    if(r.status === 'pending'){
      const notif = { id: makeNotifId(), type: 'friend_request', fromPlayerId: fromP.id, fromNick: fromP.nickname, ts: now(), read: false, payload: {} }
      pushNotification(toP.idLower, notif, { ephemeral: false })
    } else if(r.status === 'accepted_directly'){
      const notif = { id: makeNotifId(), type: 'friend_accepted', fromPlayerId: toP.id, fromNick: toP.nickname, ts: now(), read: false, payload: {} }
      pushNotification(fromP.idLower, notif, { ephemeral: false })
    }
    sendJson(res, 200, { ok: true, status: r.status }); return
  }

  if(url.pathname === '/friends/accept' && req.method === 'POST'){
    if(!checkAuth(req)){ sendJson(res, 401, { error: 'unauthorized' }); return }
    let body; try { body = parseJsonBody(await readBody(req)) } catch(e){ sendJson(res, e.status || 400, { error: 'bad_json' }); return }
    const meRaw = safeStr(body.playerId || body.nick, 32)
    const fromRaw = safeStr(body.fromPlayerId || body.friendNick, 32)
    const me = findPlayerByAnyId(meRaw)
    const from = findPlayerByAnyId(fromRaw)
    if(!me || !from){ sendJson(res, 404, { error: 'player_not_found' }); return }
    const r = acceptFriendRequest(me.idLower, from.idLower)
    if(!r.ok){ sendJson(res, 400, { error: r.reason }); return }

    const notif = { id: makeNotifId(), type: 'friend_accepted', fromPlayerId: me.id, fromNick: me.nickname, ts: now(), read: false, payload: {} }
    pushNotification(from.idLower, notif, { ephemeral: false })

    const arr = notificationsPersistent.get(me.idLower)
    if(arr){
      for(const e of arr){ if(e.type === 'friend_request' && playerIdL(e.fromPlayerId) === from.idLower) e.read = true }
      scheduleSaveNotifications()
    }
    sendJson(res, 200, { ok: true }); return
  }

  if(url.pathname === '/friends/decline' && req.method === 'POST'){
    if(!checkAuth(req)){ sendJson(res, 401, { error: 'unauthorized' }); return }
    let body; try { body = parseJsonBody(await readBody(req)) } catch(e){ sendJson(res, e.status || 400, { error: 'bad_json' }); return }
    const meRaw = safeStr(body.playerId || body.nick, 32)
    const fromRaw = safeStr(body.fromPlayerId || body.friendNick, 32)
    const me = findPlayerByAnyId(meRaw)
    const from = findPlayerByAnyId(fromRaw)
    if(!me || !from){ sendJson(res, 404, { error: 'player_not_found' }); return }
    declineFriendRequest(me.idLower, from.idLower)

    const arr = notificationsPersistent.get(me.idLower)
    if(arr){
      for(const e of arr){ if(e.type === 'friend_request' && playerIdL(e.fromPlayerId) === from.idLower) e.read = true }
      scheduleSaveNotifications()
    }
    sendJson(res, 200, { ok: true }); return
  }

  if(url.pathname === '/friends/remove' && req.method === 'POST'){
    if(!checkAuth(req)){ sendJson(res, 401, { error: 'unauthorized' }); return }
    let body; try { body = parseJsonBody(await readBody(req)) } catch(e){ sendJson(res, e.status || 400, { error: 'bad_json' }); return }
    const me = findPlayerByAnyId(safeStr(body.playerId || body.nick, 32))
    const other = findPlayerByAnyId(safeStr(body.friendPlayerId || body.friendNick, 32))
    if(!me || !other){ sendJson(res, 404, { error: 'player_not_found' }); return }
    removeFriendship(me.idLower, other.idLower)
    sendJson(res, 200, { ok: true }); return
  }

  if(url.pathname === '/friends/favorite' && req.method === 'POST'){
    if(!checkAuth(req)){ sendJson(res, 401, { error: 'unauthorized' }); return }
    let body; try { body = parseJsonBody(await readBody(req)) } catch(e){ sendJson(res, e.status || 400, { error: 'bad_json' }); return }
    const me = findPlayerByAnyId(safeStr(body.playerId, 32))
    const friend = findPlayerByAnyId(safeStr(body.friendPlayerId, 32))
    if(!me || !friend){ sendJson(res, 404, { error: 'player_not_found' }); return }
    const e = getFriendEntry(me.idLower)
    if(!e.accepted.has(friend.idLower)){ sendJson(res, 400, { error: 'not_friends' }); return }
    if(body.favorite) e.favorites.add(friend.idLower)
    else e.favorites.delete(friend.idLower)
    scheduleSaveFriendships()
    sendJson(res, 200, { ok: true, favorite: e.favorites.has(friend.idLower) }); return
  }

  if(url.pathname === '/friends/list' && req.method === 'GET'){
    if(!checkAuth(req)){ sendJson(res, 401, { error: 'unauthorized' }); return }
    if(!checkRate(ip, 'presenceQueries', RATE_MAX_PRESENCE_QUERIES, 1000)){ sendJson(res, 429, { error: 'rate limited' }); return }
    const raw = url.searchParams.get('playerId') || url.searchParams.get('nick') || ''
    const me = findPlayerByAnyId(raw)
    if(!me){ sendJson(res, 404, { error: 'player_not_found' }); return }
    cleanup()
    const e = getFriendEntryReadOnly(me.idLower)

    function resolveList(ids){
      const out = []
      for(const idLower of ids){
        const p = players.get(idLower)
        if(!p) continue
        const pres = getPresenceForPlayer(idLower)
        const online = !!(pres)
        const base = {
          playerId: p.id,
          nickname: p.nickname,
          online,
          roomId: pres ? pres.roomId : null,
          roomName: pres ? pres.roomName : null,
          secondsAgo: pres ? Math.round((now() - pres.updatedAt) / 1000) : null,
        }
        out.push(applyPresencePrivacy(me.idLower, idLower, base))
      }
      return out
    }

    const friendsList = resolveList(e.accepted)
    const favoritesList = friendsList.filter(f => e.favorites.has(playerIdL(f.playerId)))
    const incomingList = resolveList(e.incoming)
    const outgoingList = resolveList(e.outgoing)

    friendsList.sort((a, b) => (b.online - a.online) || (a.nickname || '').localeCompare(b.nickname || ''))

    sendJson(res, 200, {
      me: { playerId: me.id, nickname: me.nickname },
      friends: friendsList,
      favorites: favoritesList,
      incoming: incomingList,
      outgoing: outgoingList,
    }); return
  }

  // ─────────────────────────────────────────────────────────
  // SSE /events
  // ─────────────────────────────────────────────────────────
  if(url.pathname === '/events' && req.method === 'GET'){
    if(!checkAuth(req)){ sendJson(res, 401, { error: 'unauthorized' }); return }
    const raw = url.searchParams.get('playerId') || url.searchParams.get('nick') || ''
    const me = findPlayerByAnyId(raw)
    if(!me){ sendJson(res, 404, { error: 'player_not_found' }); return }

    let clients = sseClients.get(me.idLower)
    if(!clients) clients = new Set()
    if(clients.size >= MAX_SSE_CONNECTIONS_PER_PLAYER){
      const oldest = clients.values().next().value
      try { oldest.end() } catch(_){}
      clients.delete(oldest)
    }
    clients.add(res)
    sseClients.set(me.idLower, clients)

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*',
    })

    const unread = getUnreadNotifications(me.idLower)
    sendSSE(res, 'hello', { playerId: me.id, nickname: me.nickname, notifications: unread.all, ts: now() })

    const ka = setInterval(() => { try { res.write(':keepalive\n\n') } catch(_){} }, SSE_KEEPALIVE_MS)

    const onClose = () => {
      clearInterval(ka)
      const set = sseClients.get(me.idLower)
      if(set){ set.delete(res); if(!set.size) sseClients.delete(me.idLower) }
    }
    req.on('close', onClose)
    req.on('error', onClose)
    return
  }

  // ─────────────────────────────────────────────────────────
  // Notifications
  // ─────────────────────────────────────────────────────────
  if(url.pathname === '/notifications' && req.method === 'GET'){
    if(!checkAuth(req)){ sendJson(res, 401, { error: 'unauthorized' }); return }
    const me = findPlayerByAnyId(safeStr(url.searchParams.get('playerId') || url.searchParams.get('nick') || '', 32))
    if(!me){ sendJson(res, 404, { error: 'player_not_found' }); return }
    const all = url.searchParams.get('all') === '1'
    const unread = getUnreadNotifications(me.idLower)
    sendJson(res, 200, {
      notifications: all ? [...unread.persistent, ...unread.ephemeral] : unread.all,
      unreadPersistent: unread.persistent.length,
      ephemeral: unread.ephemeral.length,
    }); return
  }
  if(url.pathname === '/notifications/read' && req.method === 'POST'){
    if(!checkAuth(req)){ sendJson(res, 401, { error: 'unauthorized' }); return }
    let body; try { body = parseJsonBody(await readBody(req)) } catch(e){ sendJson(res, e.status || 400, { error: 'bad_json' }); return }
    const me = findPlayerByAnyId(safeStr(body.playerId || body.nick, 32))
    if(!me){ sendJson(res, 404, { error: 'player_not_found' }); return }
    const ids = body.all === true ? 'all' : (Array.isArray(body.ids) ? body.ids.map(String) : [])
    const n = markNotificationsRead(me.idLower, ids)
    sendJson(res, 200, { ok: true, marked: n }); return
  }

  // ─────────────────────────────────────────────────────────
  // Invitaciones
  // ─────────────────────────────────────────────────────────
  if(url.pathname === '/invite/play' && req.method === 'POST'){
    if(!checkAuth(req)){ sendJson(res, 401, { error: 'unauthorized' }); return }
    let body; try { body = parseJsonBody(await readBody(req)) } catch(e){ sendJson(res, e.status || 400, { error: 'bad_json' }); return }
    const fromP = findPlayerByAnyId(safeStr(body.fromPlayerId || body.from, 32))
    const toP   = findPlayerByAnyId(safeStr(body.toPlayerId || body.to, 32))
    if(!fromP || !toP){ sendJson(res, 404, { error: 'player_not_found' }); return }
    if(fromP.idLower === toP.idLower){ sendJson(res, 400, { error: 'self' }); return }
    if(!areFriends(fromP.idLower, toP.idLower)){ sendJson(res, 403, { error: 'not_friends' }); return }
    const toPriv = getPrivacy(toP.idLower)
    if(!toPriv.allowInvites){ sendJson(res, 403, { error: 'invites_disabled' }); return }
    if(!checkPlayerIdRate(fromP.idLower, 'playInvites', RATE_PLAY_INVITES, RATE_PLAY_INVITES_WINDOW_MS)){ sendJson(res, 429, { error: 'rate limited' }); return }
    const roomId = safeStr(body.roomId, 128)
    const roomName = safeStr(body.roomName, 80)
    const mode = safeStr(body.mode, 32) || 'Classic'
    const playersInRoom = typeof body.players === 'number' ? body.players : null
    const maxPlayers = typeof body.maxPlayers === 'number' ? body.maxPlayers : null
    if(!roomId){ sendJson(res, 400, { error: 'missing_roomId' }); return }

    const notif = { id: makeNotifId(), type: 'invite_to_play', fromPlayerId: fromP.id, fromNick: fromP.nickname, ts: now(), payload: { roomId, roomName, mode, players: playersInRoom, maxPlayers } }
    pushNotification(toP.idLower, notif, { ephemeral: true })
    sendJson(res, 200, { ok: true }); return
  }

  // ─────────────────────────────────────────────────────────
  // Privacy
  // ─────────────────────────────────────────────────────────
  if(url.pathname === '/privacy' && req.method === 'GET'){
    if(!checkAuth(req)){ sendJson(res, 401, { error: 'unauthorized' }); return }
    const me = findPlayerByAnyId(safeStr(url.searchParams.get('playerId') || url.searchParams.get('nick') || '', 32))
    if(!me){ sendJson(res, 404, { error: 'player_not_found' }); return }
    sendJson(res, 200, { privacy: getPrivacy(me.idLower) }); return
  }
  if(url.pathname === '/privacy' && req.method === 'POST'){
    if(!checkAuth(req)){ sendJson(res, 401, { error: 'unauthorized' }); return }
    let body; try { body = parseJsonBody(await readBody(req)) } catch(e){ sendJson(res, e.status || 400, { error: 'bad_json' }); return }
    const me = findPlayerByAnyId(safeStr(body.playerId || body.nick, 32))
    if(!me){ sendJson(res, 404, { error: 'player_not_found' }); return }
    if(!checkPlayerIdRate(me.idLower, 'privacyUpdates', RATE_PRIVACY_UPDATES, RATE_PRIVACY_UPDATES_WINDOW_MS)){ sendJson(res, 429, { error: 'rate limited' }); return }
    const current = me.privacy || { ...DEFAULT_PRIVACY }
    const next = normalizePrivacy({ ...current, ...body })
    me.privacy = next
    players.set(me.idLower, me)
    scheduleSavePlayers()
    sendJson(res, 200, { ok: true, privacy: next }); return
  }

  // ─────────────────────────────────────────────────────────
  // Clans
  // ─────────────────────────────────────────────────────────
  if(url.pathname === '/clans/create' && req.method === 'POST'){
    if(!checkAuth(req)){ sendJson(res, 401, { error: 'unauthorized' }); return }
    let body; try { body = parseJsonBody(await readBody(req)) } catch(e){ sendJson(res, e.status || 400, { error: 'bad_json' }); return }
    const nk = nickL(body.nick), name = safeStr(body.name, 32).trim(), tag = safeStr(body.tag, 5).trim().toUpperCase()
    if(!nk || !name){ sendJson(res, 400, { error: 'faltan datos' }); return }
    for(const [, c] of clans){ if(c.members.has(nk)){ sendJson(res, 409, { error: 'already_in_clan' }); return } }
    const id = makeClanId()
    clans.set(id, { id, name, tag: tag || name.slice(0,3).toUpperCase(), owner: nk, members: new Set([nk]), createdAt: now() })
    scheduleSaveClans()
    sendJson(res, 200, { ok: true, clan: { id, name, tag, owner: nk, members: [nk] } }); return
  }
  if(url.pathname === '/clans/join' && req.method === 'POST'){
    if(!checkAuth(req)){ sendJson(res, 401, { error: 'unauthorized' }); return }
    let body; try { body = parseJsonBody(await readBody(req)) } catch(e){ sendJson(res, e.status || 400, { error: 'bad_json' }); return }
    const nk = nickL(body.nick), clanId = safeStr(body.clanId, 32)
    if(!nk || !clanId){ sendJson(res, 400, { error: 'faltan datos' }); return }
    const clan = clans.get(clanId); if(!clan){ sendJson(res, 404, { error: 'not_found' }); return }
    for(const [cid, c] of clans){ if(c.members.has(nk) && cid !== clanId){ sendJson(res, 409, { error: 'in_another' }); return } }
    clan.members.add(nk); clans.set(clanId, clan); scheduleSaveClans()
    sendJson(res, 200, { ok: true }); return
  }
  if(url.pathname === '/clans/leave' && req.method === 'POST'){
    if(!checkAuth(req)){ sendJson(res, 401, { error: 'unauthorized' }); return }
    let body; try { body = parseJsonBody(await readBody(req)) } catch(e){ sendJson(res, e.status || 400, { error: 'bad_json' }); return }
    const nk = nickL(body.nick)
    if(!nk){ sendJson(res, 400, { error: 'missing nick' }); return }
    for(const [cid, c] of clans){ if(c.members.has(nk)){ c.members.delete(nk); if(!c.members.size) clans.delete(cid); else if(c.owner === nk) c.owner = [...c.members][0] } }
    scheduleSaveClans(); sendJson(res, 200, { ok: true }); return
  }
  if(url.pathname === '/clans/list' && req.method === 'GET'){
    if(!checkAuth(req)){ sendJson(res, 401, { error: 'unauthorized' }); return }
    const list = [...clans.values()].map(c => ({ id: c.id, name: c.name, tag: c.tag, owner: c.owner, members: [...c.members], memberCount: c.members.size, createdAt: c.createdAt }))
    sendJson(res, 200, { clans: list }); return
  }

  // ─────────────────────────────────────────────────────────
  // Voice
  // ─────────────────────────────────────────────────────────
  if(url.pathname === '/voice/join' && req.method === 'POST'){
    if(!checkAuth(req)){ sendJson(res, 401, { error: 'unauthorized' }); return }
    let body; try { body = parseJsonBody(await readBody(req)) } catch(e){ sendJson(res, e.status || 400, { error: 'bad_json' }); return }
    const nk = nickL(body.nick), roomId = safeStr(body.roomId, 128), muted = !!body.muted
    if(!nk || !roomId){ sendJson(res, 400, { error: 'faltan datos' }); return }
    for(const [rid, ch] of voiceChannels){ if(rid !== roomId) ch.delete(nk); if(!ch.size && rid !== roomId) voiceChannels.delete(rid) }
    if(!voiceChannels.has(roomId)) voiceChannels.set(roomId, new Map())
    voiceChannels.get(roomId).set(nk, { nick: body.nick, muted, lastSeen: now() })
    sendJson(res, 200, { ok: true }); return
  }
  if(url.pathname === '/voice/leave' && req.method === 'POST'){
    if(!checkAuth(req)){ sendJson(res, 401, { error: 'unauthorized' }); return }
    let body; try { body = parseJsonBody(await readBody(req)) } catch(e){ sendJson(res, e.status || 400, { error: 'bad_json' }); return }
    const nk = nickL(body.nick)
    if(!nk){ sendJson(res, 400, { error: 'missing nick' }); return }
    for(const [rid, ch] of voiceChannels){ ch.delete(nk); if(!ch.size) voiceChannels.delete(rid) }
    voiceMailbox.delete(nk); sendJson(res, 200, { ok: true }); return
  }
  if(url.pathname === '/voice/peers' && req.method === 'GET'){
    if(!checkAuth(req)){ sendJson(res, 401, { error: 'unauthorized' }); return }
    const roomId = url.searchParams.get('roomId') || '', me = nickL(url.searchParams.get('nick') || '')
    cleanup()
    const ch = voiceChannels.get(roomId)
    if(!ch){ sendJson(res, 200, { peers: [] }); return }
    const peers = []; for(const [nk, p] of ch){ if(nk === me) continue; peers.push({ nick: p.nick, muted: !!p.muted }) }
    sendJson(res, 200, { peers }); return
  }
  if(url.pathname === '/voice/signal' && req.method === 'POST'){
    if(!checkAuth(req)){ sendJson(res, 401, { error: 'unauthorized' }); return }
    if(!checkRate(ip, 'voiceSignals', RATE_MAX_VOICE_SIGNALS, 1000)){ sendJson(res, 429, { error: 'rate limited' }); return }
    let body; try { body = parseJsonBody(await readBody(req)) } catch(e){ sendJson(res, e.status || 400, { error: 'bad_json' }); return }
    const from = safeStr(body.from, 25), to = nickL(body.to), type = safeStr(body.type, 16), payload = body.payload
    if(!from || !to || !type){ sendJson(res, 400, { error: 'faltan datos' }); return }
    if(!['offer','answer','ice'].includes(type)){ sendJson(res, 400, { error: 'bad_type' }); return }
    let toFound = false
    for(const [, ch] of voiceChannels){ if(ch.has(to)){ toFound = true; break } }
    if(!toFound){ sendJson(res, 404, { error: 'target_not_in_voice' }); return }
    let serialized = ''
    try { serialized = JSON.stringify(payload || null) } catch(_){ sendJson(res, 400, { error: 'bad_payload' }); return }
    if(serialized.length > 8192){ sendJson(res, 413, { error: 'payload_too_large' }); return }
    if(!voiceMailbox.has(to)) voiceMailbox.set(to, [])
    const arr = voiceMailbox.get(to)
    if(arr.length > 200) arr.splice(0, arr.length - 200)
    arr.push({ from, type, payload, ts: now() })
    sendJson(res, 200, { ok: true }); return
  }
  if(url.pathname === '/voice/poll' && req.method === 'GET'){
    if(!checkAuth(req)){ sendJson(res, 401, { error: 'unauthorized' }); return }
    const nk = nickL(url.searchParams.get('nick') || '')
    if(!nk){ sendJson(res, 400, { error: 'missing nick' }); return }
    const msgs = voiceMailbox.get(nk) || []
    voiceMailbox.delete(nk)
    sendJson(res, 200, { messages: msgs }); return
  }

  // ─────────────────────────────────────────────────────────
  // Room users
  // ─────────────────────────────────────────────────────────
  if(url.pathname === '/room-users' && req.method === 'GET'){
    if(!checkAuth(req)){ sendJson(res, 401, { error: 'unauthorized' }); return }
    const roomId = url.searchParams.get('roomId') || ''
    cleanup()
    const list = []
    for(const [, e] of presence){
      if(e.roomId && String(e.roomId) === String(roomId)){
        let playerId = e.playerId || null
        if(!playerId && e.clientId){ const u = users.get(e.clientId); if(u && u.playerId) playerId = u.playerId }
        list.push({ nick: e.nick, playerId, haxballPlayerId: e.haxballPlayerId || null, secondsAgo: Math.round((now() - e.updatedAt) / 1000) })
      }
    }
    sendJson(res, 200, { users: list }); return
  }

  // ─────────────────────────────────────────────────────────
  // Avatares
  // ─────────────────────────────────────────────────────────
  if(url.pathname === '/user/avatar' && req.method === 'POST'){
    if(!checkAuth(req)){ sendJson(res, 401, { error: 'unauthorized' }); return }
    if(!checkRate(ip, 'avatarUploads', RATE_AVATAR_UPLOADS, RATE_AVATAR_WINDOW_MS)){ sendJson(res, 429, { error: 'rate limited' }); return }
    let body; try { body = parseJsonBody(await readBody(req, MAX_AVATAR_BYTES + 4096)) } catch(e){
      if(e && e.code === 'BODY_TOO_LARGE'){ sendJson(res, 413, { error: 'too_large' }); return }
      sendJson(res, e.status || 400, { error: 'bad_json' }); return
    }
    const nk = profileKeyFor({ playerId: safeStr(body.playerId, 32), nick: body.nick })
    const imageData = typeof body.imageData === 'string' ? body.imageData : ''
    if(!nk){ sendJson(res, 400, { error: 'missing nick' }); return }
    if(!imageData){ const had = userAvatars.delete(nk); if(had) scheduleSaveAvatars(); sendJson(res, 200, { ok: true, removed: true }); return }
    if(imageData.length > MAX_AVATAR_BYTES){ sendJson(res, 413, { error: 'too_large' }); return }
    if(!/^data:image\/(png|jpe?g|webp);base64,/i.test(imageData)){ sendJson(res, 400, { error: 'bad_format' }); return }
    userAvatars.set(nk, { dataUrl: imageData, updatedAt: now(), bytes: imageData.length })
    enforceAvatarLimits(); scheduleSaveAvatars()
    sendJson(res, 200, { ok: true }); return
  }
  if(url.pathname === '/user/avatar' && req.method === 'GET'){
    if(!checkAuth(req)){ sendJson(res, 401, { error: 'unauthorized' }); return }
    const nk = profileKeyFor({ playerId: safeStr(url.searchParams.get('playerId') || '', 32), nick: url.searchParams.get('nick') })
    if(!nk){ sendJson(res, 400, { error: 'missing nick' }); return }
    const e = userAvatars.get(nk)
    if(!e){ sendJson(res, 404, { error: 'no avatar' }); return }
    sendJson(res, 200, { imageData: e.dataUrl, updatedAt: e.updatedAt }); return
  }

  // ─────────────────────────────────────────────────────────
  // Perfiles
  // ─────────────────────────────────────────────────────────
  if(url.pathname === '/user/profile' && req.method === 'POST'){
    if(!checkAuth(req)){ sendJson(res, 401, { error: 'unauthorized' }); return }
    if(!checkRate(ip, 'profileUpdates', RATE_PROFILE_UPDATES, RATE_PROFILE_WINDOW_MS)){ sendJson(res, 429, { error: 'rate limited' }); return }
    let body; try { body = parseJsonBody(await readBody(req)) } catch(e){ sendJson(res, e.status || 400, { error: 'bad_json' }); return }
    const nk = profileKeyFor({ playerId: safeStr(body.playerId, 32), nick: body.nick })
    if(!nk){ sendJson(res, 400, { error: 'missing nick' }); return }
    const prev = userProfiles.get(nk) || { avatarColor: null, banner: null, bio: '', updatedAt: 0 }
    const next = { avatarColor: prev.avatarColor, banner: prev.banner, bio: prev.bio, updatedAt: now() }
    if(typeof body.avatarColor === 'string'){ const c = body.avatarColor.trim(); if(!c) next.avatarColor = null; else if(HEX_COLOR_RE.test(c)) next.avatarColor = c.toLowerCase(); else { sendJson(res, 400, { error: 'bad_color' }); return } }
    if(typeof body.banner === 'string'){ const b = body.banner.trim(); if(!b) next.banner = null; else if(ALLOWED_BANNERS.includes(b)) next.banner = b; else { sendJson(res, 400, { error: 'bad_banner' }); return } }
    if(typeof body.bio === 'string') next.bio = body.bio.slice(0, MAX_BIO_LENGTH)
    userProfiles.set(nk, next); scheduleSaveProfiles()
    sendJson(res, 200, { ok: true, profile: next }); return
  }
  if(url.pathname === '/user/profile' && req.method === 'GET'){
    if(!checkAuth(req)){ sendJson(res, 401, { error: 'unauthorized' }); return }
    const nk = profileKeyFor({ playerId: safeStr(url.searchParams.get('playerId') || '', 32), nick: url.searchParams.get('nick') })
    if(!nk){ sendJson(res, 400, { error: 'missing nick' }); return }
    const p = userProfiles.get(nk)
    if(!p){ sendJson(res, 200, { profile: { avatarColor: null, banner: null, bio: '' } }); return }
    sendJson(res, 200, { profile: { avatarColor: p.avatarColor, banner: p.banner, bio: p.bio, updatedAt: p.updatedAt } }); return
  }
  if(url.pathname === '/user/profiles' && req.method === 'GET'){
    if(!checkAuth(req)){ sendJson(res, 401, { error: 'unauthorized' }); return }
    const raw = (url.searchParams.get('nicks') || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, MAX_NICKS_PER_QUERY)
    const out = {}
    for(const item of raw){
      const pObj = players.get(playerIdL(item))
      const key = pObj ? `pid:${pObj.idLower}` : item.toLowerCase()
      const p = userProfiles.get(key)
      out[item.toLowerCase()] = p ? { avatarColor: p.avatarColor, banner: p.banner, bio: p.bio } : { avatarColor: null, banner: null, bio: '' }
    }
    sendJson(res, 200, { profiles: out }); return
  }

  // ─────────────────────────────────────────────────────────
  // Player endpoints
  // ─────────────────────────────────────────────────────────
  if(url.pathname === '/player/check-id' && req.method === 'POST'){
    if(!checkAuth(req)){ sendJson(res, 401, { error: 'unauthorized' }); return }
    if(!checkRate(ip, 'playerChecks', RATE_PLAYER_CHECKS, RATE_PLAYER_WINDOW_MS)){ sendJson(res, 429, { error: 'rate limited' }); return }
    let body; try { body = parseJsonBody(await readBody(req)) } catch(e){ sendJson(res, e.status || 400, { error: 'bad_json' }); return }
    const v = validatePlayerId(body.id)
    if(!v.ok){ sendJson(res, 200, { available: false, reason: v.reason }); return }
    if(players.has(v.lower)){ sendJson(res, 200, { available: false, reason: 'taken' }); return }
    sendJson(res, 200, { available: true, display: v.display }); return
  }
  if(url.pathname === '/player/register' && req.method === 'POST'){
    if(!checkAuth(req)){ sendJson(res, 401, { error: 'unauthorized' }); return }
    if(!checkRate(ip, 'playerChecks', RATE_PLAYER_CHECKS, RATE_PLAYER_WINDOW_MS)){ sendJson(res, 429, { error: 'rate limited' }); return }
    let body; try { body = parseJsonBody(await readBody(req)) } catch(e){ sendJson(res, e.status || 400, { error: 'bad_json' }); return }
    const clientId = safeStr(body.clientId, 64)
    if(!clientId){ sendJson(res, 400, { error: 'missing_client_id' }); return }
    if(isBlocked(clientId)){ sendJson(res, 403, { error: 'blocked' }); return }
    const existing = getPlayerByClientId(clientId)
    if(existing){ sendJson(res, 409, { error: 'already_registered', playerId: existing.id }); return }
    const v = validatePlayerId(body.id)
    if(!v.ok){ sendJson(res, 400, { error: 'invalid_id', reason: v.reason }); return }
    if(players.has(v.lower)){ sendJson(res, 409, { error: 'taken' }); return }
    let nickname = v.display
    if(typeof body.nickname === 'string' && body.nickname.trim()){ const nv = validateNickname(body.nickname); if(!nv.ok){ sendJson(res, 400, { error: 'invalid_nickname', reason: nv.reason }); return } nickname = nv.nickname }
    const recoveryCode = makeRecoveryCode()
    const discordId = safeStr(body.discordId, 32) || null
    const entry = { id: v.display, idLower: v.lower, nickname, recoveryCode, createdByClientId: clientId, discordId, createdAt: now(), nicknameHistory: [{ nickname, changedAt: now() }], privacy: { ...DEFAULT_PRIVACY }, role: DEFAULT_ROLE }
    players.set(v.lower, entry); playersByRecovery.set(recoveryCode, v.lower); scheduleSavePlayers()
    touchUser(clientId, { nickname, playerId: v.display, ip })
    const u = users.get(clientId); if(u){ u.playerId = v.display; u.playerIdDisplay = v.display; users.set(clientId, u); scheduleSaveUsers() }
    console.log(`[bc-presence] nuevo player: ${v.display}`)
    sendJson(res, 200, { ok: true, playerId: v.display, nickname, recoveryCode, role: DEFAULT_ROLE }); return
  }
  if(url.pathname === '/player/set-nickname' && req.method === 'POST'){
    if(!checkAuth(req)){ sendJson(res, 401, { error: 'unauthorized' }); return }
    let body; try { body = parseJsonBody(await readBody(req)) } catch(e){ sendJson(res, e.status || 400, { error: 'bad_json' }); return }
    const clientId = safeStr(body.clientId, 64)
    if(!clientId){ sendJson(res, 400, { error: 'missing_client_id' }); return }
    const player = getPlayerByClientId(clientId)
    if(!player){ sendJson(res, 404, { error: 'not_registered' }); return }
    const nv = validateNickname(body.nickname)
    if(!nv.ok){ sendJson(res, 400, { error: 'invalid_nickname', reason: nv.reason }); return }
    if(nv.nickname === player.nickname){ sendJson(res, 200, { ok: true, nickname: nv.nickname, unchanged: true }); return }
    player.nickname = nv.nickname
    player.nicknameHistory.push({ nickname: nv.nickname, changedAt: now() })
    if(player.nicknameHistory.length > 50) player.nicknameHistory = player.nicknameHistory.slice(-50)
    players.set(player.idLower, player); scheduleSavePlayers()
    const u = users.get(clientId); if(u){ u.nickname = nv.nickname; users.set(clientId, u); scheduleSaveUsers() }
    sendJson(res, 200, { ok: true, nickname: nv.nickname }); return
  }
  // Alias por playerId (usado por el cliente actual)
  if(url.pathname === '/player/update-nick' && req.method === 'POST'){
    if(!checkAuth(req)){ sendJson(res, 401, { error: 'unauthorized' }); return }
    let body; try { body = parseJsonBody(await readBody(req)) } catch(e){ sendJson(res, e.status || 400, { error: 'bad_json' }); return }
    const pidRaw = safeStr(body.playerId, 32)
    const player = pidRaw ? players.get(playerIdL(pidRaw)) : null
    if(!player){ sendJson(res, 404, { error: 'player_not_found' }); return }
    const nv = validateNickname(body.nickname)
    if(!nv.ok){ sendJson(res, 400, { error: 'invalid_nickname', reason: nv.reason }); return }
    if(nv.nickname === player.nickname){ sendJson(res, 200, { ok: true, nickname: nv.nickname, unchanged: true }); return }
    player.nickname = nv.nickname
    player.nicknameHistory.push({ nickname: nv.nickname, changedAt: now() })
    if(player.nicknameHistory.length > 50) player.nicknameHistory = player.nicknameHistory.slice(-50)
    players.set(player.idLower, player); scheduleSavePlayers()
    if(player.createdByClientId){
      const u = users.get(player.createdByClientId)
      if(u){ u.nickname = nv.nickname; users.set(player.createdByClientId, u); scheduleSaveUsers() }
    }
    sendJson(res, 200, { ok: true, nickname: nv.nickname }); return
  }
  if(url.pathname === '/player/me' && req.method === 'GET'){
    if(!checkAuth(req)){ sendJson(res, 401, { error: 'unauthorized' }); return }
    const clientId = safeStr(url.searchParams.get('clientId') || '', 64)
    if(!clientId){ sendJson(res, 400, { error: 'missing_client_id' }); return }
    const player = getPlayerByClientId(clientId)
    if(!player){ sendJson(res, 404, { error: 'not_registered' }); return }
    sendJson(res, 200, { player: publicPlayerView(player) }); return
  }
  if(url.pathname === '/player/search' && req.method === 'GET'){
    if(!checkAuth(req)){ sendJson(res, 401, { error: 'unauthorized' }); return }
    const asPid = safeStr(url.searchParams.get('as') || '', 32)
    const asP = asPid ? findPlayerByAnyId(asPid) : null
    if(asP){
      if(!checkPlayerIdRate(asP.idLower, 'searches', RATE_PLAYER_SEARCHES, RATE_PLAYER_SEARCHES_WINDOW_MS)){ sendJson(res, 429, { error: 'rate limited' }); return }
    } else {
      if(!checkRate(ip, 'playerChecks', RATE_PLAYER_CHECKS, RATE_PLAYER_WINDOW_MS)){ sendJson(res, 429, { error: 'rate limited' }); return }
    }
    const q = safeStr(url.searchParams.get('q') || '', 32).trim().toLowerCase()
    if(!q || q.length < 2){ sendJson(res, 200, { results: [] }); return }
    const results = []
    for(const [idLower, p] of players){
      if(results.length >= 20) break
      const matchId = idLower.startsWith(q)
      const matchNick = p.nickname && p.nickname.toLowerCase().includes(q)
      if(matchId || matchNick){ results.push({ ...publicPlayerView(p), online: !!getPresenceForPlayer(idLower) }) }
    }
    results.sort((a, b) => {
      const aS = a.id.toLowerCase().startsWith(q) ? 0 : 1
      const bS = b.id.toLowerCase().startsWith(q) ? 0 : 1
      if(aS !== bS) return aS - bS
      if(a.online !== b.online) return a.online ? -1 : 1
      return a.id.localeCompare(b.id)
    })
    sendJson(res, 200, { results }); return
  }
  if(url.pathname === '/player/recover' && req.method === 'POST'){
    if(!checkAuth(req)){ sendJson(res, 401, { error: 'unauthorized' }); return }
    if(!checkRate(ip, 'playerChecks', RATE_PLAYER_CHECKS, RATE_PLAYER_WINDOW_MS)){ sendJson(res, 429, { error: 'rate limited' }); return }
    let body; try { body = parseJsonBody(await readBody(req)) } catch(e){ sendJson(res, e.status || 400, { error: 'bad_json' }); return }
    const clientId = safeStr(body.clientId, 64), code = safeStr(body.recoveryCode, 64).trim().toUpperCase()
    if(!clientId || !code){ sendJson(res, 400, { error: 'missing_fields' }); return }
    if(isBlocked(clientId)){ sendJson(res, 403, { error: 'blocked' }); return }
    const idLower = playersByRecovery.get(code)
    if(!idLower){ sendJson(res, 404, { error: 'invalid_code' }); return }
    const player = players.get(idLower)
    if(!player){ sendJson(res, 404, { error: 'invalid_code' }); return }
    for(const [cid, u] of users){ if(u.playerId && u.playerId.toLowerCase() === idLower){ u.playerId = null; u.playerIdDisplay = null; users.set(cid, u) } }
    touchUser(clientId, { nickname: player.nickname, playerId: player.id, ip })
    const u = users.get(clientId); if(u){ u.playerId = player.id; u.playerIdDisplay = player.id; users.set(clientId, u) }
    scheduleSaveUsers()
    sendJson(res, 200, { ok: true, player: publicPlayerView(player) }); return
  }

  // ─────────────────────────────────────────────────────────
  // Party
  // ─────────────────────────────────────────────────────────
  if(url.pathname === '/party/create' && req.method === 'POST'){
    if(!checkAuth(req)){ sendJson(res, 401, { error: 'unauthorized' }); return }
    let body; try { body = parseJsonBody(await readBody(req)) } catch(e){ sendJson(res, e.status || 400, { error: 'bad_json' }); return }
    const me = findPlayerByAnyId(safeStr(body.playerId, 32))
    if(!me){ sendJson(res, 404, { error: 'player_not_found' }); return }
    if(!checkPlayerIdRate(me.idLower, 'partyCreates', RATE_PARTY_CREATES, RATE_PARTY_CREATES_WINDOW_MS)){ sendJson(res, 429, { error: 'rate limited' }); return }
    if(partyByPlayer.has(me.idLower)){ sendJson(res, 409, { error: 'already_in_party' }); return }
    const maxSize = Math.min(PARTY_MAX_SIZE_LIMIT, Math.max(2, parseInt(body.maxSize, 10) || PARTY_MAX_SIZE_DEFAULT))
    const partyId = makePartyId()
    const party = { partyId, leaderId: me.idLower, members: new Set([me.idLower]), maxSize, createdAt: now(), roomId: null, roomName: null }
    parties.set(partyId, party)
    partyByPlayer.set(me.idLower, partyId)
    partiesDirtyRef.v = true
    scheduleSaveParties()
    broadcastPartyUpdate(party)
    sendJson(res, 200, { ok: true, party: buildPartyView(party, me.idLower) })
    return
  }
  if(url.pathname === '/party/invite' && req.method === 'POST'){
    if(!checkAuth(req)){ sendJson(res, 401, { error: 'unauthorized' }); return }
    let body; try { body = parseJsonBody(await readBody(req)) } catch(e){ sendJson(res, e.status || 400, { error: 'bad_json' }); return }
    const me = findPlayerByAnyId(safeStr(body.playerId, 32))
    const target = findPlayerByAnyId(safeStr(body.targetPlayerId, 32))
    if(!me || !target){ sendJson(res, 404, { error: 'player_not_found' }); return }
    const party = getPartyForPlayer(me.idLower)
    if(!party){ sendJson(res, 404, { error: 'no_party' }); return }
    if(party.leaderId !== me.idLower){ sendJson(res, 403, { error: 'not_leader' }); return }
    if(party.members.size >= party.maxSize){ sendJson(res, 409, { error: 'party_full' }); return }
    if(partyByPlayer.has(target.idLower)){ sendJson(res, 409, { error: 'target_in_party' }); return }
    if(!checkPlayerIdRate(me.idLower, 'partyInvites', RATE_PARTY_INVITES, RATE_PARTY_INVITES_WINDOW_MS)){ sendJson(res, 429, { error: 'rate limited' }); return }
    const notif = { id: makeNotifId(), type: 'party_invite', fromPlayerId: me.id, fromNick: me.nickname, ts: now(), payload: { partyId: party.partyId, leaderId: me.id, leaderNick: me.nickname, memberCount: party.members.size, maxSize: party.maxSize } }
    pushNotification(target.idLower, notif, { ephemeral: true })
    sendJson(res, 200, { ok: true })
    return
  }
  if(url.pathname === '/party/accept' && req.method === 'POST'){
    if(!checkAuth(req)){ sendJson(res, 401, { error: 'unauthorized' }); return }
    let body; try { body = parseJsonBody(await readBody(req)) } catch(e){ sendJson(res, e.status || 400, { error: 'bad_json' }); return }
    const me = findPlayerByAnyId(safeStr(body.playerId, 32))
    const partyId = safeStr(body.partyId, 64)
    if(!me || !partyId){ sendJson(res, 400, { error: 'missing_fields' }); return }
    const party = parties.get(partyId)
    if(!party){ sendJson(res, 404, { error: 'party_not_found' }); return }
    if(party.members.has(me.idLower)){ sendJson(res, 200, { ok: true, already: true, party: buildPartyView(party, me.idLower) }); return }
    if(partyByPlayer.has(me.idLower)){ sendJson(res, 409, { error: 'already_in_party' }); return }
    if(party.members.size >= party.maxSize){ sendJson(res, 409, { error: 'party_full' }); return }
    party.members.add(me.idLower)
    partyByPlayer.set(me.idLower, partyId)
    partiesDirtyRef.v = true
    scheduleSaveParties()
    broadcastPartyUpdate(party)
    sendJson(res, 200, { ok: true, party: buildPartyView(party, me.idLower) })
    return
  }
  if(url.pathname === '/party/decline' && req.method === 'POST'){
    if(!checkAuth(req)){ sendJson(res, 401, { error: 'unauthorized' }); return }
    let body; try { body = parseJsonBody(await readBody(req)) } catch(e){ sendJson(res, e.status || 400, { error: 'bad_json' }); return }
    const me = findPlayerByAnyId(safeStr(body.playerId, 32))
    const partyId = safeStr(body.partyId, 64)
    if(!me || !partyId){ sendJson(res, 400, { error: 'missing_fields' }); return }
    const party = parties.get(partyId)
    if(party){ broadcastPartyTo(party.leaderId, 'party_invite_declined', { partyId, playerId: me.id, nickname: me.nickname, ts: now() }) }
    sendJson(res, 200, { ok: true })
    return
  }
  if(url.pathname === '/party/leave' && req.method === 'POST'){
    if(!checkAuth(req)){ sendJson(res, 401, { error: 'unauthorized' }); return }
    let body; try { body = parseJsonBody(await readBody(req)) } catch(e){ sendJson(res, e.status || 400, { error: 'bad_json' }); return }
    const me = findPlayerByAnyId(safeStr(body.playerId, 32))
    if(!me){ sendJson(res, 404, { error: 'player_not_found' }); return }
    const party = getPartyForPlayer(me.idLower)
    if(!party){ sendJson(res, 200, { ok: true, party: null }); return }
    const remaining = removeMemberFromParty(party, me.idLower, 'left')
    const meView = remaining ? buildPartyView(remaining, me.idLower) : null
    sendJson(res, 200, { ok: true, party: meView })
    return
  }
  if(url.pathname === '/party/kick' && req.method === 'POST'){
    if(!checkAuth(req)){ sendJson(res, 401, { error: 'unauthorized' }); return }
    let body; try { body = parseJsonBody(await readBody(req)) } catch(e){ sendJson(res, e.status || 400, { error: 'bad_json' }); return }
    const me = findPlayerByAnyId(safeStr(body.playerId, 32))
    const target = findPlayerByAnyId(safeStr(body.targetPlayerId, 32))
    if(!me || !target){ sendJson(res, 404, { error: 'player_not_found' }); return }
    const party = getPartyForPlayer(me.idLower)
    if(!party){ sendJson(res, 404, { error: 'no_party' }); return }
    if(party.leaderId !== me.idLower){ sendJson(res, 403, { error: 'not_leader' }); return }
    if(target.idLower === me.idLower){ sendJson(res, 400, { error: 'cannot_kick_self' }); return }
    if(!party.members.has(target.idLower)){ sendJson(res, 404, { error: 'not_in_party' }); return }
    const remaining = removeMemberFromParty(party, target.idLower, 'kicked')
    broadcastPartyTo(target.idLower, 'party_kicked', { partyId: party.partyId, byPlayerId: me.id, byNick: me.nickname })
    sendJson(res, 200, { ok: true, party: remaining ? buildPartyView(remaining, me.idLower) : null })
    return
  }
  if(url.pathname === '/party/promote' && req.method === 'POST'){
    if(!checkAuth(req)){ sendJson(res, 401, { error: 'unauthorized' }); return }
    let body; try { body = parseJsonBody(await readBody(req)) } catch(e){ sendJson(res, e.status || 400, { error: 'bad_json' }); return }
    const me = findPlayerByAnyId(safeStr(body.playerId, 32))
    const newLeader = findPlayerByAnyId(safeStr(body.newLeaderId, 32))
    if(!me || !newLeader){ sendJson(res, 404, { error: 'player_not_found' }); return }
    const party = getPartyForPlayer(me.idLower)
    if(!party){ sendJson(res, 404, { error: 'no_party' }); return }
    if(party.leaderId !== me.idLower){ sendJson(res, 403, { error: 'not_leader' }); return }
    if(!party.members.has(newLeader.idLower)){ sendJson(res, 400, { error: 'not_in_party' }); return }
    party.leaderId = newLeader.idLower
    partiesDirtyRef.v = true
    scheduleSaveParties()
    broadcastPartyUpdate(party)
    sendJson(res, 200, { ok: true, party: buildPartyView(party, me.idLower) })
    return
  }
  if(url.pathname === '/party' && req.method === 'GET'){
    if(!checkAuth(req)){ sendJson(res, 401, { error: 'unauthorized' }); return }
    const me = findPlayerByAnyId(safeStr(url.searchParams.get('playerId') || '', 32))
    if(!me){ sendJson(res, 404, { error: 'player_not_found' }); return }
    const party = getPartyForPlayer(me.idLower)
    sendJson(res, 200, { ok: true, party: party ? buildPartyView(party, me.idLower) : null })
    return
  }

  // ─────────────────────────────────────────────────────────
  // Stats
  // ─────────────────────────────────────────────────────────
  if(!db){
    if(url.pathname.startsWith('/match/') || (url.pathname.startsWith('/player/') && (url.pathname.endsWith('/stats') || url.pathname.endsWith('/matches')))){
      sendJson(res, 503, { error: 'stats_disabled' }); return
    }
  }
  if(db && url.pathname === '/match/start' && req.method === 'POST'){
    if(!checkAuth(req)){ sendJson(res, 401, { error: 'unauthorized' }); return }
    if(!checkRate(ip, 'matchCalls', RATE_MATCH_CALLS, RATE_MATCH_WINDOW_MS)){ sendJson(res, 429, { error: 'rate limited' }); return }
    let body; try { body = parseJsonBody(await readBody(req)) } catch(e){ sendJson(res, e.status || 400, { error: 'bad_json' }); return }
    const roomId = safeStr(body.roomId, 128), roomName = safeStr(body.roomName, 80), stadium = safeStr(body.stadium, 80)
    const playersList = Array.isArray(body.players) ? body.players.slice(0, 30) : []
    if(!roomId){ sendJson(res, 400, { error: 'missing_roomId' }); return }
    const prev = activeMatches.get(roomId)
    if(prev){
      console.warn(`[stats] /match/start duplicado en room ${roomId}; cerrando match previo #${prev.matchId}`)
      try {
        await db.query(`UPDATE matches SET ended_at = $1, duration_ms = $2 WHERE id = $3 AND ended_at IS NULL`, [Date.now(), Math.max(0, Date.now() - (prev.createdAt || Date.now())), prev.matchId])
      } catch(_) {}
      activeMatches.delete(roomId)
    }
    try {
      const ins = await db.query(`INSERT INTO matches (room_id, room_name, stadium, started_at) VALUES ($1, $2, $3, $4) RETURNING id`, [roomId, roomName || null, stadium || null, Date.now()])
      const matchId = ins.rows[0].id
      for(const p of playersList){
        const pid = safeStr(p.playerId, 32); if(!pid) continue
        await db.query(`INSERT INTO match_players (match_id, player_id, haxball_id, nickname, team_id) VALUES ($1, $2, $3, $4, $5)`, [matchId, pid, typeof p.haxballId === 'number' ? p.haxballId : null, safeStr(p.nickname, 25) || null, typeof p.teamId === 'number' ? p.teamId : 0])
      }
      activeMatches.set(roomId, { matchId, players: playersList.map(p => ({ playerId: safeStr(p.playerId, 32), haxballId: p.haxballId, teamId: p.teamId, nickname: safeStr(p.nickname, 25) })), createdAt: now() })
      console.log(`[stats] match #${matchId} iniciado`)
      sendJson(res, 200, { ok: true, matchId })
    } catch(e){ console.error('[stats] /match/start:', e.message); sendJson(res, 500, { error: 'db_error', message: e.message }) }
    return
  }
  if(db && url.pathname === '/match/goal' && req.method === 'POST'){
    if(!checkAuth(req)){ sendJson(res, 401, { error: 'unauthorized' }); return }
    if(!checkRate(ip, 'matchCalls', RATE_MATCH_CALLS, RATE_MATCH_WINDOW_MS)){ sendJson(res, 429, { error: 'rate limited' }); return }
    let body; try { body = parseJsonBody(await readBody(req)) } catch(e){ sendJson(res, e.status || 400, { error: 'bad_json' }); return }
    const matchId = parseInt(body.matchId, 10)
    const teamId = typeof body.teamId === 'number' ? body.teamId : null
    const scorerId = safeStr(body.scorerId, 32) || null
    const assisterId = safeStr(body.assisterId, 32) || null
    const ownGoal = !!body.ownGoal
    const confidence = typeof body.confidence === 'number' ? Math.max(0, Math.min(1, body.confidence)) : null
    if(!matchId || !teamId){ sendJson(res, 400, { error: 'missing_fields' }); return }
    try { await db.query(`INSERT INTO goals (match_id, team_id, scorer_id, assister_id, own_goal, confidence, ts) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [matchId, teamId, scorerId, assisterId, ownGoal, confidence, Date.now()]); sendJson(res, 200, { ok: true }) }
    catch(e){ console.error('[stats] /match/goal:', e.message); sendJson(res, 500, { error: 'db_error', message: e.message }) }
    return
  }
  if(db && url.pathname === '/match/end' && req.method === 'POST'){
    if(!checkAuth(req)){ sendJson(res, 401, { error: 'unauthorized' }); return }
    if(!checkRate(ip, 'matchCalls', RATE_MATCH_CALLS, RATE_MATCH_WINDOW_MS)){ sendJson(res, 429, { error: 'rate limited' }); return }
    let body; try { body = parseJsonBody(await readBody(req)) } catch(e){ sendJson(res, e.status || 400, { error: 'bad_json' }); return }
    const matchId = parseInt(body.matchId, 10), scoreRed = parseInt(body.scoreRed, 10) || 0, scoreBlue = parseInt(body.scoreBlue, 10) || 0
    const roomIdRaw = safeStr(body.roomId, 128)
    if(!matchId){ sendJson(res, 400, { error: 'missing_matchId' }); return }
    const _tx = (db && typeof db.withTransaction === 'function')
      ? db.withTransaction
      : (async (fn) => fn(db.pool))
    try {
      const result = await _tx(async (tx) => {
        const q = (sql, params) => tx.query(sql, params)
        const mRes = await q('SELECT started_at FROM matches WHERE id = $1 FOR UPDATE', [matchId])
        if(!mRes.rows.length) return { notFound: true }
        const startedAt = Number(mRes.rows[0].started_at), endedAt = Date.now(), durationMs = Math.max(0, endedAt - startedAt)
        await q(`UPDATE matches SET score_red = $1, score_blue = $2, ended_at = $3, duration_ms = $4 WHERE id = $5`, [scoreRed, scoreBlue, endedAt, durationMs, matchId])
        const goalsRes = await q('SELECT scorer_id, assister_id, own_goal FROM goals WHERE match_id = $1', [matchId])
        const goalsByPlayer = new Map(), assistsByPlayer = new Map(), ownGoalsByPlayer = new Map()
        for(const g of goalsRes.rows){
          if(g.scorer_id && !g.own_goal) goalsByPlayer.set(g.scorer_id, (goalsByPlayer.get(g.scorer_id) || 0) + 1)
          if(g.scorer_id && g.own_goal) ownGoalsByPlayer.set(g.scorer_id, (ownGoalsByPlayer.get(g.scorer_id) || 0) + 1)
          if(g.assister_id) assistsByPlayer.set(g.assister_id, (assistsByPlayer.get(g.assister_id) || 0) + 1)
        }
        const playersRes = await q('SELECT id, player_id, team_id FROM match_players WHERE match_id = $1', [matchId])
        const winningTeam = scoreRed > scoreBlue ? 1 : (scoreBlue > scoreRed ? 2 : 0)
        for(const p of playersRes.rows){
          const g = goalsByPlayer.get(p.player_id) || 0, a = assistsByPlayer.get(p.player_id) || 0, og = ownGoalsByPlayer.get(p.player_id) || 0
          await q(`UPDATE match_players SET goals = $1, assists = $2, own_goals = $3 WHERE id = $4`, [g, a, og, p.id])
        }
        let mvpPlayerId = null, bestScore = -1
        for(const p of playersRes.rows){ if(winningTeam !== 0 && p.team_id !== winningTeam) continue; const g = goalsByPlayer.get(p.player_id) || 0, a = assistsByPlayer.get(p.player_id) || 0; const s = g * 10 + a * 5; if(s > bestScore){ bestScore = s; mvpPlayerId = p.player_id } }
        if(mvpPlayerId && bestScore > 0) await q('UPDATE match_players SET was_mvp = TRUE WHERE match_id = $1 AND player_id = $2', [matchId, mvpPlayerId])
        for(const p of playersRes.rows){
          const g = goalsByPlayer.get(p.player_id) || 0, a = assistsByPlayer.get(p.player_id) || 0, og = ownGoalsByPlayer.get(p.player_id) || 0
          const isWin = winningTeam !== 0 && p.team_id === winningTeam, isDraw = winningTeam === 0
          const isMvp = p.player_id === mvpPlayerId && bestScore > 0
          const minutes = Math.round(durationMs / 60000)
          await q(`
            INSERT INTO player_totals (player_id, matches, wins, draws, losses, goals, assists, own_goals, mvps, minutes, current_streak, best_streak, last_match_at)
            VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10, $11)
            ON CONFLICT (player_id) DO UPDATE SET
              matches = player_totals.matches + 1,
              wins = player_totals.wins + $2,
              draws = player_totals.draws + $3,
              losses = player_totals.losses + $4,
              goals = player_totals.goals + $5,
              assists = player_totals.assists + $6,
              own_goals = player_totals.own_goals + $7,
              mvps = player_totals.mvps + $8,
              minutes = player_totals.minutes + $9,
              current_streak = CASE WHEN $2 = 1 THEN player_totals.current_streak + 1 ELSE 0 END,
              best_streak = GREATEST(player_totals.best_streak, CASE WHEN $2 = 1 THEN player_totals.current_streak + 1 ELSE player_totals.best_streak END),
              last_match_at = $11,
              updated_at = NOW()
          `, [p.player_id, isWin ? 1 : 0, isDraw ? 1 : 0, (!isWin && !isDraw) ? 1 : 0, g, a, og, isMvp ? 1 : 0, minutes, isWin ? 1 : 0, endedAt])
        }
        return { ok: true, durationMs, mvpPlayerId }
      })

      if(result.notFound){ sendJson(res, 404, { error: 'match_not_found' }); return }
      if(roomIdRaw) activeMatches.delete(roomIdRaw)
      console.log(`[stats] match #${matchId} terminado: ${scoreRed}-${scoreBlue}`)
      sendJson(res, 200, { ok: true, matchId, duration: result.durationMs, mvp: result.mvpPlayerId })
    } catch(e){ console.error('[stats] /match/end:', e.message); sendJson(res, 500, { error: 'db_error', message: e.message }) }
    return
  }
  if(db && url.pathname.startsWith('/player/') && url.pathname.endsWith('/stats') && req.method === 'GET'){
    if(!checkAuth(req)){ sendJson(res, 401, { error: 'unauthorized' }); return }
    const idRaw = url.pathname.slice('/player/'.length, -'/stats'.length)
    const player = players.get(idRaw.toLowerCase())
    if(!player){ sendJson(res, 404, { error: 'not_found' }); return }
    try {
      const t = await db.query('SELECT * FROM player_totals WHERE player_id = $1', [player.id])
      const totals = t.rows[0] || { matches: 0, wins: 0, draws: 0, losses: 0, goals: 0, assists: 0, own_goals: 0, mvps: 0, minutes: 0, best_streak: 0, current_streak: 0 }
      const byMap = await db.query(`SELECT m.stadium, COUNT(*) AS matches, SUM(CASE WHEN (mp.team_id = 1 AND m.score_red > m.score_blue) OR (mp.team_id = 2 AND m.score_blue > m.score_red) THEN 1 ELSE 0 END) AS wins, SUM(mp.goals) AS goals FROM match_players mp JOIN matches m ON m.id = mp.match_id WHERE mp.player_id = $1 AND m.ended_at IS NOT NULL AND m.stadium IS NOT NULL GROUP BY m.stadium ORDER BY matches DESC LIMIT 20`, [player.id])
      const byTeam = await db.query(`SELECT mp.team_id, COUNT(*) AS matches, SUM(mp.goals) AS goals FROM match_players mp JOIN matches m ON m.id = mp.match_id WHERE mp.player_id = $1 AND m.ended_at IS NOT NULL GROUP BY mp.team_id`, [player.id])
      sendJson(res, 200, {
        playerId: player.id, nickname: player.nickname,
        totals: {
          matches: totals.matches, wins: totals.wins, draws: totals.draws, losses: totals.losses,
          winRate: totals.matches > 0 ? +(totals.wins / totals.matches * 100).toFixed(1) : 0,
          goals: totals.goals, assists: totals.assists, ownGoals: totals.own_goals, mvps: totals.mvps,
          minutes: totals.minutes, bestStreak: totals.best_streak, currentStreak: totals.current_streak,
          goalsPerMatch: totals.matches > 0 ? +(totals.goals / totals.matches).toFixed(2) : 0,
          assistsPerMatch: totals.matches > 0 ? +(totals.assists / totals.matches).toFixed(2) : 0,
        },
        byMap: byMap.rows.map(r => ({ stadium: r.stadium, matches: parseInt(r.matches, 10), wins: parseInt(r.wins, 10), goals: parseInt(r.goals, 10) || 0 })),
        byTeam: byTeam.rows.map(r => ({ teamId: r.team_id, matches: parseInt(r.matches, 10), goals: parseInt(r.goals, 10) || 0 })),
      })
    } catch(e){ console.error('[stats] /player/:id/stats:', e.message); sendJson(res, 500, { error: 'db_error', message: e.message }) }
    return
  }
  if(db && url.pathname.startsWith('/player/') && url.pathname.endsWith('/matches') && req.method === 'GET'){
    if(!checkAuth(req)){ sendJson(res, 401, { error: 'unauthorized' }); return }
    const idRaw = url.pathname.slice('/player/'.length, -'/matches'.length)
    const player = players.get(idRaw.toLowerCase())
    if(!player){ sendJson(res, 404, { error: 'not_found' }); return }
    const limit = Math.min(50, Math.max(1, parseInt(url.searchParams.get('limit') || '20', 10)))
    try {
      const r = await db.query(`SELECT m.id, m.room_name, m.stadium, m.score_red, m.score_blue, m.started_at, m.ended_at, m.duration_ms, mp.team_id, mp.goals, mp.assists, mp.own_goals, mp.was_mvp FROM match_players mp JOIN matches m ON m.id = mp.match_id WHERE mp.player_id = $1 AND m.ended_at IS NOT NULL ORDER BY m.ended_at DESC LIMIT $2`, [player.id, limit])
      const matchesList = r.rows.map(row => {
        let result = 'D'
        if(row.team_id === 1) result = row.score_red > row.score_blue ? 'W' : (row.score_red < row.score_blue ? 'L' : 'D')
        else if(row.team_id === 2) result = row.score_blue > row.score_red ? 'W' : (row.score_blue < row.score_red ? 'L' : 'D')
        return { matchId: row.id, roomName: row.room_name, stadium: row.stadium, scoreRed: row.score_red, scoreBlue: row.score_blue, teamId: row.team_id, goals: row.goals, assists: row.assists, ownGoals: row.own_goals, mvp: row.was_mvp, result, startedAt: Number(row.started_at), endedAt: Number(row.ended_at), durationMs: row.duration_ms }
      })
      sendJson(res, 200, { playerId: player.id, matches: matchesList })
    } catch(e){ console.error('[stats] /player/:id/matches:', e.message); sendJson(res, 500, { error: 'db_error', message: e.message }) }
    return
  }

  if(url.pathname.startsWith('/player/') && req.method === 'GET'){
    if(!checkAuth(req)){ sendJson(res, 401, { error: 'unauthorized' }); return }
    const idRaw = url.pathname.slice('/player/'.length)
    const player = players.get(idRaw.toLowerCase())
    if(!player){ sendJson(res, 404, { error: 'not_found' }); return }
    sendJson(res, 200, { player: publicPlayerView(player) }); return
  }

  sendJson(res, 404, { error: 'not found' })
}

// ============================================================
// BOOT
// ============================================================

try { fs.mkdirSync(DATA_DIR, { recursive: true }) } catch(e){ console.warn('[bc-presence] no DATA_DIR:', e.message) }

loadAvatarsFromDisk()
loadProfilesFromDisk()
loadBetaKeysFromDisk()
loadUsersFromDisk()
loadPlayersFromDisk()
loadClansFromDisk()
loadFriendsFromDisk()
loadNotificationsFromDisk()
loadPartiesFromDisk()

if(db){
  db.testConnection().then(ok => { if(!ok) console.warn('[bc-presence] stats deshabilitadas') })
}

server.on('error', (err) => {
  if(err.code === 'EADDRINUSE'){
    console.error(`[bc-presence] FATAL: puerto ${PORT} ya está en uso. Cerrá el otro proceso o cambiá PORT.`)
  } else if(err.code === 'EACCES'){
    console.error(`[bc-presence] FATAL: sin permisos para abrir el puerto ${PORT}.`)
  } else {
    console.error('[bc-presence] FATAL server error:', err && err.stack || err)
  }
  process.exit(1)
})

server.listen(PORT, BIND_HOST, () => {
  console.log(`[bc-presence] escuchando en ${BIND_HOST}:${PORT}`)
  console.log(`[bc-presence] admin: http://${BIND_HOST}:${PORT}/admin?k=TU_KEY`)
  console.log(`[bc-presence] TRUST_PROXY=${TRUST_PROXY ? '1' : '0'}`)
  console.log(`[bc-presence] avatares ${userAvatars.size} · perfiles ${userProfiles.size} · betaKeys ${betaKeys.size} · users ${users.size} · players ${players.size} · clanes ${clans.size} · amistades ${friendships.size}`)
  console.log(`[bc-presence] notificaciones persistentes: ${notificationsPersistent.size} jugadores`)
  console.log(`[bc-presence] parties: ${parties.size}`)
  console.log(`[bc-presence] stats: ${db ? 'ENABLED' : 'DISABLED'}`)
})
