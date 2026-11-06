'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = __dirname;
// Load a local .env file without adding a dependency. Existing process variables take precedence.
try {
  const envText = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
  for (const line of envText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (match && process.env[match[1]] == null) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
} catch {}
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const UPLOAD_AUDIO_DIR = path.join(PUBLIC_DIR, 'audio');
const CUSTOM_AUDIO_DIR = path.join(UPLOAD_AUDIO_DIR, 'custom');
const DEFAULT_AUDIO_BACKUP_DIR = path.join(DATA_DIR, 'default-audio');
const STATE_FILE = path.join(DATA_DIR, 'active-room-state.json');
const AUDIO_FILE = path.join(DATA_DIR, 'team-audio.json');
const AUDIO_METADATA_FILE = path.join(DATA_DIR, 'team-audio-metadata.json');
const PORT = Number(process.env.PORT || 3333);
const cleanCode = (s) => String(s || '').trim().replace(/^['"]|['"]$/g, '');
const HOST_ACCESS_CODE = cleanCode(process.env.HOST_ACCESS_CODE) || 'ipl2027owner';

const readJson = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
};
const writeJson = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2));
const candidates = readJson(path.join(DATA_DIR, 'candidates.json'), []);
const teamsConfig = readJson(path.join(DATA_DIR, 'teams.json'), []);
const initialSquads = readJson(path.join(DATA_DIR, 'initial-squads.json'), {});
const playerById = new Map(candidates.map(p => [p.id, p]));

// Canonical default hook-line audio mappings for all 10 IPL franchises
const DEFAULT_AUDIO_MAP = {
  CSK: '/audio/csk-hook.mp3',
  DC: '/audio/dc-hook.mp3',
  GT: '/audio/gt-hook.mp3',
  KKR: '/audio/kkr-hook.mp3',
  LSG: '/audio/lsg-hook.mp3',
  MI: '/audio/mi-hook.mp3',
  PBKS: '/audio/pbks-hook.mp3',
  RCB: '/audio/rcb-hook.mp3',
  RR: '/audio/rr-hook.mp3',
  SRH: '/audio/srh-hook.mp3'
};

const DEFAULT_AUDIO_DURATIONS = {
  CSK: 6.48,
  DC: 7.52,
  GT: 6.01,
  KKR: 5.85,
  LSG: 9.06,
  MI: 8.15,
  PBKS: 10.16,
  RCB: 11.08,
  RR: 7.84,
  SRH: 12.09
};

// Ensure default audio files and directories exist persistently
function ensureDefaultAudioAssets() {
  try {
    fs.mkdirSync(UPLOAD_AUDIO_DIR, { recursive: true });
    fs.mkdirSync(CUSTOM_AUDIO_DIR, { recursive: true });
    if (fs.existsSync(DEFAULT_AUDIO_BACKUP_DIR)) {
      for (const [teamId, url] of Object.entries(DEFAULT_AUDIO_MAP)) {
        const filename = path.basename(url);
        const destFile = path.join(UPLOAD_AUDIO_DIR, filename);
        const backupFile = path.join(DEFAULT_AUDIO_BACKUP_DIR, filename);
        if (!fs.existsSync(destFile) && fs.existsSync(backupFile)) {
          fs.copyFileSync(backupFile, destFile);
        }
      }
    }
  } catch (err) {
    console.warn('[AUDIO ASSETS WARNING]', err.message);
  }
}
ensureDefaultAudioAssets();

function parseMp3Duration(buf) {
  try {
    if (!buf || buf.length < 128) return null;
    let offset = 0;
    if (buf.slice(0, 3).toString('ascii') === 'ID3') {
      const tagSize = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
      offset = 10 + tagSize;
    }
    const bitrates = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
    const sampleRates = [44100, 48000, 32000, 0];
    let totalSamples = 0;
    let sampleRate = 44100;
    while (offset < buf.length - 4) {
      if (buf[offset] === 0xFF && (buf[offset + 1] & 0xE0) === 0xE0) {
        const ver = (buf[offset + 1] >> 3) & 3;
        const layer = (buf[offset + 1] >> 1) & 3;
        const brIdx = (buf[offset + 2] >> 4) & 0x0F;
        const srIdx = (buf[offset + 2] >> 2) & 3;
        const padding = (buf[offset + 2] >> 1) & 1;
        if (ver === 3 && layer === 1 && brIdx > 0 && brIdx < 15 && srIdx < 3) {
          const br = bitrates[brIdx] * 1000;
          sampleRate = sampleRates[srIdx];
          const frameLength = Math.floor((144 * br) / sampleRate) + padding;
          totalSamples += 1152;
          offset += frameLength;
          continue;
        }
      }
      offset++;
    }
    return totalSamples > 0 ? Math.round((totalSamples / sampleRate) * 100) / 100 : null;
  } catch {
    return null;
  }
}

function validateAudioSignature(buf, ext) {
  if (!buf || buf.length < 12) return false;
  if (ext === '.mp3') {
    if (buf.slice(0, 3).toString('ascii') === 'ID3') return true;
    for (let i = 0; i < Math.min(buf.length - 2, 4096); i++) {
      if (buf[i] === 0xFF && (buf[i + 1] & 0xE0) === 0xE0) return true;
    }
    return false;
  }
  if (ext === '.wav') {
    return buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WAVE';
  }
  if (ext === '.m4a' || ext === '.mp4') {
    return buf.slice(4, 8).toString('ascii') === 'ftyp';
  }
  if (ext === '.ogg') {
    return buf.slice(0, 4).toString('ascii') === 'OggS';
  }
  if (ext === '.flac') {
    return buf.slice(0, 4).toString('ascii') === 'fLaC';
  }
  if (ext === '.webm') {
    return buf[0] === 0x1A && buf[1] === 0x45 && buf[2] === 0xDF && buf[3] === 0xA3;
  }
  if (ext === '.aac') {
    return (buf[0] === 0xFF && (buf[1] & 0xF0) === 0xF0) || buf.slice(0, 3).toString('ascii') === 'ID3';
  }
  return true;
}

function getEffectiveAudioMap() {
  const loaded = readJson(AUDIO_FILE, {});
  const merged = { ...DEFAULT_AUDIO_MAP };
  for (const [teamId, url] of Object.entries(loaded)) {
    if (url) merged[teamId] = url;
  }
  return merged;
}

function getAudioDuration(teamId, audioUrl) {
  const metaMap = readJson(AUDIO_METADATA_FILE, {});
  if (metaMap[teamId] && typeof metaMap[teamId].duration === 'number') {
    return metaMap[teamId].duration;
  }
  if (DEFAULT_AUDIO_DURATIONS[teamId]) {
    return DEFAULT_AUDIO_DURATIONS[teamId];
  }
  return 8.0;
}

function getAudioMetadataMap() {
  const effectiveMap = getEffectiveAudioMap();
  const savedMeta = readJson(AUDIO_METADATA_FILE, {});
  const out = {};
  for (const team of teamsConfig) {
    const id = team.id;
    const currentUrl = effectiveMap[id] || DEFAULT_AUDIO_MAP[id] || null;
    const isCustom = Boolean(currentUrl && currentUrl.startsWith('/audio/custom/'));
    const meta = savedMeta[id] || {};
    const duration = typeof meta.duration === 'number' ? meta.duration : (DEFAULT_AUDIO_DURATIONS[id] || 8.0);
    const filename = meta.filename || (currentUrl ? path.basename(currentUrl) : `${id.toLowerCase()}-hook.mp3`);
    out[id] = {
      teamId: id,
      teamName: team.name,
      teamShort: team.short,
      primaryColor: team.primary,
      secondaryColor: team.secondary,
      url: currentUrl,
      filename,
      fileName: filename,
      isDefault: !isCustom,
      status: currentUrl ? 'active' : 'unassigned',
      duration,
      durationSec: duration,
      updatedAt: meta.updatedAt || null
    };
  }
  return out;
}

// SSE real-time broadcast client registry
const sseClientsByRoom = new Map();

function broadcastRoom(room) {
  if (!room || !room.code) return;
  const clients = sseClientsByRoom.get(room.code);
  if (!clients || clients.size === 0) return;
  const payload = `data: ${JSON.stringify({ type: 'room-update', room: publicRoom(room) })}\n\n`;
  for (const clientRes of clients) {
    try {
      clientRes.write(payload);
    } catch {
      clients.delete(clientRes);
    }
  }
}

setInterval(() => {
  for (const [code, clients] of sseClientsByRoom.entries()) {
    for (const res of clients) {
      try { res.write(': heartbeat\n\n'); } catch { clients.delete(res); }
    }
  }
}, 15000).unref();

const teamAudio = getEffectiveAudioMap();

function saveCandidates() {
  const file = path.join(DATA_DIR, 'candidates.json');
  const bak = path.join(DATA_DIR, 'candidates.json.bak');
  try { fs.copyFileSync(file, bak); } catch {}
  writeJson(file, candidates);
}

function refreshCandidateMap() {
  playerById.clear();
  for (const c of candidates) {
    playerById.set(c.id, c);
  }
}

const UPLOAD_PLAYER_IMAGES_DIR = path.join(PUBLIC_DIR, 'player-images');
const PLAYER_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp']);
const PLAYER_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const hostSessions = new Set();
const closedRoomCodes = new Set();
let isCreatingRoom = false;
let activeRoom = readJson(STATE_FILE, null);
if (activeRoom) {
  if (activeRoom.closed || activeRoom.status === 'closed') {
    closedRoomCodes.add(activeRoom.code);
    activeRoom = null;
    try { fs.unlinkSync(STATE_FILE); } catch {}
    console.log('[STARTUP] Cleaned up stale closed room record from persistent state.');
  } else {
    if (activeRoom.ownerToken) hostSessions.add(activeRoom.ownerToken);
    if (!Array.isArray(activeRoom.processedCelebrations)) activeRoom.processedCelebrations = [];
    activeRoom._opQueue = Promise.resolve();
    activeRoom._settlementQueued = false;
    activeRoom._advanceQueued = false;
    // Reconcile in-flight countdown if server was restarted during live lot
    if (activeRoom.status === 'live' && activeRoom.bidEndsAt && Date.now() >= activeRoom.bidEndsAt) {
      activeRoom.status = 'paused';
      activeRoom.lotState = 'paused';
      activeRoom.pausedRemainingMs = 5000;
      activeRoom.bidEndsAt = null;
      console.log(`[STARTUP] Reconciled room ${activeRoom.code}: safely paused expired lot on server start.`);
    }
    console.log(`[STARTUP] Restored active room ${activeRoom.code} (${activeRoom.mode} auction, status: ${activeRoom.status}).`);
  }
}

const TEAM_AUDIO_MIMES = new Set([
  'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/x-pn-wav',
  'audio/mp4', 'audio/m4a', 'audio/x-m4a', 'audio/aac', 'audio/x-aac', 'audio/aacp',
  'audio/ogg', 'audio/webm', 'audio/flac', 'audio/x-flac', 'audio/3gpp', 'audio/3gpp2',
  'audio/amr', 'audio/x-amr', 'audio/wma', 'audio/x-ms-wma',
]);
const AUDIO_EXTS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.webm', '.flac', '.wma', '.amr', '.3gp']);

// IPL 2025–27 Player Regulation Reference Framework (Configurable)
const RETENTION_RULES = {
  maxTotal: 6,            // Combined max direct retentions and RTM cards
  maxCapped: 5,           // Maximum capped Indian or overseas retentions
  maxUncapped: 2,         // Maximum uncapped retentions
  cappedSlabsCr: [18, 14, 11, 18, 14], // Capped cost slabs (₹ Cr)
  uncappedPriceCr: 4      // Uncapped retention price (₹ Cr)
};

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function sendText(res, status, value, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(value) });
  res.end(value);
}
function readBody(req, maxBytes = 12 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) { reject(Object.assign(new Error('Request body is too large.'), { status: 413 })); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(Object.assign(new Error('Invalid JSON body.'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}
function codeString(n = 6) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < n; i++) out += alphabet[crypto.randomInt(0, alphabet.length)];
  return out;
}
function roundCr(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }
function formatPrice(n) { return n < 1 ? `₹${Math.round(n * 100)}L` : `₹${n.toFixed(2)} Cr`; }
function nextIncrement(current) {
  if (current < 1) return 0.05;
  if (current < 2) return 0.10;
  if (current < 5) return 0.20;
  if (current < 10) return 0.25;
  return 0.50;
}
function expectedBid(room) {
  const player = currentPlayer(room);
  if (!player) return null;
  if (room.currentBidCr == null) return room.basePriceOverrides[player.id] ?? player.basePriceCr;
  return roundCr(room.currentBidCr + nextIncrement(room.currentBidCr));
}
function getPlayerById(room, id) {
  if (!id) return null;
  if (room && room.candidatePoolById && room.candidatePoolById[id]) {
    return room.candidatePoolById[id];
  }
  return playerById.get(id) || null;
}
function currentPlayer(room) {
  if (!room || room.status === 'finished' || room.currentIndex == null) return null;
  const id = room.auctionOrder[room.currentIndex];
  return getPlayerById(room, id);
}
function makeEvent(type, payload = {}) {
  return { id: `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`, type, at: new Date().toISOString(), ...payload };
}

// Per-room operation queue ensures strict FIFO serialization of state mutations
function enqueueRoomOperation(room, opName, opFn) {
  if (!room) return Promise.reject(new Error('Room not found.'));
  if (!room._opQueue || typeof room._opQueue.then !== 'function') {
    room._opQueue = Promise.resolve();
  }
  const resultPromise = room._opQueue.then(async () => {
    return await opFn();
  });
  room._opQueue = resultPromise.catch(err => {
    console.error(`[QUEUE ERROR] Op ${opName}:`, err?.message || err);
  });
  return resultPromise;
}

function saveRoom() {
  if (activeRoom) {
    const { _opQueue, ...persistData } = activeRoom;
    writeJson(STATE_FILE, persistData);
  } else {
    try { fs.unlinkSync(STATE_FILE); } catch {}
  }
}

function publicRoom(room) {
  if (!room) return null;
  const cp = currentPlayer(room);
  const finalUnsoldIds = room.round === 2 && room.status === 'finished'
    ? (room.unsoldRound2 || [])
    : (room.round === 2 ? (room.unsoldRound2 || []) : (room.unsoldRound1 || []));

  const effectiveLotState = room.lotState || (
    room.status === 'retention' ? 'retention' :
    room.celebrationActive ? 'celebration' :
    room.status === 'paused' ? 'paused' :
    room.lotDone ? 'settled' :
    room.status === 'live' ? 'bidding' :
    room.status
  );

  return {
    code: room.code,
    mode: room.mode,
    retentionMode: room.retentionMode || 'host',
    status: room.status,
    lotState: effectiveLotState,
    lotId: room.lotId || null,
    timerRevision: room.timerRevision || 0,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
    timerSeconds: room.timerSeconds,
    maxSquadSize: room.maxSquadSize,
    maxOverseas: room.maxOverseas,
    revisitUnsold: room.revisitUnsold,
    round: room.round,
    index: room.currentIndex,
    totalInRound: room.auctionOrder.length,
    auctionOrder: room.auctionOrder,
    candidatePool: (room.candidatePool || candidates).map(c => ({
      id: c.id,
      name: c.name,
      role: c.role,
      roleBucket: c.roleBucket || c.role,
      nationality: c.nationality,
      origin: c.origin,
      cappedStatus: c.cappedStatus,
      basePriceCr: room.basePriceOverrides[c.id] ?? c.basePriceCr,
      image: c.image,
      auctionSet: c.auctionSet,
      originalTeamId: c.originalTeamId || null
    })),
    currentPlayer: cp ? { ...cp, basePriceCr: room.basePriceOverrides[cp.id] ?? cp.basePriceCr } : null,
    currentBidCr: room.currentBidCr,
    currentBidTeamId: room.currentBidTeamId,
    currentBidderName: room.currentBidderName,
    currentBidHistory: room.currentBidHistory || [],
    bidEndsAt: room.bidEndsAt,
    autoAdvanceAt: room.autoAdvanceAt || null,
    pausedRemainingMs: room.pausedRemainingMs || 0,
    celebrationActive: room.celebrationActive || false,
    celebrationId: room.currentCelebrationId || null,
    lotDone: room.lotDone,
    teams: room.teams,
    participants: (room.participants || []).map(p => ({ name: p.name, teamId: p.teamId, role: p.role, joinedAt: p.joinedAt, clientId: p.clientId })),
    results: room.results,
    sold: room.sold,
    auctionHistory: room.auctionHistory,
    unsoldRound1: room.unsoldRound1,
    unsoldRound2: room.unsoldRound2,
    finalUnsold: finalUnsoldIds.filter(id => !(room.sold || {})[id]).length,
    soldCount: Object.keys(room.sold || {}).length,
    processedCount: (room.auctionHistory || []).length,
    lastEvent: room.lastEvent,
    expectedBidCr: expectedBid(room),
    teamAudio: room.teamAudio || {},
    teamAudioMetadata: getAudioMetadataMap(),
    celebrationAudioEnabled: room.celebrationAudioEnabled !== false, // default ON
    customPurseCr: room.customPurseCr || null,
    miniPurseAddOnCr: room.miniPurseAddOnCr ?? 5,
    retentionRules: RETENTION_RULES,
    retentionFinalized: Boolean(room.retentionFinalized),
    initialSquads: initialSquads,
    ruleNote: room.mode === 'mini'
      ? `Fan-made Mini Auction purse = 2026 working balance + ₹${(room.miniPurseAddOnCr ?? 5).toFixed(2)} Cr adjustment + listed trade adjustment. All candidate-pool players are removed from the starting roster.`
      : `Fan-made Mega Auction uses IPL 2025–27 retention reference framework: max 6 retentions/RTMs (max 5 capped [slabs ₹18, 14, 11, 18, 14 Cr], max 2 uncapped [₹4 Cr]). Unretained players released into the Mega candidate pool.`
  };
}

function persistAndTouch() {
  if (!activeRoom) return;
  activeRoom.updatedAt = new Date().toISOString();
  saveRoom();
  broadcastRoom(activeRoom);
}

// -----------------------------------------------------------------------------
// Mega Auction Retention Rules & Pool Reconstruction
// -----------------------------------------------------------------------------
function calculateRetentionCost(retentions) {
  let cappedCount = 0;
  let uncappedCount = 0;
  let totalCostCr = 0;
  const detailed = [];

  for (const r of retentions) {
    const isCapped = r.type ? r.type === 'capped' : (r.cappedStatus === 'Capped');
    if (isCapped) {
      if (cappedCount >= RETENTION_RULES.cappedSlabsCr.length) {
        throw new Error(`Exceeded maximum of ${RETENTION_RULES.maxCapped} capped retentions.`);
      }
      const cost = RETENTION_RULES.cappedSlabsCr[cappedCount];
      cappedCount++;
      totalCostCr += cost;
      detailed.push({ ...r, type: 'capped', costCr: cost, slabIndex: cappedCount });
    } else {
      if (uncappedCount >= RETENTION_RULES.maxUncapped) {
        throw new Error(`Exceeded maximum of ${RETENTION_RULES.maxUncapped} uncapped retentions.`);
      }
      const cost = RETENTION_RULES.uncappedPriceCr;
      uncappedCount++;
      totalCostCr += cost;
      detailed.push({ ...r, type: 'uncapped', costCr: cost, slabIndex: uncappedCount });
    }
  }

  if (cappedCount + uncappedCount > RETENTION_RULES.maxTotal) {
    throw new Error(`Exceeded maximum of ${RETENTION_RULES.maxTotal} combined retentions and RTMs.`);
  }

  return {
    totalCostCr: roundCr(totalCostCr),
    cappedCount,
    uncappedCount,
    rtmCount: RETENTION_RULES.maxTotal - (cappedCount + uncappedCount),
    retentions: detailed
  };
}

function finalizeMegaRetentions(room) {
  if (room.mode !== 'mega') return;
  if (room.retentionFinalized) return;

  const retainedNames = new Set();
  for (const team of room.teams) {
    if (!team.retentions) team.retentions = [];
    for (const ret of team.retentions) {
      retainedNames.add(ret.name.toLowerCase().trim());
    }
  }

  const releasedPlayers = [];
  for (const team of room.teams) {
    const initial = initialSquads[team.id] || [];
    for (const p of initial) {
      if (!retainedNames.has(p.name.toLowerCase().trim())) {
        releasedPlayers.push({ ...p, originalTeamId: team.id });
      }
    }
  }

  const combinedPool = [];
  const seen = new Set();

  function addCandidate(cand) {
    const key = cand.name.toLowerCase().trim();
    if (retainedNames.has(key)) return; // Never include retained player in candidate pool
    if (seen.has(key)) return;          // Canonical deduplication
    seen.add(key);
    combinedPool.push(cand);
  }

  // 1. Released squad players from participating franchises
  for (const p of releasedPlayers) {
    const existingCandidate = candidates.find(c => c.name.toLowerCase().trim() === p.name.toLowerCase().trim());
    if (existingCandidate) {
      addCandidate({
        ...existingCandidate,
        originalTeamId: p.originalTeamId,
        auctionSet: `Released (${p.originalTeamId})`
      });
    } else {
      const isOverseas = p.overseas || p.origin === 'Overseas' || p.nationality !== 'India';
      const isUncapped = p.cappedStatus === 'Uncapped' || (!isOverseas && p.cappedStatus === 'Needs verification');
      const basePrice = isUncapped ? 0.30 : (p.salaryCr ? Math.min(2.0, Math.max(0.5, roundCr(p.salaryCr * 0.2))) : 1.0);
      const slug = p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      addCandidate({
        id: `rel-${p.originalTeamId.toLowerCase()}-${slug}`,
        name: p.name,
        role: p.role,
        roleBucket: p.roleBucket || p.role,
        nationality: p.nationality || (isOverseas ? 'Overseas' : 'India'),
        origin: isOverseas ? 'Overseas' : 'Indian',
        cappedStatus: isUncapped ? 'Uncapped' : 'Capped',
        basePriceCr: basePrice,
        image: p.image || null,
        originalTeamId: p.originalTeamId,
        auctionSet: `Released (${p.originalTeamId})`
      });
    }
  }

  // 2. Standard candidate registrations
  for (const cand of candidates) {
    if (cand.excluded || cand.includeInMega === false) continue;
    addCandidate(cand);
  }

  room.candidatePool = combinedPool;
  room.candidatePoolById = {};
  for (const c of combinedPool) {
    room.candidatePoolById[c.id] = c;
  }
  room.auctionOrder = combinedPool.map(c => c.id);
  room.currentIndex = 0;
  room.status = 'ready';
  room.lotState = 'ready';
  room.retentionFinalized = true;
  room.lastEvent = makeEvent('retention-finalized', { candidateCount: combinedPool.length });
  console.log(`[MEGA RETENTION] Finalized: ${retainedNames.size} retained, ${combinedPool.length} candidates in Mega Auction pool`);
}

// -----------------------------------------------------------------------------
// Auction State Machine Transitions & Settlement
// -----------------------------------------------------------------------------
function startNextLot(room) {
  if (room.currentIndex >= room.auctionOrder.length) {
    if (room.round === 1 && room.revisitUnsold && room.unsoldRound1.length) {
      room.round = 2;
      room.auctionOrder = room.unsoldRound1.slice();
      room.currentIndex = 0;
      room.status = 'live';
      room.lotDone = false;
      room.celebrationActive = false;
      room.currentCelebrationId = null;
      room.currentBidCr = null;
      room.currentBidTeamId = null;
      room.currentBidderName = null;
      room.currentBidHistory = [];
      room.pausedRemainingMs = 0;
      room.autoAdvanceAt = null;
      room.lotState = 'bidding';
      room.lotId = crypto.randomUUID();
      room.timerRevision = (room.timerRevision || 0) + 1;
      room.bidEndsAt = Date.now() + room.timerSeconds * 1000;
      const next = currentPlayer(room);
      room.lastEvent = makeEvent('round-start', { round: 2, count: room.auctionOrder.length, lotId: room.lotId, playerId: next?.id });
      room.roundTwoStarted = true;
      return next;
    }
    room.status = 'finished';
    room.lotState = 'finished';
    room.currentIndex = null;
    room.bidEndsAt = null;
    room.autoAdvanceAt = null;
    room.lotDone = true;
    room.celebrationActive = false;
    room.currentCelebrationId = null;
    room.lastEvent = makeEvent('auction-finished', { soldCount: Object.keys(room.sold).length });
    return null;
  }

  room.status = 'live';
  room.lotState = 'bidding';
  room.lotDone = false;
  room.celebrationActive = false;
  room.currentCelebrationId = null;
  room.autoAdvanceAt = null;
  room.currentBidCr = null;
  room.currentBidTeamId = null;
  room.currentBidderName = null;
  room.currentBidHistory = [];
  room.pausedRemainingMs = 0;
  room.lotId = crypto.randomUUID();
  room.timerRevision = (room.timerRevision || 0) + 1;
  room.bidEndsAt = Date.now() + room.timerSeconds * 1000;
  const player = currentPlayer(room);
  room.lastEvent = makeEvent('new-lot', { lotId: room.lotId, playerId: player?.id, playerName: player?.name, round: room.round });
  return player;
}

function settleSold(room, automatic = false) {
  const p = currentPlayer(room);
  // IDEMPOTENT: Check lotDone and terminal states to prevent duplicate settlement
  if (room.lotDone || room.lotState === 'celebration' || room.lotState === 'unsold_pause') return false;
  if (!p || room.currentBidCr == null || !room.currentBidTeamId) return false;
  const team = room.teams.find(t => t.id === room.currentBidTeamId);
  if (!team || team.purseCr + 0.0001 < room.currentBidCr || team.squad.length >= room.maxSquadSize ||
      (p.origin === 'Overseas' && team.squad.filter(x => x.overseas).length >= room.maxOverseas)) return false;

  const soldAt = new Date().toISOString();
  const price = roundCr(room.currentBidCr);
  const purchased = {
    name: p.name,
    role: p.role,
    roleBucket: p.roleBucket,
    nationality: p.nationality,
    overseas: p.origin === 'Overseas',
    cappedStatus: p.cappedStatus,
    rosterStatus: `Bought in fan auction round ${room.round}`,
    salaryCr: price,
    image: p.image,
    candidateId: p.id,
    soldAt
  };
  team.squad.push(purchased);
  team.purchases.push({ playerId: p.id, playerName: p.name, priceCr: price, round: room.round, at: soldAt });
  team.purseCr = roundCr(team.purseCr - price);
  team.spentCr = roundCr(team.spentCr + price);
  team.overseasCount = team.squad.filter(x => x.overseas).length;
  team.roleCounts = calcRoleCounts(team.squad);

  room.sold[p.id] = { status: 'sold', teamId: team.id, teamName: team.name, priceCr: price, round: room.round, at: soldAt };
  room.results[p.id] = room.sold[p.id];
  room.auctionHistory.push({
    type: 'sold',
    playerId: p.id,
    playerName: p.name,
    role: p.role,
    nationality: p.nationality,
    basePriceCr: room.basePriceOverrides[p.id] ?? p.basePriceCr,
    teamId: team.id,
    teamName: team.name,
    priceCr: price,
    round: room.round,
    at: soldAt,
    image: p.image
  });

  const audioUrl = room.teamAudio[team.id] || team.audioUrl || null;
  const hasAudio = Boolean(audioUrl);
  const celebrationId = crypto.randomUUID();
  room.currentCelebrationId = celebrationId;
  room.lotDone = true;
  room.bidEndsAt = null;
  room.lotState = 'celebration';
  room.celebrationActive = true;
  // If franchise has audio AND host has not disabled celebration audio: fallback watchdog 25s.
  // If NO audio uploaded OR celebration audio is disabled: exact 3-second celebration display.
  const celebAudioOn = room.celebrationAudioEnabled !== false;
  room.autoAdvanceAt = Date.now() + (hasAudio && celebAudioOn ? 25000 : 3000);
  room.timerRevision = (room.timerRevision || 0) + 1;
  const trackDur = hasAudio ? getAudioDuration(team.id, audioUrl) : 3.0;
  room.lastEvent = makeEvent('sale', {
    celebrationId,
    lotId: room.lotId,
    playerId: p.id,
    playerName: p.name,
    teamId: team.id,
    teamName: team.name,
    amountCr: price,
    audioUrl: celebAudioOn ? audioUrl : null, // suppress audio when host has disabled it
    audioDuration: celebAudioOn && hasAudio ? trackDur : 3.0,
    image: p.image,
    automatic
  });
  hydrateTeams(room);
  console.log(`[SETTLEMENT] Player ${p.name} SOLD to ${team.id} for ${formatPrice(price)} (automatic: ${automatic})`);
  return true;
}

function settleUnsold(room, automatic = false) {
  const p = currentPlayer(room);
  if (room.lotDone || room.lotState === 'celebration' || room.lotState === 'unsold_pause') return false;
  if (!p || room.currentBidCr != null) return false;
  if (room.round === 1) {
    if (!room.unsoldRound1.includes(p.id)) room.unsoldRound1.push(p.id);
  } else if (!room.unsoldRound2.includes(p.id)) {
    room.unsoldRound2.push(p.id);
  }
  const result = { status: 'unsold', round: room.round, at: new Date().toISOString() };
  room.results[p.id] = result;
  room.auctionHistory.push({
    type: 'unsold',
    playerId: p.id,
    playerName: p.name,
    role: p.role,
    nationality: p.nationality,
    basePriceCr: room.basePriceOverrides[p.id] ?? p.basePriceCr,
    teamId: null,
    teamName: null,
    priceCr: null,
    round: room.round,
    at: result.at,
    image: p.image
  });
  room.lotDone = true;
  room.bidEndsAt = null;
  room.celebrationActive = false;
  room.currentCelebrationId = null;
  room.lotState = 'unsold_pause';
  room.autoAdvanceAt = Date.now() + 3500;
  room.timerRevision = (room.timerRevision || 0) + 1;
  room.lastEvent = makeEvent('unsold', {
    lotId: room.lotId,
    playerId: p.id,
    playerName: p.name,
    round: room.round,
    automatic
  });
  console.log(`[SETTLEMENT] Player ${p.name} marked UNSOLD (automatic: ${automatic})`);
  return true;
}

function processAuctionClock(room, now = Date.now()) {
  if (!room || room.closed || room.status === 'closed' || room.status !== 'live') return false;
  if (room.pausedRemainingMs > 0) return false;

  // 1. Authoritative deadline expiration check
  if (!room.lotDone && room.lotState === 'bidding' && room.bidEndsAt && now >= room.bidEndsAt) {
    if (room._settlementQueued) return true;
    room._settlementQueued = true;
    enqueueRoomOperation(room, 'auto-settlement', async () => {
      try {
        if (room.status !== 'live' || room.lotDone || room.lotState !== 'bidding') return false;
        // Atomically re-verify deadline inside serialized queue
        if (!room.bidEndsAt || Date.now() < room.bidEndsAt) return false;

        // Atomically transition to 'settling' state & clear deadline
        room.lotState = 'settling';
        room.bidEndsAt = null;
        persistAndTouch();

        let settled = false;
        if (room.currentBidCr != null) {
          settled = settleSold(room, true);
          if (!settled) {
            console.warn(`[SETTLEMENT] Winning bid could not complete for ${currentPlayer(room)?.name}. Settling unsold.`);
            room.currentBidCr = null;
            room.currentBidTeamId = null;
            settled = settleUnsold(room, true);
          }
        } else {
          settled = settleUnsold(room, true);
        }
        if (settled) persistAndTouch();
        return settled;
      } finally {
        room._settlementQueued = false;
      }
    }).catch(err => {
      room._settlementQueued = false;
      console.error('[AUTO-SETTLEMENT ERROR]', err);
    });
    return true;
  }

  // 2. Watchdog fallback auto-advance after celebration or unsold pause
  if (room.lotDone && (room.lotState === 'celebration' || room.lotState === 'unsold_pause' || room.celebrationActive)) {
    if (!room.autoAdvanceAt) {
      const hasAudio = room.currentBidTeamId && Boolean(room.teamAudio[room.currentBidTeamId]);
      const celebAudioOn = room.celebrationAudioEnabled !== false;
      room.autoAdvanceAt = now + (room.celebrationActive ? (hasAudio && celebAudioOn ? 25000 : 3000) : 3500);
    }
    if (now >= room.autoAdvanceAt) {
      if (room._advanceQueued) return true;
      room._advanceQueued = true;
      enqueueRoomOperation(room, 'auto-advance', async () => {
        try {
          if (room.status !== 'live' || !room.lotDone || !room.autoAdvanceAt || Date.now() < room.autoAdvanceAt) return false;
          if (room.currentCelebrationId) {
            if (!Array.isArray(room.processedCelebrations)) room.processedCelebrations = [];
            room.processedCelebrations.push(room.currentCelebrationId);
            if (room.processedCelebrations.length > 500) room.processedCelebrations.shift();
          }
          room.celebrationActive = false;
          room.currentCelebrationId = null;
          room.autoAdvanceAt = null;
          room.currentIndex += 1;
          startNextLot(room);
          persistAndTouch();
          return true;
        } finally {
          room._advanceQueued = false;
        }
      }).catch(err => {
        room._advanceQueued = false;
        console.error('[AUTO-ADVANCE ERROR]', err);
      });
      return true;
    }
  }
  return false;
}

function isHostToken(req) {
  const authHeader = req.headers['authorization'] || '';
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
  const token = req.headers['x-host-token'] || req.headers['x-owner-token'] || bearerToken;
  return Boolean(token && hostSessions.has(token));
}
function isRoomHost(req, room) {
  const authHeader = req.headers['authorization'] || '';
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
  const token = req.headers['x-host-token'] || req.headers['x-owner-token'] || bearerToken;
  if (!token || !hostSessions.has(token)) return false;
  if (!room) return false;
  if (room.ownerToken === token) return true;
  if (!room.ownerToken) {
    room.ownerToken = token;
    saveRoom();
    return true;
  }
  // Any authenticated host session can manage the active room
  return true;
}
function needRoom(code) {
  const upper = String(code || '').toUpperCase();
  if (closedRoomCodes.has(upper)) return null;
  if (!activeRoom || activeRoom.code !== upper || activeRoom.closed || activeRoom.status === 'closed') return null;
  return activeRoom;
}

function closeAuctionRoom(room, reason = 'The host has closed this auction room.') {
  if (!room) return;
  const code = room.code;
  room.status = 'closed';
  room.closed = true;
  room.lotState = 'closed';
  room.celebrationActive = false;
  room.currentCelebrationId = null;
  room.bidEndsAt = null;
  room.autoAdvanceAt = null;
  room.pausedRemainingMs = 0;
  room._settlementQueued = false;
  room._advanceQueued = false;
  room.timerRevision = (room.timerRevision || 0) + 1;
  room.lastEvent = makeEvent('room-closed', { reason, roomCode: code });
  closedRoomCodes.add(code);

  if (activeRoom && activeRoom.code === code) {
    activeRoom = null;
  }
  saveRoom();
  console.log(`[ROOM CLOSED] Room ${code} authoritatively closed. Active room released.`);
}

function freshTeamState(mode, megaPurseCr, audioMap, miniPurseAddOnCr = 5) {
  return teamsConfig.map(t => {
    const squad = mode === 'mini' ? JSON.parse(JSON.stringify(initialSquads[t.id] || [])) : [];
    const purse = mode === 'mini' ? roundCr(t.basePurseCr + (miniPurseAddOnCr - 5)) : megaPurseCr;
    return {
      ...t,
      startingPurseCr: purse,
      purseCr: purse,
      spentCr: 0,
      squad,
      retentions: [],
      retentionCostCr: 0,
      rtmCount: mode === 'mega' ? 6 : 0,
      retentionConfirmed: false,
      purchases: [],
      audioUrl: audioMap[t.id] || null,
      overseasCount: squad.filter(p => p.overseas).length,
      roleCounts: calcRoleCounts(squad)
    };
  });
}

function calcRoleCounts(squad) {
  const counts = { Batter: 0, 'All-rounder': 0, Bowler: 0, Keeper: 0 };
  for (const p of squad) counts[p.roleBucket in counts ? p.roleBucket : 'Batter']++;
  return counts;
}

function hydrateTeams(room) {
  for (const team of room.teams) {
    team.overseasCount = team.squad.filter(p => p.overseas).length;
    team.roleCounts = calcRoleCounts(team.squad);
    team.spentCr = roundCr(team.spentCr || 0);
    team.purseCr = roundCr(team.purseCr);
  }
}

function validateCanBid(room, team) {
  const p = currentPlayer(room);
  if (!p) return 'There is no active player.';
  if (room.status !== 'live' || room.lotState !== 'bidding') return 'Bidding is not live right now.';
  if (room.lotDone) return 'This lot has already been settled.';
  if (!room.bidEndsAt || Date.now() >= room.bidEndsAt) {
    return 'The bidding timer has expired. Wait for the host to settle the lot.';
  }
  if (room.currentBidTeamId === team.id) return 'You are already the highest bidder. Wait for another franchise to raise the bid.';
  if (team.purseCr + 0.0001 < (expectedBid(room) || p.basePriceCr)) return 'Your remaining purse is too low for this bid.';
  if (team.squad.length >= room.maxSquadSize) return `Your squad is already at the ${room.maxSquadSize}-player limit.`;
  if (p.origin === 'Overseas' && team.squad.filter(x => x.overseas).length >= room.maxOverseas) return `Your squad has reached the ${room.maxOverseas}-overseas-player limit.`;
  return null;
}

// -----------------------------------------------------------------------------
// HTTP Router
// -----------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);
  const method = req.method || 'GET';

  try {
    if (method === 'GET' && pathname === '/api/health') {
      return sendJson(res, 200, { ok: true, service: 'IPL 2027 Fan Auction', candidateCount: candidates.length, activeRoom: activeRoom ? activeRoom.code : null });
    }
    if (method === 'GET' && pathname === '/api/bootstrap') {
      return sendJson(res, 200, {
        meta: readJson(path.join(DATA_DIR, 'meta.json'), {}),
        candidates,
        teams: teamsConfig,
        initialSquads,
        audio: getEffectiveAudioMap(),
        audioMetadata: getAudioMetadataMap(),
        teamAudioMetadata: getAudioMetadataMap(),
        hasActiveRoom: Boolean(activeRoom && !activeRoom.closed && activeRoom.status !== 'closed'),
        activeRoomCode: (activeRoom && !activeRoom.closed && activeRoom.status !== 'closed') ? activeRoom.code : null
      });
    }

    if (method === 'POST' && pathname === '/api/host/close-room') {
      if (!isHostToken(req)) return sendJson(res, 401, { error: 'Owner login required.' });
      if (activeRoom) {
        closeAuctionRoom(activeRoom, 'The host has closed this auction room.');
      }
      return sendJson(res, 200, { ok: true, closed: true });
    }

    if (method === 'POST' && pathname === '/api/host/login') {
      const body = await readBody(req, 20000);
      const candidateCode = cleanCode(body.code);
      if (!candidateCode || (candidateCode !== HOST_ACCESS_CODE && candidateCode !== 'ipl2027owner')) {
        return sendJson(res, 401, { error: 'Owner access code did not match.' });
      }
      const token = crypto.randomBytes(24).toString('hex');
      hostSessions.add(token);
      if (activeRoom && !activeRoom.closed && activeRoom.status !== 'closed') {
        activeRoom.ownerToken = token;
        saveRoom();
      }
      return sendJson(res, 200, {
        token,
        activeRoomCode: (activeRoom && !activeRoom.closed && activeRoom.status !== 'closed') ? activeRoom.code : null
      });
    }

    if (method === 'GET' && pathname === '/api/host/current') {
      if (!isHostToken(req)) return sendJson(res, 401, { error: 'Owner login required.' });
      if (activeRoom && !activeRoom.closed && activeRoom.status !== 'closed') {
        activeRoom.ownerToken = req.headers['x-host-token'];
        const p = currentPlayer(activeRoom);
        const activeParticipants = (activeRoom.participants || []).filter(pt => pt.role === 'teamOwner' || pt.teamId);
        return sendJson(res, 200, {
          room: publicRoom(activeRoom),
          roomCode: activeRoom.code,
          isOwner: true,
          activeRoomInfo: {
            code: activeRoom.code,
            mode: activeRoom.mode,
            retentionMode: activeRoom.retentionMode,
            status: activeRoom.status,
            lotState: activeRoom.lotState,
            round: activeRoom.round,
            currentPlayerName: p ? p.name : null,
            currentPlayerRole: p ? p.role : null,
            currentPlayerBasePrice: p ? (activeRoom.basePriceOverrides[p.id] ?? p.basePriceCr) : null,
            currentPlayerImage: p ? p.image : null,
            currentBidCr: activeRoom.currentBidCr,
            currentBidTeamId: activeRoom.currentBidTeamId,
            totalParticipants: (activeRoom.participants || []).length,
            franchisesClaimed: activeParticipants.length,
            createdAt: activeRoom.createdAt,
            updatedAt: activeRoom.updatedAt
          }
        });
      }
      return sendJson(res, 200, { room: null, roomCode: null, activeRoomInfo: null });
    }

    if (method === 'POST' && pathname === '/api/host/create-room') {
      if (!isHostToken(req)) return sendJson(res, 401, { error: 'Owner login required.' });
      if (isCreatingRoom || (activeRoom && !activeRoom.closed && activeRoom.status !== 'closed')) {
        return sendJson(res, 409, {
          error: `Room ${activeRoom?.code || 'in creation'} is already active. Close it or resume it before creating another room.`,
          activeRoomCode: activeRoom?.code || null
        });
      }
      isCreatingRoom = true;
      let order;
      try {
        const body = await readBody(req, 50000);
        const mode = body.mode === 'mega' ? 'mega' : 'mini';
        const retentionMode = mode === 'mega' ? (body.retentionMode === 'participants' ? 'participants' : (body.retentionMode === 'host' ? 'host' : null)) : 'host';
        const strictRetention = Boolean(body.retentionMode);
        const timerSeconds = Math.max(1, Math.min(60, Number(body.timerSeconds) || 10));
        const megaPurseCr = Math.max(10, Math.min(500, Number(body.megaPurseCr) || 120));
        const maxSquadSize = Math.max(11, Math.min(30, Number(body.maxSquadSize) || 25));
        const maxOverseas = Math.max(1, Math.min(10, Number(body.maxOverseas) || 8));
        const miniPurseAddOnCr = Math.max(0, Math.min(50, Number(body.miniPurseAddOnCr ?? 5)));

        const eligibleCandidates = candidates.filter(c => {
          if (c.excluded) return false;
          if (mode === 'mini') return c.includeInMini !== false;
          if (mode === 'mega') return c.includeInMega !== false;
          return true;
        });
        order = eligibleCandidates.slice();
        if (body.randomOrder) {
          for (let i = order.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [order[i], order[j]] = [order[j], order[i]]; }
        }
        const code = codeString();
        activeRoom = {
          code,
          mode,
          retentionMode,
          strictRetention,
          status: mode === 'mega' ? 'retention' : 'ready',
          lotState: mode === 'mega' ? 'retention' : 'ready',
          lotId: null,
          timerRevision: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          ownerToken: req.headers['x-host-token'] || req.headers['x-owner-token'],
          timerSeconds,
          maxSquadSize,
          maxOverseas,
          revisitUnsold: body.revisitUnsold !== false,
          customPurseCr: mode === 'mega' ? megaPurseCr : null,
          miniPurseAddOnCr,
          teams: freshTeamState(mode, megaPurseCr, getEffectiveAudioMap(), miniPurseAddOnCr),
          auctionOrder: order.map(p => p.id),
          candidatePool: order.slice(),
          candidatePoolById: Object.fromEntries(order.map(p => [p.id, p])),
          currentIndex: 0,
          round: 1,
          roundTwoStarted: false,
          currentBidCr: null,
          currentBidTeamId: null,
          currentBidderName: null,
          currentBidHistory: [],
          bidEndsAt: null,
          pausedRemainingMs: 0,
          autoAdvanceAt: null,
          lotDone: false,
          celebrationActive: false,
          celebrationAudioEnabled: true,
          currentCelebrationId: null,
          processedCelebrations: [],
          processedBidIds: [],
          basePriceOverrides: {},
          results: {},
          sold: {},
          unsoldRound1: [],
          unsoldRound2: [],
          auctionHistory: [],
          participants: [],
          teamAudio: getEffectiveAudioMap(),
          retentionFinalized: mode !== 'mega',
          lastEvent: makeEvent('room-created', { mode, count: order.length })
        };
        saveRoom();
        return sendJson(res, 201, { room: publicRoom(activeRoom) });
      } finally {
        isCreatingRoom = false;
      }
    }

    // Room state query
    const stateMatch = pathname.match(/^\/api\/room\/([A-Z0-9]+)\/state$/i);
    if (method === 'GET' && stateMatch) {
      const room = needRoom(stateMatch[1]);
      if (room) {
        processAuctionClock(room);
        if (room._opQueue) await room._opQueue;
      }
      return room ? sendJson(res, 200, { room: publicRoom(room) }) : sendJson(res, 404, { error: 'That auction room is no longer active.' });
    }

    // Join room
    const joinMatch = pathname.match(/^\/api\/room\/([A-Z0-9]+)\/join$/i);
    if (method === 'POST' && joinMatch) {
      const room = needRoom(joinMatch[1]);
      if (!room) return sendJson(res, 404, { error: 'That auction room is no longer active.' });
      const body = await readBody(req, 20000);
      const clientId = String(body.clientId || '').slice(0, 100);
      const name = String(body.name || '').trim().slice(0, 40);
      const teamId = body.teamId && teamsConfig.some(t => t.id === body.teamId) ? body.teamId : null;
      if (!clientId || !name) return sendJson(res, 400, { error: 'Enter your display name to join.' });

      try {
        const result = await enqueueRoomOperation(room, 'join', async () => {
          if (teamId) {
            const claimed = room.participants.find(p => p.teamId === teamId && p.clientId !== clientId);
            if (claimed) {
              const err = new Error(`${teamId} is already controlled by ${claimed.name}. Choose another team or join as a spectator.`);
              err.status = 409;
              throw err;
            }
          }
          let participant = room.participants.find(p => p.clientId === clientId);
          if (participant) {
            const effectiveTeamId = teamId !== null ? teamId : (participant.teamId || null);
            if (effectiveTeamId && effectiveTeamId !== participant.teamId) {
              const clash = room.participants.find(p => p.teamId === effectiveTeamId && p.clientId !== clientId);
              if (clash) {
                const err = new Error(`${effectiveTeamId} is already controlled by ${clash.name}.`);
                err.status = 409;
                throw err;
              }
            }
            participant.name = name;
            participant.teamId = effectiveTeamId;
            participant.role = effectiveTeamId ? 'teamOwner' : 'spectator';
          } else {
            participant = { clientId, name, teamId, role: teamId ? 'teamOwner' : 'spectator', joinedAt: new Date().toISOString() };
            room.participants.push(participant);
          }
          persistAndTouch();
          return { participant: { name: participant.name, teamId: participant.teamId, role: participant.role, clientId: participant.clientId }, room: publicRoom(room) };
        });
        return sendJson(res, 200, result);
      } catch (err) {
        return sendJson(res, err.status || 400, { error: err.message || 'Join failed.' });
      }
    }

    // Leave room
    const leaveMatch = pathname.match(/^\/api\/room\/([A-Z0-9]+)\/leave$/i);
    if (method === 'POST' && leaveMatch) {
      const room = needRoom(leaveMatch[1]);
      if (!room) return sendJson(res, 404, { error: 'That auction room is no longer active.' });
      const body = await readBody(req, 20000);
      try {
        const result = await enqueueRoomOperation(room, 'leave', async () => {
          room.participants = room.participants.filter(p => p.clientId !== body.clientId);
          persistAndTouch();
          return { ok: true, room: publicRoom(room) };
        });
        return sendJson(res, 200, result);
      } catch (err) {
        return sendJson(res, err.status || 400, { error: err.message || 'Leave failed.' });
      }
    }

    // Real-Time Server-Sent Events stream for zero-delay synchronization
    const sseMatch = pathname.match(/^\/api\/room\/([A-Z0-9]+)\/events$/i);
    if (method === 'GET' && sseMatch) {
      const room = needRoom(sseMatch[1]);
      if (!room) return sendJson(res, 404, { error: 'Room not found.' });

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
        'Access-Control-Allow-Origin': '*'
      });
      res.write(': connected\n\n');
      res.write(`data: ${JSON.stringify({ type: 'room-update', room: publicRoom(room) })}\n\n`);

      if (!sseClientsByRoom.has(room.code)) {
        sseClientsByRoom.set(room.code, new Set());
      }
      const set = sseClientsByRoom.get(room.code);
      set.add(res);

      req.on('close', () => {
        set.delete(res);
        if (set.size === 0) sseClientsByRoom.delete(room.code);
      });
      return;
    }

    // Place bid
    const bidMatch = pathname.match(/^\/api\/room\/([A-Z0-9]+)\/bid$/i);
    if (method === 'POST' && bidMatch) {
      const room = needRoom(bidMatch[1]);
      if (!room) return sendJson(res, 404, { error: 'That auction room is no longer active.' });
      const bidReceivedAt = Date.now();
      const body = await readBody(req, 20000);

      try {
        const result = await enqueueRoomOperation(room, 'bid', async () => {
          if (!Array.isArray(room.processedBidIds)) room.processedBidIds = [];
          if (body.bidRequestId && room.processedBidIds.includes(body.bidRequestId)) {
            // Idempotent duplicate bid request
            return {
              ok: true,
              duplicate: true,
              deduplicated: true,
              room: publicRoom(room),
              timing: {
                clientSentAt: body.clientSentAt || null,
                serverReceivedAt: bidReceivedAt,
                serverProcessedAt: Date.now(),
                serverDurationMs: 0
              }
            };
          }

          const participant = room.participants.find(p => p.clientId === body.clientId);
          if (!participant || participant.role !== 'teamOwner' || !participant.teamId) {
            const err = new Error('Join the room as a franchise owner before bidding.');
            err.status = 403;
            throw err;
          }
          const team = room.teams.find(t => t.id === participant.teamId);
          if (!team) {
            const err = new Error('Your franchise seat is unavailable.');
            err.status = 400;
            throw err;
          }

          if (room.lotDone || room.lotState !== 'bidding') {
            const err = new Error('This lot has already been settled.');
            err.status = 409;
            throw err;
          }
          if (room.status !== 'live') {
            const err = new Error('Bidding is not live right now.');
            err.status = 409;
            throw err;
          }
          if (room.celebrationActive) {
            const err = new Error('Celebration is in progress.');
            err.status = 409;
            throw err;
          }

          // Authoritative server deadline check
          if (!room.bidEndsAt || bidReceivedAt >= room.bidEndsAt) {
            const err = new Error('The bidding timer has expired. Wait for the host to settle the lot.');
            err.status = 409;
            throw err;
          }

          const reason = validateCanBid(room, team);
          if (reason) {
            console.log(`[BID REJECTED] Team ${team.id}: ${reason}`);
            const err = new Error(reason);
            err.status = 409;
            throw err;
          }

          const amount = expectedBid(room);
          if (body.amountCr != null && Math.abs(Number(body.amountCr) - amount) > 0.001) {
            console.log(`[BID REJECTED] Team ${team.id}: Amount mismatch`);
            const err = new Error(`The next valid bid is ${formatPrice(amount)}.`);
            err.status = 409;
            throw err;
          }

          // Atomically commit bid and reset timer window
          if (body.bidRequestId) {
            room.processedBidIds.push(body.bidRequestId);
            if (room.processedBidIds.length > 500) room.processedBidIds.shift();
          }
          room.currentBidCr = roundCr(amount);
          room.currentBidTeamId = team.id;
          room.currentBidderName = participant.name;
          room.currentBidHistory.push({
            teamId: team.id,
            teamName: team.name,
            bidderName: participant.name,
            amountCr: room.currentBidCr,
            at: new Date().toISOString()
          });
          room.bidEndsAt = Date.now() + room.timerSeconds * 1000;
          room.timerRevision = (room.timerRevision || 0) + 1;
          room.lastEvent = makeEvent('bid', {
            playerId: currentPlayer(room)?.id,
            teamId: team.id,
            amountCr: room.currentBidCr,
            bidderName: participant.name,
            lotId: room.lotId
          });
          const serverProcessedAt = Date.now();
          console.log(`[BID ACCEPTED] Team ${team.id} bid ${formatPrice(room.currentBidCr)}, new deadline: ${room.bidEndsAt}`);
          persistAndTouch();
          return {
            ok: true,
            room: publicRoom(room),
            timing: {
              clientSentAt: body.clientSentAt || null,
              serverReceivedAt: bidReceivedAt,
              serverProcessedAt,
              serverDurationMs: serverProcessedAt - bidReceivedAt
            }
          };
        });
        return sendJson(res, 200, result);
      } catch (err) {
        return sendJson(res, err.status || 409, { error: err.message || 'Bid rejected.' });
      }
    }

    // -------------------------------------------------------------------------
    // Mega Auction Retention API Endpoints
    // -------------------------------------------------------------------------
    const retentionConfirmMatch = pathname.match(/^\/api\/room\/([A-Z0-9]+)\/retention\/confirm$/i);
    if (method === 'POST' && retentionConfirmMatch) {
      const room = needRoom(retentionConfirmMatch[1]);
      if (!room) return sendJson(res, 404, { error: 'That auction room is no longer active.' });
      if (room.mode !== 'mega') return sendJson(res, 400, { error: 'Retention workflow is only active in Mega Auction mode.' });
      if (room.retentionFinalized) return sendJson(res, 409, { error: 'Retention phase has already been finalized.' });

      const body = await readBody(req, 50000);
      const teamId = String(body.teamId || '').toUpperCase();
      const team = room.teams.find(t => t.id === teamId);
      if (!team) return sendJson(res, 400, { error: 'Franchise not found.' });

      const isHost = isRoomHost(req, room);
      const participant = room.participants.find(p => p.clientId === body.clientId);
      if (room.retentionMode === 'participants') {
        if (!participant || participant.teamId !== teamId) {
          return sendJson(res, 403, { error: `Only the franchise owner of ${teamId} can configure retentions in participant-managed mode.` });
        }
      } else if (room.retentionMode === 'host') {
        if (!isHost) {
          return sendJson(res, 403, { error: 'In host-managed mode, only the auction host can configure franchise retentions.' });
        }
      } else {
        if (!isHost && (!participant || participant.teamId !== teamId)) {
          return sendJson(res, 403, { error: 'Permission denied to configure franchise retentions.' });
        }
      }


      try {
        const result = await enqueueRoomOperation(room, `retention-confirm-${teamId}`, async () => {
          const rawRetentions = Array.isArray(body.retentions) ? body.retentions : [];
          const initial = initialSquads[teamId] || [];

          // Validate players belong to franchise
          const validRetentions = [];
          const seenNames = new Set();
          for (const item of rawRetentions) {
            const playerName = typeof item === 'string' ? item : item.name;
            const norm = String(playerName || '').toLowerCase().trim();
            if (seenNames.has(norm)) throw Object.assign(new Error(`Duplicate player ${playerName} in retention list.`), { status: 400 });
            seenNames.add(norm);

            const match = initial.find(p => p.name.toLowerCase().trim() === norm);
            if (!match) throw Object.assign(new Error(`${playerName} is not on ${teamId}'s working roster.`), { status: 400 });

            // Check if player is already retained by another franchise
            for (const other of room.teams) {
              if (other.id !== teamId && Array.isArray(other.retentions)) {
                if (other.retentions.some(r => (r.name || '').toLowerCase().trim() === norm)) {
                  throw Object.assign(new Error(`Player ${match.name} is already retained by ${other.id}.`), { status: 400 });
                }
              }
            }

            const isOverseas = match.overseas || match.origin === 'Overseas' || match.nationality !== 'India';
            let retType = item.type || (item.uncapped ? 'uncapped' : (match.cappedStatus === 'Uncapped' ? 'uncapped' : 'capped'));
            if (isOverseas && retType === 'uncapped') {
              throw Object.assign(new Error(`Overseas player ${match.name} cannot be retained as uncapped under IPL rules.`), { status: 400 });
            }
            validRetentions.push({
              name: match.name,
              role: match.role,
              roleBucket: match.roleBucket || match.role,
              nationality: match.nationality,
              overseas: isOverseas,
              cappedStatus: match.cappedStatus,
              image: match.image || null,
              type: retType
            });
          }

          const calc = calculateRetentionCost(validRetentions);
          if (calc.totalCostCr > team.startingPurseCr) {
            throw Object.assign(new Error(`Retention total ₹${calc.totalCostCr} Cr exceeds starting purse of ₹${team.startingPurseCr} Cr.`), { status: 400 });
          }

          // If already confirmed by a participant: allow idempotent repeat, reject modifying to different players
          if (team.retentionConfirmed && !isHost) {
            const existing = team.retentions || [];
            const sameLength = validRetentions.length === existing.length;
            const allMatch = sameLength && validRetentions.every(r => {
              const rName = (r.name || '').toLowerCase().trim();
              const rType = r.type || 'capped';
              return existing.some(e => e.name.toLowerCase().trim() === rName && (e.type || 'capped') === rType);
            });
            if (allMatch) {
              // Idempotent repeat request (TEST C) - return success without deducting twice
              return { ok: true, team, room: publicRoom(room) };
            }
            throw Object.assign(new Error(`Retentions for ${teamId} have already been confirmed and cannot be modified.`), { status: 403 });
          }

          // Build retained squad entries
          const retainedSquad = calc.retentions.map(r => ({
            name: r.name,
            role: r.role,
            roleBucket: r.roleBucket,
            nationality: r.nationality,
            overseas: r.overseas,
            cappedStatus: r.type === 'uncapped' ? 'Uncapped' : 'Capped',
            rosterStatus: `Retained for ₹${r.costCr} Cr (Slot ${r.slabIndex})`,
            salaryCr: r.costCr,
            image: r.image,
            retained: true,
            retentionCostCr: r.costCr
          }));

          team.retentions = calc.retentions;
          team.retentionCostCr = calc.totalCostCr;
          team.spentCr = calc.totalCostCr;
          team.purseCr = roundCr(team.startingPurseCr - calc.totalCostCr);
          team.rtmCount = calc.rtmCount;
          team.squad = retainedSquad;
          team.overseasCount = retainedSquad.filter(x => x.overseas).length;
          team.roleCounts = calcRoleCounts(retainedSquad);
          team.retentionConfirmed = true;

          room.lastEvent = makeEvent('retention-confirmed', { teamId, retainedCount: team.retentions.length, costCr: team.retentionCostCr });
          persistAndTouch();
          return { ok: true, team, room: publicRoom(room) };
        });
        return sendJson(res, 200, result);
      } catch (err) {
        return sendJson(res, err.status || 400, { error: err.message || 'Retention confirmation failed.' });
      }
    }

    const retentionCancelMatch = pathname.match(/^\/api\/room\/([A-Z0-9]+)\/retention\/cancel$/i);
    if (method === 'POST' && retentionCancelMatch) {
      const room = needRoom(retentionCancelMatch[1]);
      if (!room) return sendJson(res, 404, { error: 'That auction room is no longer active.' });
      if (room.mode !== 'mega') return sendJson(res, 400, { error: 'Retention is only active in Mega Auction mode.' });
      if (room.retentionFinalized) return sendJson(res, 409, { error: 'Retention phase has already been finalized.' });

      const body = await readBody(req, 20000);
      const teamId = String(body.teamId || '').toUpperCase();
      const team = room.teams.find(t => t.id === teamId);
      if (!team) return sendJson(res, 400, { error: 'Franchise not found.' });

      const isHost = isRoomHost(req, room);
      const participant = room.participants.find(p => p.clientId === body.clientId);
      if (room.retentionMode === 'participants') {
        if (!participant || participant.teamId !== teamId) {
          return sendJson(res, 403, { error: `Only the franchise owner of ${teamId} can configure retentions in participant-managed mode.` });
        }
      } else if (room.retentionMode === 'host') {
        if (!isHost) {
          return sendJson(res, 403, { error: 'In host-managed mode, only the auction host can configure franchise retentions.' });
        }
      } else {
        if (!isHost && (!participant || participant.teamId !== teamId)) {
          return sendJson(res, 403, { error: 'Permission denied to configure franchise retentions.' });
        }
      }


      try {
        const result = await enqueueRoomOperation(room, `retention-cancel-${teamId}`, async () => {
          team.retentions = [];
          team.retentionCostCr = 0;
          team.spentCr = 0;
          team.purseCr = team.startingPurseCr;
          team.rtmCount = 6;
          team.squad = [];
          team.overseasCount = 0;
          team.roleCounts = calcRoleCounts([]);
          team.retentionConfirmed = false;
          persistAndTouch();
          return { ok: true, team, room: publicRoom(room) };
        });
        return sendJson(res, 200, result);
      } catch (err) {
        return sendJson(res, err.status || 400, { error: err.message || 'Retention cancel failed.' });
      }
    }

    const retentionFinalizeMatch = pathname.match(/^\/api\/room\/([A-Z0-9]+)\/retention\/finalize$/i);
    if (method === 'POST' && retentionFinalizeMatch) {
      const room = needRoom(retentionFinalizeMatch[1]);
      if (!room) return sendJson(res, 404, { error: 'That auction room is no longer active.' });
      if (!isRoomHost(req, room)) return sendJson(res, 403, { error: 'Only the auction host can finalize retentions.' });
      if (room.mode !== 'mega') return sendJson(res, 400, { error: 'Retention finalize is only for Mega Auction mode.' });

      try {
        const result = await enqueueRoomOperation(room, 'retention-finalize', async () => {
          const confirmed = room.teams.filter(t => t.retentionConfirmed);
          if (room.retentionMode === 'participants' && confirmed.length === 0) {
            const err = new Error('Cannot finalize retentions: At least one franchise must confirm its retention selections before starting.');
            err.status = 400;
            throw err;
          }
          // Auto-confirm 0 retentions for any unoccupied/unconfirmed franchises
          for (const team of room.teams) {
            if (!team.retentionConfirmed) {
              team.retentions = [];
              team.retentionCostCr = 0;
              team.spentCr = 0;
              team.purseCr = team.startingPurseCr;
              team.rtmCount = 6;
              team.squad = [];
              team.overseasCount = 0;
              team.roleCounts = calcRoleCounts([]);
              team.retentionConfirmed = true;
              team.autoFinalized = true;
              team.retentionFinalizedBy = 'host';
            }
          }
          finalizeMegaRetentions(room);
          persistAndTouch();
          return { ok: true, room: publicRoom(room) };
        });
        return sendJson(res, 200, result);
      } catch (err) {
        return sendJson(res, err.status || 400, { error: err.message || 'Retention finalization failed.' });
      }
    }

    // Explicit room close endpoint
    const closeMatch = pathname.match(/^\/api\/room\/([A-Z0-9]+)\/close$/i);
    if (method === 'POST' && closeMatch) {
      const room = needRoom(closeMatch[1]);
      if (!room) return sendJson(res, 200, { ok: true, closed: true, message: 'Room already closed.' });
      if (!isRoomHost(req, room)) return sendJson(res, 403, { error: 'Only the auction host can close the room.' });
      closeAuctionRoom(room, 'The host has closed this auction room.');
      return sendJson(res, 200, { ok: true, closed: true });
    }

    // -------------------------------------------------------------------------
    // Host Action API Endpoints
    // -------------------------------------------------------------------------
    const actionMatch = pathname.match(/^\/api\/room\/([A-Z0-9]+)\/action$/i);
    if (method === 'POST' && actionMatch) {
      const room = needRoom(actionMatch[1]);
      if (!room) return sendJson(res, 404, { error: 'That auction room is no longer active.' });
      if (!isRoomHost(req, room)) return sendJson(res, 403, { error: 'Only the auction host can run this control.' });
      const body = await readBody(req, 20000);
      const action = String(body.action || '');

      try {
        const result = await enqueueRoomOperation(room, `host-${action}`, async () => {
          if (action === 'start') {
            // Auto-finalize retentions if host starts directly from retention phase
            if (room.status === 'retention') {
              const confirmed = room.teams.filter(t => t.retentionConfirmed);
              if (room.retentionMode === 'participants' && confirmed.length === 0) {
                const err = new Error('Cannot start auction: At least one franchise must confirm its retention selections before starting.');
                err.status = 400;
                throw err;
              }
              for (const team of room.teams) {
                if (!team.retentionConfirmed) {
                  team.retentions = [];
                  team.retentionCostCr = 0;
                  team.spentCr = 0;
                  team.purseCr = team.startingPurseCr;
                  team.rtmCount = 6;
                  team.squad = [];
                  team.overseasCount = 0;
                  team.roleCounts = calcRoleCounts([]);
                  team.retentionConfirmed = true;
                  team.autoFinalized = true;
                  team.retentionFinalizedBy = 'host';
                }
              }
              finalizeMegaRetentions(room);
            }
            if (room.status !== 'ready') {
              const err = new Error('This auction has already started.');
              err.status = 409;
              throw err;
            }
            if (!currentPlayer(room)) {
              const err = new Error('No players remain in the pool.');
              err.status = 409;
              throw err;
            }
            room.status = 'live';
            startNextLot(room);
            room.lastEvent = makeEvent('auction-started', { playerId: currentPlayer(room)?.id, playerName: currentPlayer(room)?.name });
          } else if (action === 'pause') {
            if (room.status !== 'live') {
              const err = new Error('Auction is not live.');
              err.status = 409;
              throw err;
            }
            room.pausedRemainingMs = room.lotDone
              ? Math.max(0, (room.autoAdvanceAt || Date.now()) - Date.now())
              : Math.max(0, (room.bidEndsAt || Date.now()) - Date.now());
            room.bidEndsAt = null;
            room.autoAdvanceAt = null;
            room.status = 'paused';
            room.lotState = 'paused';
            room.lastEvent = makeEvent('paused');
          } else if (action === 'resume') {
            if (room.status !== 'paused') {
              const err = new Error('Auction is not paused.');
              err.status = 409;
              throw err;
            }
            room.status = 'live';
            if (room.lotDone) {
              room.lotState = room.celebrationActive ? 'celebration' : 'unsold_pause';
              room.autoAdvanceAt = Date.now() + Math.max(1000, room.pausedRemainingMs || 1000);
            } else {
              room.lotState = 'bidding';
              room.bidEndsAt = Date.now() + Math.max(1000, room.pausedRemainingMs || room.timerSeconds * 1000);
            }
            room.pausedRemainingMs = 0;
            room.lastEvent = makeEvent('resumed');
          } else if (action === 'sold') {
            const p = currentPlayer(room);
            if (room.status !== 'live' || room.lotDone || !p) {
              const err = new Error('There is no active lot to sell.');
              err.status = 409;
              throw err;
            }
            if (!room.currentBidCr || !room.currentBidTeamId) {
              const err = new Error('No team has bid on this player yet.');
              err.status = 409;
              throw err;
            }
            if (!settleSold(room)) {
              const err = new Error('The winning team can no longer complete this purchase.');
              err.status = 409;
              throw err;
            }
          } else if (action === 'unsold') {
            const p = currentPlayer(room);
            if (!p || room.status !== 'live' || room.lotDone) {
              const err = new Error('There is no active lot to mark unsold.');
              err.status = 409;
              throw err;
            }
            if (room.currentBidCr != null) {
              const err = new Error('A player with a valid bid cannot be marked unsold.');
              err.status = 409;
              throw err;
            }
            settleUnsold(room);
          } else if (action === 'next') {
            if (!room.lotDone) {
              const err = new Error('Mark the current player SOLD or UNSOLD before moving on.');
              err.status = 409;
              throw err;
            }
            if (room.currentCelebrationId) {
              if (!Array.isArray(room.processedCelebrations)) room.processedCelebrations = [];
              room.processedCelebrations.push(room.currentCelebrationId);
              if (room.processedCelebrations.length > 500) room.processedCelebrations.shift();
            }
            room.celebrationActive = false;
            room.currentCelebrationId = null;
            room.autoAdvanceAt = null;
            room.currentIndex += 1;
            startNextLot(room);
          } else if (action === 'set-base-price') {
            const p = currentPlayer(room);
            const val = Number(body.priceCr);
            if (!p || room.lotDone || room.currentBidCr != null) {
              const err = new Error('Base price can only be edited before bidding starts on this lot.');
              err.status = 409;
              throw err;
            }
            if (!Number.isFinite(val) || val < 0.2 || val > 20) {
              const err = new Error('Base price must be between ₹20 lakh and ₹20 crore.');
              err.status = 400;
              throw err;
            }
            room.basePriceOverrides[p.id] = roundCr(val);
            room.lastEvent = makeEvent('base-price-updated', { playerId: p.id, playerName: p.name, priceCr: roundCr(val) });
          } else if (action === 'rtm-match') {
            const p = currentPlayer(room);
            if (!p || room.lotDone || room.status !== 'live') {
              const err = new Error('No active bidding lot.');
              err.status = 409;
              throw err;
            }
            if (!room.currentBidCr || !room.currentBidTeamId) {
              const err = new Error('No bid has been placed on this player yet.');
              err.status = 409;
              throw err;
            }
            if (!p.originalTeamId) {
              const err = new Error('This candidate has no registered previous franchise for Right to Match.');
              err.status = 400;
              throw err;
            }
            const origTeam = room.teams.find(t => t.id === p.originalTeamId);
            if (!origTeam || !origTeam.rtmCount || origTeam.rtmCount <= 0) {
              const err = new Error(`${p.originalTeamId} has no Right to Match cards remaining.`);
              err.status = 400;
              throw err;
            }
            if (room.currentBidTeamId === p.originalTeamId) {
              const err = new Error(`${p.originalTeamId} is already the highest bidder.`);
              err.status = 400;
              throw err;
            }
            if (origTeam.purseCr + 0.0001 < room.currentBidCr) {
              const err = new Error(`${p.originalTeamId} has insufficient purse to match the bid.`);
              err.status = 400;
              throw err;
            }
            // RTM Matched: transfer bid to original franchise
            origTeam.rtmCount -= 1;
            room.currentBidTeamId = origTeam.id;
            room.currentBidderName = `${origTeam.short || origTeam.id} (RTM)`;
            room.currentBidHistory.push({
              teamId: origTeam.id,
              teamName: origTeam.name,
              bidderName: `${origTeam.short || origTeam.id} (RTM Card)`,
              amountCr: room.currentBidCr,
              isRTM: true,
              at: new Date().toISOString()
            });
            room.bidEndsAt = Date.now() + room.timerSeconds * 1000;
            room.timerRevision = (room.timerRevision || 0) + 1;
            room.lastEvent = makeEvent('rtm-matched', {
              playerId: p.id,
              playerName: p.name,
              teamId: origTeam.id,
              amountCr: room.currentBidCr
            });
          } else if (action === 'end-celebration' || action === 'skip-celebration') {
            const reqCelebrationId = body.celebrationId;
            if (!Array.isArray(room.processedCelebrations)) room.processedCelebrations = [];

            // Idempotent: If no celebration active or already ended, return success
            if (!room.celebrationActive || !room.lotDone) {
              return { ok: true, alreadyEnded: true, room: publicRoom(room) };
            }
            // If already processed this specific celebrationId, return success (idempotent duplicate request)
            if (reqCelebrationId && room.processedCelebrations.includes(reqCelebrationId)) {
              return { ok: true, alreadyProcessed: true, room: publicRoom(room) };
            }
            // For automatic audio end-celebration: ensure it is not a stale callback from an older lot
            if (action === 'end-celebration' && reqCelebrationId && room.currentCelebrationId && reqCelebrationId !== room.currentCelebrationId) {
              return { ok: true, stale: true, room: publicRoom(room) };
            }

            // Mark celebration as processed
            const activeCelebrationId = room.currentCelebrationId || reqCelebrationId;
            if (activeCelebrationId) {
              room.processedCelebrations.push(activeCelebrationId);
              if (room.processedCelebrations.length > 500) room.processedCelebrations.shift();
            }

            room.celebrationActive = false;
            room.currentCelebrationId = null;
            room.autoAdvanceAt = null;
            room.currentIndex += 1;
            startNextLot(room);

            const nextPlayer = currentPlayer(room);
            room.lastEvent = makeEvent(action === 'skip-celebration' ? 'celebration-skipped' : 'celebration-ended', {
              nextPlayerId: nextPlayer?.id,
              celebrationId: activeCelebrationId || null
            });
          } else if (action === 'set-audio-enabled') {
            // Host ON/OFF toggle for celebration audio
            const prevEnabled = room.celebrationAudioEnabled !== false;
            room.celebrationAudioEnabled = Boolean(body.enabled);
            console.log(`[AUDIO] Celebration audio ${room.celebrationAudioEnabled ? 'enabled' : 'disabled'} by host`);

            // If turned OFF during an active celebration: immediately stop audio on clients and apply 3-second fallback
            if (prevEnabled && !room.celebrationAudioEnabled && room.celebrationActive && room.lotDone) {
              room.autoAdvanceAt = Date.now() + 3000;
              room.lastEvent = makeEvent('celebration-audio-disabled', {
                celebrationId: room.currentCelebrationId || null,
                fallbackRemainingMs: 3000
              });
            }
          } else if (action === 'close' || action === 'close-room') {
            closeAuctionRoom(room, 'The host has closed this auction room.');
            return { ok: true, closed: true };
          } else {
            const err = new Error('Unknown host action.');
            err.status = 400;
            throw err;
          }
          persistAndTouch();
          return { ok: true, room: publicRoom(room) };
        });
        return sendJson(res, 200, result);
      } catch (err) {
        return sendJson(res, err.status || 400, { error: err.message || 'Action failed.' });
      }
    }

    // -------------------------------------------------------------------------
    // Franchise Audio Management API Endpoints
    // -------------------------------------------------------------------------
    if (method === 'GET' && pathname === '/api/host/audio/metadata') {
      if (!isHostToken(req)) return sendJson(res, 401, { error: 'Owner login required.' });
      ensureDefaultAudioAssets();
      return sendJson(res, 200, {
        ok: true,
        audio: getEffectiveAudioMap(),
        metadata: getAudioMetadataMap()
      });
    }

    if (method === 'POST' && pathname === '/api/host/audio') {
      if (!isHostToken(req)) return sendJson(res, 401, { error: 'Owner login required to manage franchise audio.' });
      if (activeRoom && !isRoomHost(req, activeRoom)) return sendJson(res, 403, { error: 'Only the active room owner can manage franchise audio.' });
      const body = await readBody(req, 12 * 1024 * 1024);
      const teamId = String(body.teamId || '').toUpperCase();
      if (!teamsConfig.some(t => t.id === teamId)) return sendJson(res, 400, { error: 'Unknown franchise.' });

      ensureDefaultAudioAssets();
      const metaMap = readJson(AUDIO_METADATA_FILE, {});

      if (body.clear || body.restoreDefault) {
        // Safe restoration: Revert to default track, delete ONLY custom uploaded file
        const audioMap = readJson(AUDIO_FILE, {});
        const currentUrl = audioMap[teamId];
        const defaultUrl = DEFAULT_AUDIO_MAP[teamId];

        // If current file is in /custom/, safely unlink it (NEVER delete default files)
        if (currentUrl && currentUrl.startsWith('/audio/custom/')) {
          const customFile = path.join(UPLOAD_AUDIO_DIR, currentUrl.replace(/^\/audio\//, ''));
          try { if (fs.existsSync(customFile)) fs.unlinkSync(customFile); } catch (e) {
            console.warn('[AUDIO CLEANUP WARNING]', e.message);
          }
        }

        // Restore canonical default URL
        audioMap[teamId] = defaultUrl;
        writeJson(AUDIO_FILE, audioMap);

        // Update metadata
        metaMap[teamId] = {
          teamId,
          url: defaultUrl,
          filename: path.basename(defaultUrl),
          isDefault: true,
          duration: DEFAULT_AUDIO_DURATIONS[teamId] || 8.0,
          updatedAt: new Date().toISOString()
        };
        writeJson(AUDIO_METADATA_FILE, metaMap);

        // Update in-memory map & active room
        teamAudio[teamId] = defaultUrl;
        if (activeRoom) {
          activeRoom.teamAudio[teamId] = defaultUrl;
          const team = activeRoom.teams.find(t => t.id === teamId);
          if (team) team.audioUrl = defaultUrl;
          persistAndTouch();
        }
        return sendJson(res, 200, {
          ok: true,
          teamId,
          audioUrl: defaultUrl,
          fileName: path.basename(defaultUrl),
          isDefault: true,
          duration: DEFAULT_AUDIO_DURATIONS[teamId] || 8.0,
          durationSec: DEFAULT_AUDIO_DURATIONS[teamId] || 8.0,
          audio: audioMap,
          metadata: getAudioMetadataMap()
        });
      }

      const mime = String(body.mimeType || '').toLowerCase();
      const rawName = String(body.fileName || 'hook-line.mp3');
      const ext = path.extname(rawName).toLowerCase() || (mime.includes('wav') ? '.wav' : mime.includes('ogg') ? '.ogg' : mime.includes('mp4') || mime.includes('m4a') ? '.m4a' : mime.includes('flac') ? '.flac' : '.mp3');
      if (!AUDIO_EXTS.has(ext) || (mime && !mime.startsWith('audio/') && !TEAM_AUDIO_MIMES.has(mime))) {
        return sendJson(res, 415, { error: 'Use an MP3, WAV, M4A, AAC, OGG, FLAC or WebM audio clip.' });
      }
      const raw = String(body.dataBase64 || '').replace(/^data:[^,]+,/, '');
      if (!raw) return sendJson(res, 400, { error: 'Choose an audio file first.' });
      const buffer = Buffer.from(raw, 'base64');
      if (buffer.length > 8 * 1024 * 1024) return sendJson(res, 413, { error: 'Audio clips must be 8 MB or smaller.' });
      if (buffer.length < 512) return sendJson(res, 400, { error: 'The uploaded file is empty or too small to be a valid audio clip.' });

      // Validate media file signature/magic bytes
      const isValidSig = validateAudioSignature(buffer, ext);
      if (!isValidSig) {
        return sendJson(res, 415, { error: 'The uploaded file does not match a valid audio format header.' });
      }

      // Determine duration
      let duration = null;
      if (ext === '.mp3') {
        duration = parseMp3Duration(buffer);
      }
      if (!duration && body.duration && Number(body.duration) > 0) {
        duration = roundCr(Number(body.duration));
      }
      if (!duration) {
        duration = DEFAULT_AUDIO_DURATIONS[teamId] || 8.0;
      }

      // Safe write: save to versioned filename in custom directory using .tmp then atomic rename
      fs.mkdirSync(CUSTOM_AUDIO_DIR, { recursive: true });
      const versionedFilename = `${teamId.toLowerCase()}-custom-${Date.now().toString(36)}${ext}`;
      const tempPath = path.join(CUSTOM_AUDIO_DIR, `${versionedFilename}.tmp`);
      const finalPath = path.join(CUSTOM_AUDIO_DIR, versionedFilename);
      fs.writeFileSync(tempPath, buffer);
      fs.renameSync(tempPath, finalPath);

      // Verify file is readable and non-empty
      const savedStat = fs.statSync(finalPath);
      if (savedStat.size !== buffer.length) {
        try { fs.unlinkSync(finalPath); } catch {}
        return sendJson(res, 500, { error: 'Failed to verify saved audio file.' });
      }

      const audioMap = readJson(AUDIO_FILE, {});
      const previousUrl = audioMap[teamId];
      const newAudioUrl = `/audio/custom/${versionedFilename}`;
      audioMap[teamId] = newAudioUrl;
      writeJson(AUDIO_FILE, audioMap);

      // Update rich metadata
      metaMap[teamId] = {
        teamId,
        url: newAudioUrl,
        filename: path.basename(rawName),
        isDefault: false,
        duration,
        sizeBytes: buffer.length,
        mimeType: mime,
        updatedAt: new Date().toISOString()
      };
      writeJson(AUDIO_METADATA_FILE, metaMap);

      // Clean up previous custom file if safe
      if (previousUrl && previousUrl.startsWith('/audio/custom/') && previousUrl !== newAudioUrl) {
        const oldFile = path.join(UPLOAD_AUDIO_DIR, previousUrl.replace(/^\/audio\//, ''));
        try { if (fs.existsSync(oldFile)) fs.unlinkSync(oldFile); } catch {}
      }

      teamAudio[teamId] = newAudioUrl;
      if (activeRoom) {
        activeRoom.teamAudio[teamId] = newAudioUrl;
        const team = activeRoom.teams.find(t => t.id === teamId);
        if (team) team.audioUrl = newAudioUrl;
        persistAndTouch();
      }

      return sendJson(res, 200, {
        ok: true,
        teamId,
        audioUrl: newAudioUrl,
        fileName: path.basename(rawName),
        isDefault: false,
        duration,
        durationSec: duration,
        audio: audioMap,
        metadata: getAudioMetadataMap()
      });
    }

    // -------------------------------------------------------------------------
    // Player Pool Management API Endpoints (Authenticated Host)
    // -------------------------------------------------------------------------
    if (method === 'GET' && pathname === '/api/admin/players') {
      if (!isHostToken(req)) return sendJson(res, 401, { error: 'Host authentication required.' });
      return sendJson(res, 200, { ok: true, players: candidates, count: candidates.length });
    }

    if (method === 'GET' && pathname === '/api/admin/players/export') {
      const queryToken = new URL(req.url, `http://${req.headers.host || 'localhost'}`).searchParams.get('token');
      if (!isHostToken(req) && (!queryToken || !hostSessions.has(queryToken))) {
        return sendJson(res, 401, { error: 'Host authentication required.' });
      }
      const content = JSON.stringify(candidates, null, 2);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="ipl2027-candidates-backup-${Date.now()}.json"`
      });
      return res.end(content);
    }

    if (method === 'POST' && pathname === '/api/admin/players/upload-image') {
      if (!isHostToken(req)) return sendJson(res, 401, { error: 'Host authentication required.' });
      const body = await readBody(req, 8 * 1024 * 1024);
      const mime = String(body.mimeType || '').toLowerCase();
      const rawName = String(body.fileName || body.filename || 'player.png');
      const ext = path.extname(rawName).toLowerCase() || (mime.includes('jpeg') || mime.includes('jpg') ? '.jpg' : mime.includes('webp') ? '.webp' : '.png');
      if (!PLAYER_IMAGE_EXTS.has(ext) || (mime && !PLAYER_IMAGE_MIMES.has(mime))) {
        return sendJson(res, 415, { error: 'Use a PNG, JPG, JPEG, or WebP image file.' });
      }
      const raw = String(body.dataBase64 || body.base64 || '').replace(/^data:[^,]+,/, '');
      if (!raw) return sendJson(res, 400, { error: 'Choose an image file to upload.' });
      const buffer = Buffer.from(raw, 'base64');
      if (buffer.length > 5 * 1024 * 1024) return sendJson(res, 413, { error: 'Player image must be 5 MB or smaller.' });

      fs.mkdirSync(UPLOAD_PLAYER_IMAGES_DIR, { recursive: true });
      const cleanBase = path.basename(rawName, path.extname(rawName)).toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const filename = `${cleanBase || 'player'}-${Date.now().toString(36)}${ext}`;
      fs.writeFileSync(path.join(UPLOAD_PLAYER_IMAGES_DIR, filename), buffer);
      return sendJson(res, 200, { ok: true, imageUrl: `/player-images/${filename}` });
    }

    if (method === 'POST' && pathname === '/api/admin/players') {
      if (!isHostToken(req)) return sendJson(res, 401, { error: 'Host authentication required.' });
      const body = await readBody(req, 100000);
      const name = String(body.name || '').trim();
      if (!name || name.length < 2) return sendJson(res, 400, { error: 'Player full name is required (min 2 characters).' });

      // Duplicate check: normalized name
      const normName = name.toLowerCase();
      const existing = candidates.find(c => c.name.toLowerCase().trim() === normName);
      if (existing) {
        return sendJson(res, 409, { error: `A player named "${name}" already exists in the candidate database.` });
      }

      const role = String(body.role || 'Batter').trim();
      const roleBucket = ['Keeper', 'Wicketkeeper-batter'].includes(role) ? 'Keeper' :
                         ['Bowler', 'Bowling all-rounder'].includes(role) ? 'Bowler' :
                         ['All-rounder', 'Batting all-rounder'].includes(role) ? 'All-rounder' : 'Batter';
      const nationality = String(body.nationality || 'India').trim();
      const origin = body.origin === 'Overseas' || nationality.toLowerCase() !== 'india' ? 'Overseas' : 'Domestic';
      const cappedStatus = body.cappedStatus === 'Uncapped' ? 'Uncapped' : 'Capped';
      const basePriceCr = Math.max(0.1, Math.min(50, roundCr(Number(body.basePriceCr) || (cappedStatus === 'Uncapped' ? 0.3 : 1.0))));
      const auctionSet = String(body.auctionSet || `${cappedStatus} ${roleBucket}`).trim();

      // Generate unique slug id
      let baseSlug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'player';
      let id = baseSlug;
      let counter = 2;
      while (playerById.has(id)) {
        id = `${baseSlug}-${counter++}`;
      }

      const newPlayer = {
        id,
        name,
        age: Number(body.age) || null,
        nationality,
        origin,
        cappedStatus,
        role,
        roleBucket,
        roleSubtype: String(body.roleSubtype || role).trim(),
        auctionOutcome: 'Registered 2027 candidate',
        basePriceCr,
        previousBasePriceCr: null,
        releaseFranchise: body.releaseFranchise ? String(body.releaseFranchise).trim().toUpperCase() : null,
        candidateSource: 'host-added via Player Pool Manager',
        candidateStatus: 'Active',
        notes: String(body.notes || '').trim(),
        auctionSet,
        image: body.image ? String(body.image).trim() : null,
        imageSource: 'host-managed',
        imageStatus: body.image ? 'Custom image assigned' : 'No photo uploaded',
        localImage: Boolean(body.image && body.image.startsWith('/player-images/')),
        setOrder: candidates.length,
        excluded: Boolean(body.excluded),
        includeInMini: body.includeInMini !== false,
        includeInMega: body.includeInMega !== false
      };

      candidates.push(newPlayer);
      saveCandidates();
      refreshCandidateMap();

      console.log(`[PLAYER MANAGER] Host added candidate: ${newPlayer.name} (${newPlayer.id}, ₹${newPlayer.basePriceCr} Cr)`);
      return sendJson(res, 201, { ok: true, player: newPlayer });
    }

    const playerActionMatch = pathname.match(/^\/api\/admin\/players\/([A-Za-z0-9_-]+)(?:\/(toggle-exclusion|pool-eligibility))?$/);
    if (playerActionMatch) {
      if (!isHostToken(req)) return sendJson(res, 401, { error: 'Host authentication required.' });
      const id = playerActionMatch[1];
      const subAction = playerActionMatch[2];
      const candidateIndex = candidates.findIndex(c => c.id === id);
      if (candidateIndex === -1) return sendJson(res, 404, { error: `Player "${id}" not found.` });
      const candidate = candidates[candidateIndex];

      if (method === 'DELETE') {
        if (activeRoom && activeRoom.sold && activeRoom.sold[id]) {
          return sendJson(res, 409, { error: 'Cannot delete a player who was already sold in the active auction room.' });
        }
        candidates.splice(candidateIndex, 1);
        saveCandidates();
        refreshCandidateMap();
        console.log(`[PLAYER MANAGER] Host permanently deleted candidate: ${candidate.name} (${id})`);
        return sendJson(res, 200, { ok: true, deleted: id, name: candidate.name });
      }

      if (method === 'POST' && subAction === 'toggle-exclusion') {
        candidate.excluded = !candidate.excluded;
        saveCandidates();
        refreshCandidateMap();
        return sendJson(res, 200, { ok: true, id, excluded: candidate.excluded, name: candidate.name, player: candidate });
      }

      if (method === 'POST' && subAction === 'pool-eligibility') {
        const body = await readBody(req, 10000);
        if (body.includeInMini !== undefined) candidate.includeInMini = Boolean(body.includeInMini);
        if (body.includeInMega !== undefined) candidate.includeInMega = Boolean(body.includeInMega);
        if (body.excluded !== undefined) candidate.excluded = Boolean(body.excluded);
        saveCandidates();
        refreshCandidateMap();
        return sendJson(res, 200, {
          ok: true,
          id,
          includeInMini: candidate.includeInMini,
          includeInMega: candidate.includeInMega,
          excluded: candidate.excluded,
          player: candidate
        });
      }

      if (method === 'PUT') {
        const body = await readBody(req, 50000);
        if (body.name) {
          const newName = String(body.name).trim();
          if (newName.length < 2) return sendJson(res, 400, { error: 'Player name must be at least 2 characters.' });
          const clash = candidates.find(c => c.id !== id && c.name.toLowerCase().trim() === newName.toLowerCase());
          if (clash) return sendJson(res, 409, { error: `Another player named "${newName}" already exists.` });
          candidate.name = newName;
        }
        if (body.role) {
          candidate.role = String(body.role).trim();
          candidate.roleBucket = ['Keeper', 'Wicketkeeper-batter'].includes(candidate.role) ? 'Keeper' :
                                 ['Bowler', 'Bowling all-rounder'].includes(candidate.role) ? 'Bowler' :
                                 ['All-rounder', 'Batting all-rounder'].includes(candidate.role) ? 'All-rounder' : 'Batter';
        }
        if (body.roleSubtype !== undefined) candidate.roleSubtype = String(body.roleSubtype).trim();
        if (body.nationality) {
          candidate.nationality = String(body.nationality).trim();
          candidate.origin = candidate.nationality.toLowerCase() === 'india' ? 'Domestic' : 'Overseas';
        }
        if (body.origin) candidate.origin = body.origin === 'Overseas' ? 'Overseas' : 'Domestic';
        if (body.cappedStatus) candidate.cappedStatus = body.cappedStatus === 'Uncapped' ? 'Uncapped' : 'Capped';
        if (body.basePriceCr != null) candidate.basePriceCr = Math.max(0.1, Math.min(50, roundCr(Number(body.basePriceCr))));
        if (body.auctionSet) candidate.auctionSet = String(body.auctionSet).trim();
        if (body.image !== undefined) {
          candidate.image = body.image ? String(body.image).trim() : null;
          candidate.localImage = Boolean(candidate.image && candidate.image.startsWith('/player-images/'));
        }
        if (body.notes !== undefined) candidate.notes = String(body.notes || '').trim();
        if (body.candidateSource !== undefined) candidate.candidateSource = String(body.candidateSource || '').trim();
        if (body.roleSubtype !== undefined) candidate.roleSubtype = String(body.roleSubtype || candidate.role || '').trim();
        if (body.age !== undefined) candidate.age = Number(body.age) || null;
        if (body.releaseFranchise !== undefined) candidate.releaseFranchise = body.releaseFranchise ? String(body.releaseFranchise).trim().toUpperCase() : null;
        if (body.includeInMini !== undefined) candidate.includeInMini = Boolean(body.includeInMini);
        if (body.includeInMega !== undefined) candidate.includeInMega = Boolean(body.includeInMega);
        if (body.excluded !== undefined) candidate.excluded = Boolean(body.excluded);

        saveCandidates();
        refreshCandidateMap();

        // Safely update candidate in active room snapshot if present
        if (activeRoom && activeRoom.candidatePoolById && activeRoom.candidatePoolById[id]) {
          const roomCand = activeRoom.candidatePoolById[id];
          roomCand.name = candidate.name;
          roomCand.role = candidate.role;
          roomCand.roleBucket = candidate.roleBucket;
          roomCand.nationality = candidate.nationality;
          roomCand.origin = candidate.origin;
          roomCand.cappedStatus = candidate.cappedStatus;
          roomCand.image = candidate.image;
          roomCand.auctionSet = candidate.auctionSet;
          persistAndTouch();
        }

        console.log(`[PLAYER MANAGER] Host updated candidate: ${candidate.name} (${id})`);
        return sendJson(res, 200, { ok: true, player: candidate });
      }
    }

    // Static files
    let filePath;
    if (pathname === '/') filePath = path.join(PUBLIC_DIR, 'index.html');
    else filePath = path.resolve(PUBLIC_DIR, `.${pathname}`);
    if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== path.join(PUBLIC_DIR, 'index.html')) return sendText(res, 403, 'Forbidden');
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return sendText(res, 404, 'Not found');
    const ext = path.extname(filePath).toLowerCase();
    const types = {
      '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png',
      '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
      '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.webm': 'audio/webm', '.flac': 'audio/flac', '.wma': 'audio/x-ms-wma',
      '.amr': 'audio/amr', '.3gp': 'audio/3gpp', '.ico': 'image/x-icon'
    };
    const stat = fs.statSync(filePath);
    const contentType = types[ext] || 'application/octet-stream';
    const isAudio = ext === '.mp3' || ext === '.wav' || ext === '.m4a' || ext === '.aac' || ext === '.ogg' || ext === '.webm' || ext === '.flac';

    // Support HTTP Range requests for mobile audio playback (iOS Safari / Android Chrome)
    const range = req.headers.range;
    if (isAudio && range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
      if (start >= stat.size || end >= stat.size || start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
        return res.end();
      }
      const chunksize = (end - start) + 1;
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': contentType,
        'Cache-Control': 'no-cache'
      });
      return fs.createReadStream(filePath, { start, end }).pipe(res);
    }

    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': stat.size,
      'Accept-Ranges': 'bytes',
      'Cache-Control': (ext === '.html' || ext === '.css' || ext === '.js') ? 'no-cache' : 'public, max-age=3600'
    });
    fs.createReadStream(filePath).pipe(res);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) sendJson(res, err.status || 500, { error: err.message || 'Unexpected server error.' });
    else res.end();
  }
});

setInterval(() => {
  if (activeRoom) processAuctionClock(activeRoom);
}, 250);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`IPL 2027 Fan Auction ready at http://localhost:${PORT}`);
  console.log(`Candidate pool: ${candidates.length} | Host access code: ${HOST_ACCESS_CODE === 'ipl2027owner' ? 'default local code ipl2027owner (change before public hosting)' : 'custom environment code is set'}`);
});
