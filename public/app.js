'use strict';

const app = document.getElementById('app');
const toastRoot = document.getElementById('toast-root');
const store = window.localStorage;
const clientId = store.getItem('ipl27-client-id') || (() => { const v = crypto.randomUUID(); store.setItem('ipl27-client-id', v); return v; })();

const state = {
  bootstrap: null,
  view: 'floor', // 'floor' | 'players' | 'squads' | 'history'
  roomCode: null,
  room: null,
  participant: null,
  isHost: false,
  ownerToken: store.getItem('ipl27-owner-token') || null,
  ownerRoomCode: store.getItem('ipl27-owner-room') || null,
  ownerReady: false,
  activeRoomData: null,
  existingRoomCode: null,
  homePanel: 'welcome',
  selectedMode: 'mini',
  showJoinModal: false,
  modalType: null,
  query: '',
  joinDraft: { name: '', teamId: '' },
  poolSet: 'all',
  poolRole: 'all',
  poolStatus: 'all',
  lastVersion: null,
  lastEventId: null,
  celebration: null,
  activeCelebrationId: null,
  dismissedCelebrationIds: new Set(),
  processedCelebrationIds: new Set(),
  confettiCelebrationId: null,
  audioCelebrationId: null,
  celebrationAudioError: false,
  currentAudio: null,
  currentAudioListener: null,
  pollTimer: null,
  timerInterval: null,
  celebrationTimeout: null,
  muteAudio: store.getItem('ipl27-mute') === 'true',
  audioVolume: Number(store.getItem('ipl27-volume') || 0.8),
  audioUnlocked: (typeof sessionStorage !== 'undefined' && sessionStorage.getItem('ipl27-audio-unlocked') === 'true'),
  audioAutoplayBlocked: false,
  celebrationStartedAt: null,
  selectedRetentionTeam: null,
  retentionDraft: {},
  selectedRetentionMode: 'host',
  inFlightAction: false,
  showCloseModal: false,
  existingRoomCode: null,
  hostTab: 'setup', // 'setup' | 'pool' | 'audio'
  poolManager: {
    search: '',
    role: 'all',
    origin: 'all',
    capped: 'all',
    basePrice: 'all',
    poolEligibility: 'all',
    sort: 'default',
    page: 1,
    pageSize: 15,
    editingPlayer: null,
    addingPlayer: false,
    deletePlayerId: null
  }
};

const TEAM_NAMES = {
  CSK: 'Chennai Super Kings', DC: 'Delhi Capitals', GT: 'Gujarat Titans', KKR: 'Kolkata Knight Riders',
  LSG: 'Lucknow Super Giants', MI: 'Mumbai Indians', PBKS: 'Punjab Kings', RR: 'Rajasthan Royals', RCB: 'Royal Challengers Bengaluru', SRH: 'Sunrisers Hyderabad'
};

const RETENTION_SLABS_CR = [18, 14, 11, 18, 14];
const UNCAPPED_COST_CR = 4;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function initials(name) {
  return String(name || '?').trim().split(/\s+/).slice(0, 2).map(s => s[0] || '').join('').toUpperCase();
}
function roundCr(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}
function fmtCr(value) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  const n = Number(value);
  if (n < 1) return `₹${Math.round(n * 100)} L`;
  return `₹${n.toFixed(2)} Cr`;
}
function fmtCrBare(value) { return value == null ? '—' : `₹${Number(value).toFixed(2)} Cr`; }
function nextIncrement(current) {
  if (current < 1) return 0.05;
  if (current < 2) return 0.10;
  if (current < 5) return 0.20;
  if (current < 10) return 0.25;
  return 0.50;
}
function nextBidAmount(room) {
  if (!room?.currentPlayer) return null;
  if (room.currentBidCr == null) return room.currentPlayer.basePriceCr;
  return roundCr(room.currentBidCr + nextIncrement(room.currentBidCr));
}
function teamById(teamId) { return (state.bootstrap?.teams || []).find(t => t.id === teamId); }
function teamStateById(teamId) { return (state.room?.teams || []).find(t => t.id === teamId); }
function findCandidate(id) {
  if (state.room?.candidatePool) {
    const found = state.room.candidatePool.find(p => p.id === id);
    if (found) return found;
  }
  return (state.bootstrap?.candidates || []).find(p => p.id === id);
}

function imageFrame(person, className = '') {
  const src = person?.image || person?.imageUrl || null;
  const alt = person?.name || person?.playerName || 'Cricket player';
  const stamp = initials(alt);
  if (src) {
    return `<div class="photo-frame ${className}"><img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" loading="lazy" onerror="this.style.display='none';this.parentElement.classList.add('no-photo')"><span class="photo-placeholder">${escapeHtml(stamp)}<small>PLAYER</small></span></div>`;
  }
  return `<div class="photo-frame ${className} no-photo"><span class="photo-placeholder">${escapeHtml(stamp)}<small>PLAYER</small></span></div>`;
}

function tinyPlayerImage(person) {
  const src = person?.image || person?.imageUrl || null;
  const name = person?.name || person?.playerName || 'Cricket player';
  const stamp = escapeHtml(initials(name));
  if (!src) return `<span class="tiny-initial">${stamp}</span>`;
  return `<span class="tiny-image-wrap"><img class="tiny-photo" src="${escapeHtml(src)}" alt="${escapeHtml(name)}" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='grid'"/><span class="tiny-initial">${stamp}</span></span>`;
}

function teamBadge(teamId, extra = '') {
  const roomTeam = state.room?.teams?.find(x => x.id === teamId);
  const bootstrapTeam = teamById(teamId);
  const t = { ...bootstrapTeam, ...roomTeam } || { id: teamId, short: teamId, primary: '#D71920', secondary: '#08111b' };
  if (t.logo) {
    return `<span class="team-badge team-badge-logo ${extra}" style="--team-primary:${t.primary};--team-secondary:${t.secondary}"><img src="${escapeHtml(t.logo)}" alt="${escapeHtml(t.short || t.id)}" onerror="this.parentElement.classList.remove('team-badge-logo');this.remove()"/></span>`;
  }
  return `<span class="team-badge ${extra}" style="--team-primary:${t.primary};--team-secondary:${t.secondary}">${escapeHtml(t.short || t.id)}</span>`;
}

function teamStyle(team) { return `--team-primary:${team?.primary || '#D71920'};--team-secondary:${team?.secondary || '#08111b'}`; }

function toast(message, type = '') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  toastRoot.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(8px)';
    setTimeout(() => el.remove(), 220);
  }, 3600);
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (state.ownerToken) headers['x-host-token'] = state.ownerToken;
  if (options.body && typeof options.body !== 'string') {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(options.body);
  }
  const response = await fetch(path, { ...options, headers, cache: 'no-store' });
  let payload = {};
  try { payload = await response.json(); } catch { payload = {}; }
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status}).`);
  return payload;
}

function setUrlRoom(code) {
  const url = new URL(window.location.href);
  if (code) url.searchParams.set('room', code); else url.searchParams.delete('room');
  window.history.replaceState({}, '', url.toString());
}

let roomEventSource = null;

function connectEventStream() {
  if (typeof EventSource === 'undefined') return;
  if (!state.roomCode) return;
  if (roomEventSource) {
    try { roomEventSource.close(); } catch {}
    roomEventSource = null;
  }
  try {
    const es = new EventSource(`/api/room/${encodeURIComponent(state.roomCode)}/events`);
    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === 'room-update' && data.room) {
          acceptRoom(data.room, false);
        }
      } catch {}
    };
    es.onerror = () => {
      // Polling fallback keeps client synchronized seamlessly
    };
    roomEventSource = es;
  } catch {}
}

function stopEventStream() {
  if (roomEventSource) {
    try { roomEventSource.close(); } catch {}
    roomEventSource = null;
  }
}

function stopPolling() {
  stopEventStream();
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = null;
}

function startPolling() {
  stopPolling();
  connectEventStream();
  state.pollTimer = setInterval(async () => {
    if (!state.roomCode) return;
    try {
      const result = await api(`/api/room/${encodeURIComponent(state.roomCode)}/state`);
      acceptRoom(result.room, false);
    } catch (err) {
      if (/no longer active/i.test(err.message) || /404/i.test(err.message)) {
        console.log('[POLLING] Room closed, clearing state');
        stopPolling();
        state.room = null;
        state.roomCode = null;
        state.participant = null;
        state.isHost = false;
        store.removeItem('ipl27-participant');
        setUrlRoom(null);
        renderHome();
        toast('The auction room has closed.', 'error');
      } else {
        console.warn('[POLLING] Temporary error, retrying:', err.message);
      }
    }
  }, 950);

  if (state.timerInterval) clearInterval(state.timerInterval);
  state.timerInterval = setInterval(updateTimerText, 100);
}

function fastUpdateBidStage(room) {
  // Ultra-fast targeted DOM updates for bidding without rebuilding whole page
  const liveLabel = document.querySelector('.live-stage .live-label');
  if (liveLabel) {
    liveLabel.innerHTML = `<i></i>${(room.celebrationActive || room.lotState === 'celebration') ? 'Celebrating previous sale…' : room.lotDone ? 'Lot settled' : room.status === 'ready' ? 'Floor not open' : room.status === 'paused' ? 'Clock on hold' : 'Current leading bid'}`;
  }
  const curBidEl = document.querySelector('.current-bid');
  if (curBidEl) {
    const p = room.currentPlayer;
    curBidEl.textContent = room.currentBidCr == null ? fmtCr(p?.basePriceCr) : fmtCr(room.currentBidCr);
    curBidEl.classList.toggle('empty', room.currentBidCr == null);
  }
  const bidCapEl = document.querySelector('.bid-caption');
  if (bidCapEl) {
    const leadTeam = room.teams?.find(t => t.id === room.currentBidTeamId);
    const bidCap = leadTeam ? `${leadTeam.short || leadTeam.id} LEAD` : 'OPENING BASE';
    bidCapEl.innerHTML = room.currentBidCr == null ? 'Base price · awaiting first bid' : `<b>${escapeHtml(bidCap)}</b> · ${escapeHtml(room.currentBidderName || '')}`;
  }
  const bidLogHead = document.querySelector('.bid-log-head span:last-child');
  const bids = room.currentBidHistory || [];
  if (bidLogHead) {
    bidLogHead.textContent = `${bids.length} RAISES`;
  }
  const bidLogEl = document.querySelector('.bid-log');
  if (bidLogEl) {
    const bidRows = bids.length ? bids.slice().reverse().map(b => `<div class="bid-row"><div class="bid-badge" style="background:${teamColor(b.teamId)}">${escapeHtml(b.teamId)}</div><div class="bid-who"><strong>${escapeHtml(b.bidderName || b.teamName)}</strong><span>${new Date(b.at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'})}</span></div><div class="bid-val">${fmtCr(b.amountCr)}</div></div>`).join('') : '<div class="bid-empty">No raises placed yet on this candidate.</div>';
    bidLogEl.innerHTML = `<div class="bid-log-head"><span>Recent bids</span><span>${bids.length} RAISES</span></div>${bidRows}`;
  }
  if (state.participant?.role === 'teamOwner') {
    const team = teamStateById(state.participant.teamId);
    const expected = nextBidAmount(room);
    const p = room.currentPlayer;
    const isLive = room.status === 'live' && room.lotState === 'bidding';
    const audioBlocked = Boolean(room.celebrationActive || room.lotState === 'celebration');
    const canBid = Boolean(!audioBlocked && isLive && !room.lotDone && team && expected != null && room.currentBidTeamId !== team.id && team.purseCr + 0.001 >= expected && team.squad.length < room.maxSquadSize && !(p?.origin === 'Overseas' && team.squad.filter(x => x.overseas).length >= room.maxOverseas) && room.bidEndsAt && Date.now() < room.bidEndsAt);

    const bidMain = document.querySelector('.bid-controls .bid-main');
    if (bidMain && !bidMain.classList.contains('bid-submitting')) {
      bidMain.disabled = !canUserBid(room);
      bidMain.innerHTML = (room.celebrationActive || room.lotState === 'celebration') ? 'VICTORY ANTHEM PLAYING…' : room.currentBidTeamId === state.participant.teamId ? '✓ YOU HOLD THE LEAD' : `RAISE TO ${fmtCr(nextBidAmount(room))} ↗`;
    }
    const consoleBtn = document.querySelector('.control-stack button[data-action="bid"]');
    if (consoleBtn && !consoleBtn.classList.contains('bid-submitting')) {
      consoleBtn.disabled = !canBid;
      consoleBtn.innerHTML = audioBlocked ? 'VICTORY ANTHEM PLAYING…' : room.currentBidTeamId === team?.id ? 'You hold the lead' : `Raise to ${fmtCr(expected)} ↗`;
    }
  }
  (room.teams || []).forEach(t => {
    const card = document.querySelector(`[data-team-card="${t.id}"]`);
    if (card) {
      const purseEl = card.querySelector('.team-purse-line strong');
      if (purseEl) purseEl.textContent = fmtCr(t.purseCr);
    }
  });
  updateTimerText();
}

function acceptRoom(room, initial = false) {
  if (!room) return;

  // Stale snapshot protection: discard poll snapshots older than current room state
  if (!initial && state.room && state.room.updatedAt && room.updatedAt) {
    const inTime = new Date(room.updatedAt).getTime();
    const currTime = new Date(state.room.updatedAt).getTime();
    if (inTime < currTime) {
      return;
    }
  }

  // If celebration audio was disabled, stop currently playing audio immediately
  if (room.celebrationAudioEnabled === false && state.currentAudio) {
    stopCurrentAudio();
  }

  // Authoritative celebration lifecycle:
  if (!room.celebrationActive) {
    if (state.celebration) {
      state.celebration = null;
      state.activeCelebrationId = null;
      if (state.celebrationTimeout) { clearTimeout(state.celebrationTimeout); state.celebrationTimeout = null; }
      stopCurrentAudio();
      syncCelebrationModal();
    }
  } else if (room.celebrationActive && !state.celebration) {
    const cId = room.currentCelebrationId || room.lastEvent?.celebrationId || room.lastEvent?.id;
    if (cId && !state.dismissedCelebrationIds.has(cId) && room.lastEvent?.type === 'sale') {
      handleRoomEvent(room.lastEvent);
    }
  }

  const previousVersion = state.lastVersion;
  if (initial || state.lastEventId == null) {
    state.lastEventId = room.lastEvent?.id || null;
    if (initial && room.celebrationActive && room.lastEvent?.type === 'sale') {
      handleRoomEvent(room.lastEvent);
    }
  } else if (room.lastEvent?.id && room.lastEvent.id !== state.lastEventId) {
    state.lastEventId = room.lastEvent.id;
    handleRoomEvent(room.lastEvent);
  }
  state.room = room;
  if (room.teamAudio) preloadTeamAudio(room.teamAudio);

  // Authoritative participant sync
  if (!state.isHost && state.participant) {
    const serverCopy = (room.participants || []).find(p => p.clientId === clientId);
    if (serverCopy) {
      state.participant = { ...state.participant, ...serverCopy };
      try {
        store.setItem('ipl27-participant', JSON.stringify({
          roomCode: state.roomCode,
          participant: state.participant,
          clientId,
          timestamp: Date.now()
        }));
      } catch {}
    } else {
      state.participant = null;
      store.removeItem('ipl27-participant');
    }
  }

  const isBiddingUpdate = !initial && state.room && state.view === 'floor' &&
    room.lotId === state.room?.lotId &&
    room.lotState === 'bidding' &&
    state.room?.lotState === 'bidding' &&
    !room.celebrationActive &&
    !state.modalType && !state.showJoinModal && !state.showCloseModal;

  if (isBiddingUpdate && previousVersion !== room.updatedAt) {
    state.lastVersion = room.updatedAt;
    fastUpdateBidStage(room);
  } else if (previousVersion !== room.updatedAt || initial) {
    state.lastVersion = room.updatedAt;
    renderRoom();
  } else {
    updateTimerText();
  }
}


// -----------------------------------------------------------------------------
// Celebratory Confetti & Popper Particle Effect (Foreground, Layer 4, z: 210)
// -----------------------------------------------------------------------------
let confettiAnimationId = null;
let confettiCanvas = null;

function getCelebrationRoot() {
  let root = document.getElementById('celebration-root');
  if (!root) {
    root = document.createElement('div');
    root.id = 'celebration-root';
    if (document.body) document.body.appendChild(root);
  }
  return root;
}

function stopCelebrationConfetti() {
  if (confettiAnimationId) {
    cancelAnimationFrame(confettiAnimationId);
    confettiAnimationId = null;
  }
  if (confettiCanvas) {
    try { confettiCanvas.remove(); } catch {}
    confettiCanvas = null;
  }
  state.confettiCelebrationId = null;
}

function startCelebrationConfetti(team, celebrationId) {
  if (celebrationId && state.confettiCelebrationId === celebrationId && confettiCanvas) {
    return; // Particles already exploding for this celebration
  }
  stopCelebrationConfetti();
  if (celebrationId) state.confettiCelebrationId = celebrationId;

  if (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    return; // Respect accessibility / reduced-motion preferences
  }
  const root = getCelebrationRoot();
  if (!root) return;

  confettiCanvas = document.createElement('canvas');
  confettiCanvas.id = 'celebration-confetti-canvas';
  confettiCanvas.className = 'celebration-confetti-canvas';
  root.appendChild(confettiCanvas);

  const ctx = confettiCanvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;

  function resize() {
    if (!confettiCanvas) return;
    confettiCanvas.width = window.innerWidth * dpr;
    confettiCanvas.height = window.innerHeight * dpr;
    ctx.scale(dpr, dpr);
  }
  resize();

  const primary = team?.primary || '#d71920';
  const secondary = team?.secondary || '#ffd700';
  const colors = [primary, secondary, '#ffd700', '#ffffff', '#10b981', '#38bdf8'];
  const particles = [];
  const particleCount = Math.min(130, Math.floor(window.innerWidth / 8));

  for (let i = 0; i < particleCount; i++) {
    const isLeft = i % 2 === 0;
    const startX = isLeft ? window.innerWidth * 0.15 : window.innerWidth * 0.85;
    const startY = window.innerHeight * 0.75;
    const angle = isLeft ? -Math.PI / 4 + (Math.random() - 0.5) * 0.6 : -3 * Math.PI / 4 + (Math.random() - 0.5) * 0.6;
    const speed = Math.random() * 14 + 10;
    particles.push({
      x: startX,
      y: startY,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      size: Math.random() * 8 + 6,
      color: colors[Math.floor(Math.random() * colors.length)],
      rotation: Math.random() * 360,
      rotSpeed: (Math.random() - 0.5) * 12,
      shape: Math.random() > 0.4 ? 'rect' : 'circle',
      alpha: 1,
      decay: 0.003 + Math.random() * 0.003,
      gravity: 0.38,
      drag: 0.985
    });
  }

  let lastTime = performance.now();
  function animate(now) {
    if (!confettiCanvas) return;
    const dt = Math.min((now - lastTime) / 16.67, 2);
    lastTime = now;
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);

    let alive = 0;
    for (const p of particles) {
      if (p.alpha <= 0.01) continue;
      alive++;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += p.gravity * dt;
      p.vx *= Math.pow(p.drag, dt);
      p.rotation += p.rotSpeed * dt;
      p.alpha -= p.decay * dt;

      ctx.save();
      ctx.globalAlpha = Math.max(0, p.alpha);
      ctx.fillStyle = p.color;
      ctx.translate(p.x, p.y);
      ctx.rotate((p.rotation * Math.PI) / 180);

      if (p.shape === 'rect') {
        ctx.fillRect(-p.size / 2, -p.size / 3, p.size, p.size * 0.6);
      } else {
        ctx.beginPath();
        ctx.arc(0, 0, p.size / 2, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
    if (alive > 0) {
      confettiAnimationId = requestAnimationFrame(animate);
    }
  }
  confettiAnimationId = requestAnimationFrame(animate);
}

function dismissCelebrationUI() {
  const root = document.getElementById('celebration-root');
  if (root) root.innerHTML = '';
  stopCelebrationConfetti();
}

function stopCurrentAudio() {
  if (state.celebrationTimeout) {
    clearTimeout(state.celebrationTimeout);
    state.celebrationTimeout = null;
  }
  if (state.currentAudio) {
    try {
      state.currentAudio.pause();
      state.currentAudio.currentTime = 0;
    } catch {}
    if (state.currentAudioListener) {
      try { state.currentAudio.removeEventListener('ended', state.currentAudioListener); } catch {}
      state.currentAudioListener = null;
    }
    state.currentAudio = null;
  }
  state.audioCelebrationId = null;
}

function unlockAudioEngine() {
  state.audioUnlocked = true;
  state.audioAutoplayBlocked = false;
  try {
    store.setItem('ipl27-audio-unlocked', 'true');
    sessionStorage.setItem('ipl27-audio-unlocked', 'true');
  } catch {}
  try {
    const a = getGlobalAudio();
    a.src = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA';
    a.play().catch(() => {});
  } catch {}
  toast('Auction audio enabled.', 'success');
  renderRoom();
}

let hostEndCelebrationInFlight = false;
function finishHostCelebration(celebrationId) {
  if (!state.isHost) return;
  if (!celebrationId || state.processedCelebrationIds.has(celebrationId)) {
    return;
  }
  state.processedCelebrationIds.add(celebrationId);
  if (state.celebrationTimeout) {
    clearTimeout(state.celebrationTimeout);
    state.celebrationTimeout = null;
  }
  stopCurrentAudio();
  if (hostEndCelebrationInFlight) return;
  hostEndCelebrationInFlight = true;

  if (state.roomCode) {
    api(`/api/room/${encodeURIComponent(state.roomCode)}/action`, {
      method: 'POST',
      body: { action: 'end-celebration', celebrationId }
    }).then(res => {
      hostEndCelebrationInFlight = false;
      if (res?.room) acceptRoom(res.room, false);
    }).catch(err => {
      hostEndCelebrationInFlight = false;
      console.warn('end-celebration error:', err);
    });
  } else {
    hostEndCelebrationInFlight = false;
  }
}

function syncCelebrationModal() {
  const root = getCelebrationRoot();
  const ev = state.celebration;
  if (!ev) {
    dismissCelebrationUI();
    return;
  }
  const celebrationId = String(ev.celebrationId || ev.id || `${ev.lotId}-${ev.playerId}`);
  const existingVeil = document.getElementById('sale-veil');
  if (existingVeil && existingVeil.dataset.celebrationId === celebrationId) {
    // Stably mounted for this exact celebration: preserve DOM to prevent blinking and animation restarts
    return;
  }

  const team = teamById(ev.teamId) || { id: ev.teamId, name: ev.teamName, primary: '#D71920', secondary: '#08111b' };
  const p = findCandidate(ev.playerId) || { name: ev.playerName, image: ev.image };

  root.innerHTML = `<div class="sale-celebration" id="sale-veil" data-celebration-id="${escapeHtml(celebrationId)}">
    <div class="sale-card" style="--team-primary:${team.primary};--team-secondary:${team.secondary}">
      <div class="sale-eyebrow">The hammer has fallen · IPL 2027 fan auction</div>
      <div class="sale-title">SOLD!</div>
      <div class="sale-player">
        <div class="sale-photo">${p.image ? `<img src="${escapeHtml(p.image)}" alt="${escapeHtml(p.name)}" onerror="this.style.display='none';this.nextElementSibling.style.display='grid'"/><span class="photo-placeholder" style="display:none">${escapeHtml(initials(p.name))}<small>PLAYER</small></span>` : `<span class="photo-placeholder" style="display:grid">${escapeHtml(initials(p.name))}<small>PLAYER</small></span>`}</div>
        <div>
          <h2>${escapeHtml(p.name)}</h2>
          <p>${escapeHtml(p.role || '')} · Winning franchise confirmed</p>
        </div>
      </div>
      <div class="sale-franchise">${teamBadge(ev.teamId)} ${escapeHtml(team.name || ev.teamName)}</div>
      <div class="sale-amount">${fmtCr(ev.amountCr)}</div>
      <div class="sale-buttons">
        ${state.isHost ? `
          <button type="button" class="btn btn-warning btn-lg skip-celebration-btn" data-action="skip-celebration">Skip celebration ⏭</button>
          <button type="button" class="btn btn-danger" data-action="open-close-room">Close room</button>
        ` : `
          <div class="celebration-sync-indicator"><span class="sync-dot"></span> Synchronized with auctioneer</div>
        `}
      </div>
      ${!ev.audioUrl ? `<p class="small-note celebration-audio-note">No audio clip is assigned to this franchise yet. Host can upload one in Team audio.</p>` : ''}
    </div>
  </div>`;

  // Start popper particles in foreground once
  startCelebrationConfetti(team, celebrationId);

  // Bind actions inside celebration modal
  const veil = document.getElementById('sale-veil');
  if (veil) {
    veil.querySelectorAll('[data-action]').forEach(btn => btn.addEventListener('click', async e => {
      e.stopPropagation();
      const action = btn.dataset.action;
      if (action === 'skip-celebration') {
        if (!state.isHost) return;
        stopCurrentAudio();
        if (state.celebrationTimeout) { clearTimeout(state.celebrationTimeout); state.celebrationTimeout = null; }
        state.celebration = null;
        dismissCelebrationUI();
        try {
          const result = await api(`/api/room/${encodeURIComponent(state.roomCode)}/action`, {
            method: 'POST',
            body: { action: 'skip-celebration', celebrationId }
          });
          acceptRoom(result.room, false);
          toast('Celebration skipped.', 'success');
        } catch (err) { toast(err.message, 'error'); }
        return;
      }
      if (action === 'open-close-room') {
        state.showCloseModal = true;
        renderRoom();
        return;
      }
    }));
  }
}

function handleRoomEvent(event) {
  if (event.type === 'sale') {
    const celebrationId = event.celebrationId || event.id || `${event.lotId}-${event.playerId}`;
    if (state.dismissedCelebrationIds.has(celebrationId)) {
      return; // Already dismissed, do not re-open
    }
    state.activeCelebrationId = celebrationId;
    state.celebration = event;
    state.celebrationStartedAt = Date.now();
    state.celebrationAudioError = false;
    if (state.celebrationTimeout) clearTimeout(state.celebrationTimeout);
    state.celebrationTimeout = null;

    syncCelebrationModal();
    playCelebrationAudio(event.audioUrl, celebrationId);
  } else if (event.type === 'celebration-audio-disabled') {
    stopCurrentAudio();
    if (state.celebration) {
      if (state.celebrationTimeout) clearTimeout(state.celebrationTimeout);
      if (state.isHost) {
        state.celebrationTimeout = setTimeout(() => {
          finishHostCelebration(state.activeCelebrationId);
        }, 3000);
      }
    }
  } else if (event.type === 'celebration-skipped' || event.type === 'celebration-ended') {
    const cId = event.celebrationId || state.activeCelebrationId;
    if (cId) state.dismissedCelebrationIds.add(cId);
    state.celebration = null;
    state.activeCelebrationId = null;
    if (state.celebrationTimeout) { clearTimeout(state.celebrationTimeout); state.celebrationTimeout = null; }
    stopCurrentAudio();
    dismissCelebrationUI();
    renderRoom();
  } else if (event.type === 'new-lot') {
    if (state.activeCelebrationId) state.dismissedCelebrationIds.add(state.activeCelebrationId);
    state.celebration = null;
    state.activeCelebrationId = null;
    if (state.celebrationTimeout) { clearTimeout(state.celebrationTimeout); state.celebrationTimeout = null; }
    stopCurrentAudio();
    dismissCelebrationUI();
    renderRoom();
  } else if (event.type === 'rtm-matched') {
    toast(`${event.teamId} exercised Right to Match (RTM) for ${event.playerName} at ₹${event.amountCr} Cr!`, 'success');
  } else if (event.type === 'unsold') {
    toast(event.automatic ? `${event.playerName} automatically marked UNSOLD.` : `${event.playerName} marked UNSOLD.`, 'error');
  } else if (event.type === 'auction-finished') {
    toast('Auction completed. Review the final squads and results.', 'success');
  } else if (event.type === 'round-start') {
    toast(`Unsold revisit round started · ${event.count} players returned.`, 'success');
  } else if (event.type === 'retention-finalized') {
    toast(`Retention phase completed. ${event.candidateCount} candidates queued for Mega Auction!`, 'success');
  } else if (event.type === 'room-closed') {
    stopPolling();
    stopCurrentAudio();
    if (state.celebrationTimeout) clearTimeout(state.celebrationTimeout);
    state.celebration = null;
    state.activeCelebrationId = null;
    dismissCelebrationUI();
    state.room = null;
    state.roomCode = null;
    state.existingRoomCode = null;
    state.participant = null;
    state.isHost = false;
    if (state.bootstrap) {
      state.bootstrap.hasActiveRoom = false;
      state.bootstrap.activeRoomCode = null;
    }
    store.removeItem('ipl27-participant');
    setUrlRoom(null);
    renderHome();
    toast(event.reason || 'The auction room has closed.', 'error');
  }
}

async function dismissCelebration() {
  const celebrationId = state.activeCelebrationId || state.celebration?.celebrationId || state.celebration?.id;
  if (celebrationId) state.dismissedCelebrationIds.add(celebrationId);
  state.celebration = null;
  state.activeCelebrationId = null;
  if (state.celebrationTimeout) {
    clearTimeout(state.celebrationTimeout);
    state.celebrationTimeout = null;
  }
  stopCurrentAudio();
  dismissCelebrationUI();

  if (!state.isHost) {
    renderRoom();
    return;
  }

  if (state.roomCode) {
    try {
      const result = await api(`/api/room/${encodeURIComponent(state.roomCode)}/action`, {
        method: 'POST',
        body: { action: 'skip-celebration', celebrationId }
      });
      acceptRoom(result.room, false);
      return;
    } catch (err) {
      console.warn('Failed to end celebration:', err);
    }
  }
  renderRoom();
}

let masterAudioPlayer = null;
function getGlobalAudio() {
  if (!masterAudioPlayer) {
    masterAudioPlayer = document.getElementById('auction-audio-player');
    if (!masterAudioPlayer) {
      masterAudioPlayer = document.createElement('audio');
      masterAudioPlayer.id = 'auction-audio-player';
      masterAudioPlayer.setAttribute('preload', 'auto');
      masterAudioPlayer.setAttribute('playsinline', '');
      masterAudioPlayer.setAttribute('webkit-playsinline', '');
      masterAudioPlayer.style.display = 'none';
      document.body.appendChild(masterAudioPlayer);
    }
  }
  return masterAudioPlayer;
}

const audioPreloadCache = {};
function preloadTeamAudio(audioMap) {
  if (!audioMap || typeof Audio === 'undefined') return;
  for (const url of Object.values(audioMap)) {
    if (url && !audioPreloadCache[url]) {
      const a = new Audio(url);
      a.preload = 'auto';
      audioPreloadCache[url] = a;
    }
  }
}

function playCelebrationAudio(audioUrl, celebrationId) {
  if (celebrationId && state.audioCelebrationId === celebrationId) {
    return; // Already started audio for this celebration
  }
  stopCurrentAudio();
  if (celebrationId) state.audioCelebrationId = celebrationId;

  const celebAudioOn = state.room?.celebrationAudioEnabled !== false;

  // Case B (No audio exists) & Case C (Host audio setting is OFF) & Muted
  if (state.muteAudio || !audioUrl || !celebAudioOn) {
    if (state.isHost) {
      // Exact 3,000 ms celebration duration fallback
      state.celebrationTimeout = setTimeout(() => {
        finishHostCelebration(celebrationId);
      }, 3000);
    }
    return;
  }

  // Case A (Audio exists and host audio enabled)
  try {
    const audio = getGlobalAudio();
    audio.src = audioUrl;
    audio.volume = state.muteAudio ? 0 : state.audioVolume;
    state.currentAudio = audio;

    const onEnded = () => {
      stopCurrentAudio();
      if (state.isHost) {
        finishHostCelebration(celebrationId);
      }
    };
    state.currentAudioListener = onEnded;
    audio.addEventListener('ended', onEnded, { once: true });

    audio.addEventListener('error', (err) => {
      console.warn('[AUDIO ERROR]', err);
      state.celebrationAudioError = true;
      stopCurrentAudio();
      if (state.isHost) {
        // Case D: Exact 3,000 ms fallback on error
        state.celebrationTimeout = setTimeout(() => finishHostCelebration(celebrationId), 3000);
      }
    }, { once: true });

    const promise = audio.play();
    if (promise && typeof promise.then === 'function') {
      promise.then(() => {
        state.audioUnlocked = true;
        state.audioAutoplayBlocked = false;
        state.celebrationAudioError = false;
      }).catch((err) => {
        console.warn('[AUDIO AUTOPLAY BLOCKED]', err);
        state.audioAutoplayBlocked = true;
        state.celebrationAudioError = true;
        if (state.isHost) {
          // Case D: Exact 3,000 ms fallback if host autoplay blocked
          state.celebrationTimeout = setTimeout(() => finishHostCelebration(celebrationId), 3000);
        }
      });
    }
  } catch (err) {
    console.warn('[AUDIO PLAY EXCEPTION]', err);
    state.celebrationAudioError = true;
    if (state.isHost) {
      state.celebrationTimeout = setTimeout(() => finishHostCelebration(celebrationId), 3000);
    }
  }
}

function testAudio(audioUrl) {
  if (!audioUrl) return;
  stopCurrentAudio();
  try {
    const audio = getGlobalAudio();
    if (state.currentTestingUrl === audioUrl && !audio.paused) {
      audio.pause();
      audio.currentTime = 0;
      state.currentTestingUrl = null;
      return;
    }
    audio.src = audioUrl;
    audio.volume = state.muteAudio ? 0 : state.audioVolume;
    state.currentAudio = audio;
    state.currentTestingUrl = audioUrl;
    const p = audio.play();
    if (p?.catch) {
      p.catch((err) => {
        console.warn('[TEST AUDIO ERROR]', err);
        toast('Autoplay requires permission. Tap "Enable auction audio" in the top bar.', 'error');
      });
    }
    if (p?.then) {
      p.then(() => {
        state.audioUnlocked = true;
        toast('Previewing anthem. Autoplay active.', 'success');
      });
    }
  } catch (err) {
    toast('Could not play audio clip: ' + err.message, 'error');
  }
}

// Authoritative timer rendering calculated strictly from deadline
function updateTimerText() {
  const room = state.room;
  if (!room) return;
  const timer = document.getElementById('timer-value');
  const timerBar = document.getElementById('timer-fill');
  const timerCaption = document.getElementById('timer-caption');
  if (!timer) return;

  let remainMs = 0;
  const isBidding = room.status === 'live' && room.lotState === 'bidding';
  if (room.status === 'paused') {
    remainMs = room.pausedRemainingMs || 0;
  } else if (isBidding && room.bidEndsAt) {
    remainMs = Math.max(0, room.bidEndsAt - Date.now());
  } else {
    remainMs = 0;
  }

  const seconds = Math.ceil(remainMs / 1000);
  timer.textContent = (room.status === 'ready' || room.status === 'retention') ? '—' :
                      room.status === 'finished' ? '✓' :
                      room.status === 'paused' ? String(seconds).padStart(2, '0') :
                      room.lotState === 'settling' ? '00' :
                      (room.lotState === 'celebration' || room.celebrationActive) ? '✓' :
                      room.lotState === 'unsold_pause' ? '×' :
                      room.lotDone ? '—' :
                      !isBidding ? '—' :
                      String(seconds).padStart(2, '0');

  // Visual warning pulse when bidding time is running out (<= 3 seconds)
  if (isBidding && remainMs <= 3000 && remainMs > 0) {
    timer.classList.add('timer-warning');
  } else {
    timer.classList.remove('timer-warning');
  }

  const totalDuration = (room.timerSeconds || 10) * 1000;
  const pct = room.status === 'paused'
    ? (room.pausedRemainingMs / totalDuration) * 100
    : isBidding && room.bidEndsAt
      ? (remainMs / totalDuration) * 100
      : 0;

  if (timerBar) timerBar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  if (timerCaption) {
    timerCaption.textContent = room.status === 'paused'
      ? 'Auction paused by host'
      : room.status === 'retention'
        ? 'Retention review in progress'
        : room.status === 'ready'
          ? 'Timer starts when auction opens'
          : room.status === 'finished'
            ? 'Auction complete'
            : room.lotState === 'settling'
              ? 'Timer ended · Settling lot…'
              : (room.celebrationActive || room.lotState === 'celebration')
                ? 'Player SOLD · Victory anthem playing'
                : room.lotState === 'unsold_pause'
                  ? 'Player UNSOLD · Next candidate in a moment'
                  : room.lotDone
                    ? 'Lot settled'
                    : seconds === 0
                      ? 'Hammer falling · settling lot…'
                      : 'Timer resets after each valid bid';
  }
}

function activeParticipant() {
  return state.participant && state.room?.participants?.find(p => p.clientId === clientId);
}

function statusPill(status) {
  const c = status === 'live' ? 'live' : status === 'paused' ? 'paused' : status === 'finished' ? 'finished' : status === 'retention' ? 'ready' : 'ready';
  const label = status === 'live' ? 'Live auction' : status === 'paused' ? 'Paused' : status === 'finished' ? 'Completed' : status === 'retention' ? 'Retention Phase' : 'Ready to start';
  return `<span class="status-pill ${c}"><span class="pill-dot"></span>${label}</span>`;
}

function headerMarkup(inRoom = false) {
  const volumeControl = `<div class="volume-control-wrap"><button type="button" data-action="toggle-mute" title="${state.muteAudio ? 'Unmute' : 'Mute'}">${state.muteAudio ? '🔇' : '🔊'}</button><input type="range" class="volume-slider" min="0" max="1" step="0.05" value="${state.muteAudio ? 0 : state.audioVolume}" data-action="change-volume" title="Volume (${Math.round(state.audioVolume * 100)}%)" /></div>`;
  const audioUnlockBtn = (inRoom && !state.audioUnlocked) ? `<button type="button" class="btn btn-audio-enable" data-action="unlock-audio" title="Click to enable auction audio and victory sound effects">🔊 <span>Enable auction audio</span></button>` : '';

  return `<header class="topbar">
    <a class="brand" href="/" data-action="home"><span class="brand-mark">IPL27</span><span class="brand-word">AUCTION ROOM<small>FAN-MADE SEASON SIMULATOR</small></span></a>
    <div class="topbar-mid">${inRoom ? `<span class="pill"><span class="pill-dot"></span>2027 PREDICTED POOL</span><span class="pill">${state.room?.auctionOrder?.length || 182} CANDIDATES</span>` : `<span class="pill"><span class="pill-dot"></span>2027 FAN EDITION</span>`}</div>
    <div class="topbar-spacer"></div>
    <div class="topbar-actions">${audioUnlockBtn}${volumeControl}${inRoom ? `<button type="button" class="btn btn-ghost btn-sm" data-action="copy-room"><span>Room</span> ${escapeHtml(state.roomCode)} ⧉</button>${state.isHost ? `<button type="button" class="btn btn-secondary btn-sm" data-action="open-audio">♫ <span>Team audio</span></button><button type="button" class="btn btn-danger btn-sm" data-action="open-close-room" title="Close this auction room">✕ <span>Close Room</span></button>` : ''}` : `<span class="pill">NOT AFFILIATED WITH IPL</span>`}</div>
  </header>`;
}

function renderCloseModal() {
  const code = state.roomCode || state.room?.code || state.existingRoomCode || state.activeRoomData?.roomCode || (state.bootstrap && state.bootstrap.activeRoomCode) || '';
  return `<div class="modal-veil" id="close-modal-veil" style="display:flex;align-items:center;justify-content:center;position:fixed;inset:0;background:rgba(8,17,27,0.8);z-index:99999;backdrop-filter:blur(4px)">
    <div class="modal-card" style="max-width:480px;width:92%;background:#ffffff;color:#08111b;border-radius:12px;padding:26px;box-shadow:0 24px 48px rgba(0,0,0,0.45);border-top:5px solid var(--accent, #D71920)">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px">
        <h3 style="margin:0;font-size:21px;font-weight:800;color:#08111b">Close Room & End Auction</h3>
        <button type="button" class="close-x" data-action="cancel-close-room" style="color:#64748b;font-size:24px;line-height:1">×</button>
      </div>
      <p style="margin:0 0 20px;color:#475569;font-size:14px;line-height:1.55">
        Closing ${code ? `room <strong>${escapeHtml(code)}</strong>` : 'this room'} will permanently end the current auction, disconnect all participating franchises, and release the active-room restriction so you can immediately configure and start a new auction.
      </p>
      <div style="display:flex;justify-content:flex-end;gap:10px">
        <button type="button" class="btn btn-secondary" data-action="cancel-close-room">Cancel</button>
        <button type="button" class="btn btn-danger" data-action="confirm-close-room">Confirm & Close Room</button>
      </div>
    </div>
  </div>`;
}

async function handleConfirmCloseRoom() {
  state.showCloseModal = false;
  const targetCode = state.existingRoomCode || state.roomCode || state.room?.code || state.activeRoomData?.roomCode || (state.bootstrap && state.bootstrap.activeRoomCode);
  try {
    if (targetCode) {
      await api(`/api/room/${encodeURIComponent(targetCode)}/close`, { method: 'POST' }).catch(() => {
        return api('/api/host/close-room', { method: 'POST' });
      });
    } else {
      await api('/api/host/close-room', { method: 'POST' });
    }
  } catch (err) {
    console.warn('[CLOSE ROOM]', err.message);
  } finally {
    stopPolling();
    stopCurrentAudio();
    if (state.celebrationTimeout) clearTimeout(state.celebrationTimeout);
    state.celebration = null;
    state.activeCelebrationId = null;
    dismissCelebrationUI();
    state.room = null;
    state.roomCode = null;
    state.existingRoomCode = null;
    state.activeRoomData = null;
    state.participant = null;
    state.isHost = false;
    store.removeItem('ipl27-owner-room');
    store.removeItem('ipl27-participant');
    if (state.bootstrap) {
      state.bootstrap.hasActiveRoom = false;
      state.bootstrap.activeRoomCode = null;
    }
    setUrlRoom(null);
    state.homePanel = 'host';
    state.ownerReady = true;
    renderHome();
    toast('Room authoritatively closed. You can now configure and start a new auction.', 'success');
  }
}

function renderHeroArt() {
  return `<div class="hero-art"><div class="orbit"></div><div class="hero-ticket"><div class="ticket-top"><span>Indian Premier League</span><span>2027 · Fan Edition</span></div><div class="ticket-number">BID<br/>WAR.</div><div class="ticket-title">ONE PLAYER. TEN FRANCHISES.</div><div class="ticket-copy">Every raise changes the purse. Every sale changes the squad. Every room has one auctioneer.</div><div class="ticket-ribbon"><b>LIVE</b><span>AUCTION SIMULATOR</span></div></div><div class="float-chip one"><span class="float-icon">₹</span><div><strong>Track every crore</strong><span>Spent · Remaining · Squad slots</span></div></div><div class="float-chip two"><span class="float-icon">✦</span><div><strong>Sold with a soundtrack</strong><span>Upload franchise hook-line clips</span></div></div></div>`;
}

function renderHostGuide() {
  const isMega = state.selectedMode === 'mega';
  return `<div class="hero-host-guide">
    <div class="host-guide-badge"><span class="pill status-pill live"><span class="pill-dot"></span>Host Console · Room Setup</span></div>
    <h1 class="hero-title host-title">Configure your<br/><span>IPL 2027 room.</span></h1>
    <p class="hero-copy">Set your auction format, bid timer, and budget rules. Once opened, participants can join your live room to bid for players in real-time.</p>
    <div class="host-rule-cards">
      <div class="host-rule-card">
        <div class="rule-icon">🏏</div>
        <div>
          <strong>${isMega ? 'Mega Auction Mode' : 'Mini Auction Mode'}</strong>
          <span>${isMega
            ? 'IPL 2025–27 retention review (slabs ₹18, 14, 11, 18, 14 Cr capped & ₹4 Cr uncapped) followed by candidate pool bidding.'
            : 'Teams retain working squad baselines with trade-adjusted purses and compete for 182 auction candidates.'}</span>
        </div>
      </div>
      <div class="host-rule-card">
        <div class="rule-icon">⏱</div>
        <div>
          <strong>Authoritative Countdown</strong>
          <span>Live server deadline with resetting countdown timer on every new raise, plus unsold revisit rounds.</span>
        </div>
      </div>
      <div class="host-rule-card">
        <div class="rule-icon">♫</div>
        <div>
          <strong>Franchise Soundtracks</strong>
          <span>Winning bids trigger custom franchise celebration hook-lines for an authentic IPL auction experience.</span>
        </div>
      </div>
    </div>
    <div class="hero-metrics">
      <div class="metric"><strong>10</strong><span>Franchises</span></div>
      <div class="metric"><strong>182</strong><span>Candidate pool</span></div>
      <div class="metric"><strong>1</strong><span>Active room</span></div>
    </div>
  </div>`;
}

function renderHome() {
  stopPolling();
  if (state.timerInterval) clearInterval(state.timerInterval);
  const queryCode = new URLSearchParams(window.location.search).get('room') || '';
  const isHostSetup = Boolean(state.ownerReady);

  // If host console is unlocked and host is in Player Pool Manager or Franchise Audio tab, render dedicated full-width workspace
  if (isHostSetup && state.hostTab === 'pool') {
    app.innerHTML = `${headerMarkup(false)}
      <main class="landing host-workspace-landing"><div class="landing-inner host-workspace-inner">
        <div class="kicker">Candidate Pool Management · IPL 2027 Fan Edition</div>
        <div class="pool-manager-workspace-full">
          ${renderPlayerPoolManager()}
        </div>
        <div class="footer-note">Fan-made cricket simulator. Predicted 2027 registrations, squad baselines and purse adjustments are editable assumptions—not official IPL announcements.</div>
      </div></main>
      ${state.showJoinModal ? renderJoinModal() : ''}${state.showCloseModal ? renderCloseModal() : ''}`;
    bindHomeHandlers();
    return;
  }

  if (isHostSetup && state.hostTab === 'audio') {
    app.innerHTML = `${headerMarkup(false)}
      <main class="landing host-workspace-landing"><div class="landing-inner host-workspace-inner">
        <div class="kicker">Franchise Audio Management · IPL 2027 Fan Edition</div>
        <div class="audio-manager-workspace-full">
          ${renderHostAudioTab()}
        </div>
        <div class="footer-note">Fan-made cricket simulator. Predicted 2027 registrations, squad baselines and purse adjustments are editable assumptions—not official IPL announcements.</div>
      </div></main>
      ${state.showJoinModal ? renderJoinModal() : ''}${state.showCloseModal ? renderCloseModal() : ''}`;
    bindHomeHandlers();
    return;
  }

  const rightPanel = isHostSetup
    ? renderHostSetup()
    : state.homePanel === 'host'
      ? renderOwnerLogin()
      : state.homePanel === 'join'
        ? renderJoinCard(queryCode)
        : renderHeroArt();

  const leftPanel = isHostSetup ? renderHostGuide() : `<div>
    <h1 class="hero-title">Build your<br/><span>champion squad.</span></h1>
    <p class="hero-copy">Run a dramatic IPL-style player auction. Set the purse, raise the paddle, fight for the biggest names, and watch every franchise squad update as the hammer comes down.</p>
    <div class="hero-ctas"><button type="button" class="btn btn-primary btn-lg" data-action="select-home" data-panel="host">Host an auction <span>↗</span></button><button type="button" class="btn btn-secondary btn-lg" data-action="select-home" data-panel="join">Join a room <span>→</span></button></div>
    <div class="hero-metrics"><div class="metric"><strong>10</strong><span>Franchises</span></div><div class="metric"><strong>182</strong><span>Candidate pool</span></div><div class="metric"><strong>LIVE</strong><span>Shared bidding</span></div></div>
  </div>`;

  app.innerHTML = `${headerMarkup(false)}
    <main class="landing"><div class="landing-inner">
      <div class="kicker">The auction starts here · 2027 fan edition</div>
      <section class="hero-grid ${isHostSetup ? 'host-mode' : ''}">
        ${leftPanel}
        ${rightPanel}
      </section>
      <section class="landing-bottom">
        <article class="feature-card"><div class="feature-icon">⌁</div><div><h3>Real-time auction floor</h3><p>Authoritative server deadline, live bids, resetting countdown, host SOLD/UNSOLD controls and unsold revisit rounds.</p></div></article>
        <article class="feature-card"><div class="feature-icon">▤</div><div><h3>IPL 2025–27 Retention Model</h3><p>Full retention ruleset: slabs ₹18, 14, 11, 18, 14 Cr, uncapped ₹4 Cr, max 6 combined retentions/RTMs.</p></div></article>
      </section>
      <div class="footer-note">Fan-made cricket simulator. Predicted 2027 registrations, squad baselines and purse adjustments are editable assumptions—not official IPL announcements.</div>
    </div></main>
    ${state.showJoinModal ? renderJoinModal() : ''}${state.showCloseModal ? renderCloseModal() : ''}`;
  bindHomeHandlers();
}

function renderJoinCard(queryCode) {
  return `<div class="form-card"><div class="kicker">Room access</div><h2>Join the auction</h2><p class="sub">Enter the six-character room code shared by the host. You can claim one franchise or join as a spectator.</p><form id="quick-join-form"><div class="field"><label>Room code</label><input class="input" id="quick-room-code" name="code" maxlength="6" placeholder="E.G. K7M4QX" autocomplete="off" value="${escapeHtml(queryCode)}" required /></div><button type="submit" class="btn btn-primary btn-block btn-lg">Find room <span>→</span></button></form><div style="height:19px"></div><div class="small-note">Room creation is restricted to the site owner. Only one room can be active at once.</div></div>`;
}

function renderOwnerLogin() {
  return `<div class="form-card"><div class="kicker">Owner console</div><h2>Create a room</h2><p class="sub">Owner access is required. Once signed in, choose Mini or Mega Auction and configure the floor.</p><form id="owner-login-form"><div class="field"><label>Owner access code</label><input class="input" id="owner-code" type="password" autocomplete="current-password" placeholder="Enter owner access code" required /></div><button type="submit" class="btn btn-primary btn-block btn-lg">Unlock host controls <span>→</span></button></form><p class="small-note" style="margin-top:13px">Local default: <b>ipl2027owner</b>. Change <code>HOST_ACCESS_CODE</code> before hosting on a public network.</p></div>`;
}

function renderExistingRoomCard(activeData) {
  const room = activeData.room;
  const info = activeData.activeRoomInfo || {};
  const code = room?.code || info.code || state.activeRoomData?.roomCode || '';
  const mode = (room?.mode || info.mode || 'mini').toUpperCase();
  const retMode = (room?.retentionMode || info.retentionMode || 'host') === 'participants'
    ? 'Participants select retentions'
    : 'Host selects retentions';
  const statusRaw = room?.status || info.status || 'ready';
  const statusLabel = statusRaw === 'retention' ? 'Retention Phase'
    : statusRaw === 'ready' ? 'Ready to Open'
    : statusRaw === 'live' ? 'Live Bidding Floor'
    : statusRaw === 'paused' ? 'Auction Paused'
    : statusRaw === 'finished' ? 'Auction Finished'
    : statusRaw.toUpperCase();

  const claimedCount = info.franchisesClaimed ?? (room?.teams?.filter(t => (room.participants || []).some(p => p.teamId === t.id)).length ?? 0);
  const totalParts = info.totalParticipants ?? (room?.participants?.length ?? 0);
  const pName = info.currentPlayerName || (room ? currentPlayer(room)?.name : null);
  const pRole = info.currentPlayerRole || (room ? currentPlayer(room)?.role : null);
  const pPrice = info.currentPlayerBasePrice || (room ? (room.basePriceOverrides[currentPlayer(room)?.id] ?? currentPlayer(room)?.basePriceCr) : null);

  return `<div class="form-card existing-room-card">
    ${renderHostSubnav()}
    <div class="kicker" style="color:var(--accent,#D71920)">Existing Auction Room</div>
    <h2>You have an active auction room</h2>
    <p class="sub">An auction room is currently active on the server. You can resume managing it or close it to start a new auction.</p>

    <div class="existing-room-details">
      <div class="existing-room-code-badge">
        <span class="code-label">ROOM CODE</span>
        <strong class="code-value">${escapeHtml(code)}</strong>
      </div>
      <div class="existing-room-meta-grid">
        <div class="existing-meta-item">
          <small>Auction Format</small>
          <strong>${escapeHtml(mode)} AUCTION</strong>
          <span>${mode === 'MEGA' ? escapeHtml(retMode) : 'Working squads & purses'}</span>
        </div>
        <div class="existing-meta-item">
          <small>Current Status</small>
          <strong>${escapeHtml(statusLabel)}</strong>
          <span>${room?.round ? `Round ${room.round}` : 'Floor in session'}</span>
        </div>
        <div class="existing-meta-item">
          <small>Franchises Claimed</small>
          <strong>${claimedCount} / 10 Claimed</strong>
          <span>${totalParts} connected</span>
        </div>
        <div class="existing-meta-item">
          <small>Current Lot</small>
          <strong>${pName ? escapeHtml(pName) : (statusRaw === 'retention' ? 'Retention draft' : 'Awaiting start')}</strong>
          <span>${pName ? `${escapeHtml(pRole || '')} · ${fmtCr(pPrice)}` : 'Floor ready'}</span>
        </div>
      </div>
    </div>

    <div class="existing-room-actions">
      <button type="button" class="btn btn-primary btn-block btn-lg" data-action="resume-existing-room">Resume Existing Room ↗</button>
      <button type="button" class="btn btn-danger btn-block" data-action="open-close-room" data-room="${escapeHtml(code)}">Close Room & Start New Auction</button>
    </div>

    <p class="small-note" style="margin-top:14px;text-align:center">Closing this room releases the server active room lock so you can immediately configure a new auction.</p>
    <button type="button" class="btn btn-ghost btn-sm" style="margin-top:10px;width:100%" data-action="logout-owner">Sign out of host console</button>
  </div>`;
}

function renderHostSubnav() {
  const count = (state.bootstrap?.candidates || []).length || 182;
  const isSetup = state.hostTab !== 'pool' && state.hostTab !== 'audio';
  const isPool = state.hostTab === 'pool';
  const isAudio = state.hostTab === 'audio';

  return `<nav class="host-subnav" aria-label="Host Console Navigation">
    <button type="button" class="btn ${isSetup ? 'btn-primary active' : 'btn-secondary'} host-nav-tab" data-action="switch-host-tab" data-tab="setup" aria-current="${isSetup ? 'page' : 'false'}">
      <span class="host-nav-icon">⚡</span>
      <span class="host-nav-label">Auction Room Setup</span>
    </button>
    <button type="button" class="btn ${isPool ? 'btn-primary active' : 'btn-secondary'} host-nav-tab" data-action="switch-host-tab" data-tab="pool" aria-current="${isPool ? 'page' : 'false'}">
      <span class="host-nav-icon">👥</span>
      <span class="host-nav-label">Player Pool Manager <span class="host-nav-badge">(${count})</span></span>
    </button>
    <button type="button" class="btn ${isAudio ? 'btn-primary active' : 'btn-secondary'} host-nav-tab" data-action="switch-host-tab" data-tab="audio" aria-current="${isAudio ? 'page' : 'false'}">
      <span class="host-nav-icon">🎵</span>
      <span class="host-nav-label">Franchise Audio</span>
    </button>
  </nav>`;
}

function saveHostSetupDraft() {
  const form = document.getElementById('host-setup-form');
  if (!form) return;
  const fd = new FormData(form);
  state.hostSetupDraft = {
    timerSeconds: Number(fd.get('timerSeconds') || 10),
    maxSquadSize: Number(fd.get('maxSquadSize') || 25),
    maxOverseas: Number(fd.get('maxOverseas') || 8),
    megaPurseCr: Number(fd.get('megaPurseCr') || 120),
    miniPurseAddOnCr: Number(fd.get('miniPurseAddOnCr') ?? 5),
    revisitUnsold: fd.has('revisitUnsold'),
    randomOrder: fd.has('randomOrder'),
    retentionMode: state.selectedRetentionMode || 'host'
  };
}

function renderHostSetup() {
  if (state.activeRoomData && state.activeRoomData.room) {
    return renderExistingRoomCard(state.activeRoomData);
  }

  if (state.hostTab === 'pool') {
    return renderPlayerPoolManager();
  }
  if (state.hostTab === 'audio') {
    return renderHostAudioTab();
  }

  const existingCode = state.existingRoomCode || (state.bootstrap && state.bootstrap.hasActiveRoom && state.bootstrap.activeRoomCode) || state.roomCode || state.room?.code;
  const activeRoomAlert = existingCode ? `
    <div class="active-room-alert" style="background:rgba(215,25,32,0.12);border:1px solid rgba(215,25,32,0.4);border-radius:8px;padding:12px 14px;margin-bottom:16px;display:flex;justify-content:space-between;align-items:center;gap:10px">
      <div>
        <div style="font-size:11px;font-weight:800;color:var(--accent,#D71920);text-transform:uppercase;letter-spacing:0.5px">Active Room in Session</div>
        <div style="font-size:13px;color:#eaf1f8;margin-top:2px">Room <strong>${escapeHtml(existingCode)}</strong> is currently active. Close it or resume it.</div>
      </div>
      <div style="display:flex;gap:8px;flex-shrink:0">
        <button type="button" class="btn btn-secondary btn-sm" data-action="resume-existing-room" data-room="${escapeHtml(existingCode)}">Resume ↗</button>
        <button type="button" class="btn btn-danger btn-sm" data-action="open-close-room" data-room="${escapeHtml(existingCode)}">Close Room</button>
      </div>
    </div>` : '';

  const draft = state.hostSetupDraft || {};
  const timerSec = draft.timerSeconds ?? 10;
  const maxSquad = draft.maxSquadSize ?? 25;
  const maxOvs = draft.maxOverseas ?? 8;
  const megaPurse = draft.megaPurseCr ?? 120;
  const miniAddon = draft.miniPurseAddOnCr ?? 5;
  const revUnsold = draft.revisitUnsold !== undefined ? draft.revisitUnsold : true;
  const randOrd = draft.randomOrder !== undefined ? draft.randomOrder : false;

  const purseLines = (state.bootstrap?.teams || []).map(t => `<div class="team-card" style="${teamStyle(t)}"><div class="team-card-top">${teamBadge(t.id)}<div class="team-card-name"><strong>${escapeHtml(t.short)}</strong><small>${escapeHtml(t.name)}</small></div></div><div class="team-purse-line"><small>Working purse</small><strong>${fmtCr(t.basePurseCr)}</strong></div></div>`).join('');
  return `<div class="form-card">
    ${renderHostSubnav()}
    <div class="kicker">Host setup</div><h2>Configure your auction</h2><p class="sub">Pick the format and the room settings. These are your fan-made rules and budgets.</p>
    ${activeRoomAlert}
    <form id="host-setup-form">
      <div class="radio-grid"><button type="button" class="radio-card ${state.selectedMode === 'mini' ? 'selected' : ''}" data-action="select-mode" data-mode="mini"><strong>Mini Auction</strong><span>Existing working squads, updated trade-adjusted purses, candidate pool buys.</span></button><button type="button" class="radio-card ${state.selectedMode === 'mega' ? 'selected' : ''}" data-action="select-mode" data-mode="mega"><strong>Mega Auction</strong><span>Interactive retention review (IPL 2025–27 slabs), released players pool reconstruction, and full rebuild.</span></button></div>
      <div class="field-row"><div class="field"><label>Bid timer</label><select class="select" name="timerSeconds"><option value="8" ${timerSec === 8 ? 'selected' : ''}>8 seconds</option><option value="10" ${timerSec === 10 ? 'selected' : ''}>10 seconds</option><option value="15" ${timerSec === 15 ? 'selected' : ''}>15 seconds</option><option value="20" ${timerSec === 20 ? 'selected' : ''}>20 seconds</option><option value="30" ${timerSec === 30 ? 'selected' : ''}>30 seconds</option></select></div><div class="field"><label>Squad size limit</label><select class="select" name="maxSquadSize"><option value="23" ${maxSquad === 23 ? 'selected' : ''}>23</option><option value="25" ${maxSquad === 25 ? 'selected' : ''}>25</option><option value="26" ${maxSquad === 26 ? 'selected' : ''}>26</option><option value="28" ${maxSquad === 28 ? 'selected' : ''}>28</option></select></div></div>
      <div class="field-row"><div class="field"><label>Overseas slots</label><select class="select" name="maxOverseas"><option value="6" ${maxOvs === 6 ? 'selected' : ''}>6</option><option value="8" ${maxOvs === 8 ? 'selected' : ''}>8</option><option value="9" ${maxOvs === 9 ? 'selected' : ''}>9</option></select></div><div class="field ${state.selectedMode === 'mega' ? '' : 'hide'}" id="mega-purse-field"><label>Mega purse per team (₹ Cr)</label><input class="input" type="number" min="10" max="500" step="5" name="megaPurseCr" value="${megaPurse}" /></div><div class="field ${state.selectedMode === 'mini' ? '' : 'hide'}" id="mini-addon-field"><label>Mini purse add-on (₹ Cr)</label><input class="input" type="number" min="0" max="50" step="1" name="miniPurseAddOnCr" value="${miniAddon}" /></div></div>
      <label class="check-row"><input type="checkbox" name="revisitUnsold" ${revUnsold ? 'checked' : ''} /> <span>Bring unsold players back for one final revisit round.</span></label>
      <label class="check-row"><input type="checkbox" name="randomOrder" ${randOrd ? 'checked' : ''} /> <span>Randomize the player order instead of using the proposed auction-set grouping.</span></label>
      ${state.selectedMode === 'mega' ? `
      <div class="field" style="margin-top:14px">
        <label style="font-weight:700;margin-bottom:8px">Who will select the franchise retentions?</label>
        <div class="radio-grid" style="margin-top:4px">
          <button type="button" class="radio-card ${state.selectedRetentionMode !== 'participants' ? 'selected' : ''}" data-action="select-ret-mode" data-ret-mode="host">
            <strong>Host selects retentions for all 10 franchises</strong>
            <span>The host selects and configures the retention list for every franchise before the auction begins.</span>
          </button>
          <button type="button" class="radio-card ${state.selectedRetentionMode === 'participants' ? 'selected' : ''}" data-action="select-ret-mode" data-ret-mode="participants">
            <strong>Participants select retentions for their own franchises</strong>
            <span>Each franchise owner selects their own team's retentions when joining the mega auction room.</span>
          </button>
        </div>
      </div>
      ` : ''}
      ${state.selectedMode === 'mini' ? `<div style="margin:18px 0 8px;font-size:10px;color:#8ea0b3;text-transform:uppercase;font-weight:900;letter-spacing:1px">Mini purse preview · after ₹5 Cr adjustment and trade model</div><div class="team-grid">${purseLines}</div>` : `<div class="notice" style="margin:15px 0">Mega Auction begins with an interactive franchise retention review phase under IPL 2025–27 reference rules: max 6 retentions/RTMs (slabs ₹18, 14, 11, 18, 14 Cr capped; ₹4 Cr uncapped). Unretained players are released into the candidate pool.</div>`}
      <button type="submit" class="btn btn-primary btn-block btn-lg" style="margin-top:17px">Create one active room <span>↗</span></button>
    </form><div class="small-note" style="margin-top:12px">The server enforces one active room globally.</div>
    <button type="button" class="btn btn-ghost btn-sm" style="margin-top:12px" data-action="logout-owner">Sign out of host console</button>
  </div>`;
}


// -----------------------------------------------------------------------------
// Host Player Pool Manager Renderers (Task 1)
// -----------------------------------------------------------------------------
function renderPlayerPoolManager() {
  const allCandidates = state.bootstrap?.candidates || [];
  const pm = state.poolManager;

  // Compute stats
  const total = allCandidates.length;
  const domestic = allCandidates.filter(c => c.origin === 'Domestic').length;
  const overseas = allCandidates.filter(c => c.origin === 'Overseas').length;
  const capped = allCandidates.filter(c => c.cappedStatus === 'Capped').length;
  const uncapped = allCandidates.filter(c => c.cappedStatus === 'Uncapped').length;
  const excluded = allCandidates.filter(c => c.excluded === true).length;

  // Filter candidates
  let filtered = allCandidates.filter(p => {
    if (pm.search) {
      const q = pm.search.toLowerCase();
      const match = `${p.name} ${p.role} ${p.nationality || ''} ${p.origin || ''} ${p.auctionSet || ''}`.toLowerCase();
      if (!match.includes(q)) return false;
    }
    if (pm.role !== 'all') {
      const roleMatch = (p.roleBucket || p.role || '').toLowerCase();
      if (!roleMatch.includes(pm.role.toLowerCase())) return false;
    }
    if (pm.origin !== 'all' && p.origin !== pm.origin) return false;
    if (pm.capped !== 'all' && p.cappedStatus !== pm.capped) return false;
    if (pm.basePrice !== 'all') {
      const val = Number(pm.basePrice);
      if (Math.abs(p.basePriceCr - val) > 0.01) return false;
    }
    if (pm.poolEligibility === 'active' && p.excluded) return false;
    if (pm.poolEligibility === 'excluded' && !p.excluded) return false;
    if (pm.poolEligibility === 'mini' && (p.includeInMini === false || p.excluded)) return false;
    if (pm.poolEligibility === 'mega' && (p.includeInMega === false || p.excluded)) return false;
    return true;
  });

  // Sort candidates
  if (pm.sort === 'name-asc') {
    filtered.sort((a, b) => a.name.localeCompare(b.name));
  } else if (pm.sort === 'name-desc') {
    filtered.sort((a, b) => b.name.localeCompare(a.name));
  } else if (pm.sort === 'price-desc') {
    filtered.sort((a, b) => b.basePriceCr - a.basePriceCr);
  } else if (pm.sort === 'price-asc') {
    filtered.sort((a, b) => a.basePriceCr - b.basePriceCr);
  }

  // Pagination
  const pageSize = pm.pageSize || 15;
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(Math.max(1, pm.page || 1), totalPages);
  const startIdx = (currentPage - 1) * pageSize;
  const pageItems = filtered.slice(startIdx, startIdx + pageSize);

  const priceOptions = [2.00, 1.50, 1.25, 1.00, 0.75, 0.50, 0.40, 0.30, 0.20].map(val =>
    `<option value="${val}" ${pm.basePrice === String(val) ? 'selected' : ''}>${fmtCr(val)}</option>`
  ).join('');

  return `<div class="form-card" style="max-width:1160px;margin:0 auto">
    ${renderHostSubnav()}
    <div class="pool-manager-wrap">
      <div class="pool-manager-head">
        <div>
          <div class="kicker">Candidate Pool Management</div>
          <h2>Player Pool Registry</h2>
          <p class="sub" style="margin:4px 0 0">Configure registered auction lots, candidate metadata, base prices, and pool eligibility for IPL 2027.</p>
        </div>
        <div class="pool-manager-actions">
          <button type="button" class="btn btn-primary" data-action="open-add-player">+ Add New Player</button>
          <button type="button" class="btn btn-secondary" data-action="export-pool-backup">📥 Export JSON Backup</button>
        </div>
      </div>

      <div class="pool-stats-row">
        <div class="pool-stat-box"><small>Total Candidates</small><strong>${total}</strong></div>
        <div class="pool-stat-box"><small>Domestic (India)</small><strong>${domestic}</strong></div>
        <div class="pool-stat-box"><small>Overseas</small><strong>${overseas}</strong></div>
        <div class="pool-stat-box"><small>Capped</small><strong>${capped}</strong></div>
        <div class="pool-stat-box"><small>Uncapped</small><strong>${uncapped}</strong></div>
        <div class="pool-stat-box"><small>Excluded from Pool</small><strong style="color:${excluded > 0 ? '#ef4444' : '#10b981'}">${excluded}</strong></div>
      </div>

      <div class="pool-filters-bar">
        <input class="input" id="pool-mgr-search" placeholder="🔍 Search candidate name..." value="${escapeHtml(pm.search || '')}"/>
        <select class="select" id="pool-mgr-role">
          <option value="all">All Roles</option>
          <option value="Batter" ${pm.role === 'Batter' ? 'selected' : ''}>Batter</option>
          <option value="Bowler" ${pm.role === 'Bowler' ? 'selected' : ''}>Bowler</option>
          <option value="All-rounder" ${pm.role === 'All-rounder' ? 'selected' : ''}>All-Rounder</option>
          <option value="Keeper" ${pm.role === 'Keeper' ? 'selected' : ''}>Wicketkeeper</option>
        </select>
        <select class="select" id="pool-mgr-origin">
          <option value="all">All Origins</option>
          <option value="Domestic" ${pm.origin === 'Domestic' ? 'selected' : ''}>Domestic (India)</option>
          <option value="Overseas" ${pm.origin === 'Overseas' ? 'selected' : ''}>Overseas</option>
        </select>
        <select class="select" id="pool-mgr-capped">
          <option value="all">Capped & Uncapped</option>
          <option value="Capped" ${pm.capped === 'Capped' ? 'selected' : ''}>Capped</option>
          <option value="Uncapped" ${pm.capped === 'Uncapped' ? 'selected' : ''}>Uncapped</option>
        </select>
        <select class="select" id="pool-mgr-price">
          <option value="all">All Base Prices</option>
          ${priceOptions}
        </select>
        <select class="select" id="pool-mgr-eligibility">
          <option value="all">All Pool Statuses</option>
          <option value="active" ${pm.poolEligibility === 'active' ? 'selected' : ''}>Active in Pool</option>
          <option value="excluded" ${pm.poolEligibility === 'excluded' ? 'selected' : ''}>Excluded from Pool</option>
          <option value="mini" ${pm.poolEligibility === 'mini' ? 'selected' : ''}>Mini Auction Eligible</option>
          <option value="mega" ${pm.poolEligibility === 'mega' ? 'selected' : ''}>Mega Auction Eligible</option>
        </select>
        <select class="select" id="pool-mgr-sort">
          <option value="default" ${pm.sort === 'default' ? 'selected' : ''}>Set Order (Default)</option>
          <option value="name-asc" ${pm.sort === 'name-asc' ? 'selected' : ''}>Name (A-Z)</option>
          <option value="name-desc" ${pm.sort === 'name-desc' ? 'selected' : ''}>Name (Z-A)</option>
          <option value="price-desc" ${pm.sort === 'price-desc' ? 'selected' : ''}>Base Price (High-Low)</option>
          <option value="price-asc" ${pm.sort === 'price-asc' ? 'selected' : ''}>Base Price (Low-High)</option>
        </select>
        <button type="button" class="btn btn-ghost btn-sm" data-action="pool-reset-filters">Reset</button>
      </div>

      <div class="pool-table-container">
        <table class="pool-table">
          <thead>
            <tr>
              <th># / Set</th>
              <th>Player Candidate</th>
              <th>Role</th>
              <th>Origin</th>
              <th>Status</th>
              <th>Base Price</th>
              <th>Auction Pool</th>
              <th>State</th>
              <th style="text-align:right">Actions</th>
            </tr>
          </thead>
          <tbody>
            ${pageItems.map((p, idx) => {
              const rowNum = startIdx + idx + 1;
              const isExcluded = p.excluded === true;
              return `<tr class="${isExcluded ? 'is-excluded' : ''}">
                <td><strong style="color:#8da0b1">${escapeHtml(p.auctionSet || '—')}</strong><br/><small style="color:#64748b">#${rowNum}</small></td>
                <td>
                  <div class="pool-player-cell">
                    <div class="pool-thumb">
                      ${p.image ? `<img src="${escapeHtml(p.image)}" alt="${escapeHtml(p.name)}" onerror="this.style.display='none';this.nextElementSibling.style.display='block'"/><span class="pool-thumb-placeholder" style="display:none">${escapeHtml(initials(p.name))}</span>` : `<span class="pool-thumb-placeholder">${escapeHtml(initials(p.name))}</span>`}
                    </div>
                    <div>
                      <strong>${escapeHtml(p.name)}</strong>
                      <div style="font-size:11px;color:#8da0b1">${escapeHtml(p.nationality || (p.origin === 'Domestic' ? 'India' : 'Overseas'))}</div>
                    </div>
                  </div>
                </td>
                <td><span class="tag lime">${escapeHtml(p.role || p.roleBucket || 'Player')}</span></td>
                <td><span class="tag ${p.origin === 'Overseas' ? 'orange' : ''}">${escapeHtml(p.origin || 'Domestic')}</span></td>
                <td><span class="tag">${escapeHtml(p.cappedStatus || 'Capped')}</span></td>
                <td><strong style="font-family:'Barlow Condensed',sans-serif;font-size:16px">${fmtCr(p.basePriceCr)}</strong></td>
                <td>
                  <div class="pool-eligibility-pills">
                    <span class="eligibility-pill ${p.includeInMini !== false ? 'active' : 'inactive'}">MINI: ${p.includeInMini !== false ? '✓' : '✗'}</span>
                    <span class="eligibility-pill ${p.includeInMega !== false ? 'active' : 'inactive'}">MEGA: ${p.includeInMega !== false ? '✓' : '✗'}</span>
                  </div>
                </td>
                <td>
                  <span class="row-status ${isExcluded ? 'unsold' : 'sold'}">${isExcluded ? 'EXCLUDED' : 'ACTIVE'}</span>
                </td>
                <td>
                  <div class="pool-actions-cell" style="justify-content:flex-end">
                    <button type="button" class="btn btn-ghost btn-sm" data-action="open-edit-player" data-id="${escapeHtml(p.id)}">✏ Edit</button>
                    <button type="button" class="btn btn-secondary btn-sm" data-action="toggle-player-exclusion" data-id="${escapeHtml(p.id)}">
                      ${isExcluded ? 'Restore ↺' : 'Exclude ⊘'}
                    </button>
                    <button type="button" class="btn btn-danger btn-sm" data-action="open-delete-player" data-id="${escapeHtml(p.id)}">🗑</button>
                  </div>
                </td>
              </tr>`;
            }).join('') || `<tr><td colspan="9" style="text-align:center;padding:32px"><div class="empty-state"><div class="empty-icon">👥</div><h3>No candidate records match</h3><p>Try clearing your search query or relaxing your filters.</p></div></td></tr>`}
          </tbody>
        </table>
      </div>

      <div class="pool-pagination">
        <div style="font-size:12px;color:#8da0b1">
          Showing <strong>${filtered.length > 0 ? startIdx + 1 : 0}–${Math.min(startIdx + pageSize, filtered.length)}</strong> of <strong>${filtered.length}</strong> candidates (Total registered: ${total})
        </div>
        <div class="pool-page-buttons">
          <button type="button" class="btn btn-secondary btn-sm" data-action="pool-prev-page" ${currentPage <= 1 ? 'disabled' : ''}>← Previous</button>
          <span style="display:inline-flex;align-items:center;padding:0 8px;font-size:12px;font-weight:700">Page ${currentPage} of ${totalPages}</span>
          <button type="button" class="btn btn-secondary btn-sm" data-action="pool-next-page" ${currentPage >= totalPages ? 'disabled' : ''}>Next →</button>
        </div>
      </div>
    </div>
    ${pm.addingPlayer ? renderAddPlayerModal() : ''}
    ${pm.editingPlayer ? renderEditPlayerModal(pm.editingPlayer) : ''}
    ${pm.deletePlayerId ? renderDeletePlayerModal(pm.deletePlayerId) : ''}
  </div>`;
}

function renderFranchiseAudioList(isModal = false) {
  const audioMap = state.room?.teamAudio || state.bootstrap?.audio || {};
  const metaMap = state.room?.teamAudioMetadata || state.bootstrap?.teamAudioMetadata || {};
  const teams = state.bootstrap?.teams || [];

  const cards = teams.map(t => {
    const meta = metaMap[t.id] || {};
    const url = audioMap[t.id] || meta.url || `/audio/${t.id.toLowerCase()}-hook.mp3`;
    const fileName = meta.fileName || (url ? url.split('/').pop() : `${t.id.toLowerCase()}-hook.mp3`);
    const isDefault = Boolean(meta.isDefault !== false && !url.includes('/custom/'));
    const duration = meta.durationSec ? `${Number(meta.durationSec).toFixed(1)}s` : 'Available';
    const isPlaying = state.previewTeamId === t.id;

    return `<div class="audio-card" style="--team-primary:${t.primary};border-top:3px solid ${t.primary}" data-audio-card="${escapeHtml(t.id)}">
      <div class="audio-card-header">
        <div class="audio-card-identity">
          ${teamBadge(t.id)}
          <div class="audio-team-info">
            <strong>${escapeHtml(t.name)}</strong>
            <small style="color:${t.primary}">${escapeHtml(t.short || t.id)}</small>
          </div>
        </div>
        <div class="audio-status-pill ${isDefault ? 'is-default' : 'is-custom'}">
          ${isDefault ? '★ Default Anthem' : '⚡ Custom Anthem'}
        </div>
      </div>

      <div class="audio-card-meta">
        <div class="audio-meta-item">
          <small>Active Track</small>
          <span class="audio-filename" title="${escapeHtml(fileName)}">${escapeHtml(fileName)}</span>
        </div>
        <div class="audio-meta-item">
          <small>Duration</small>
          <span class="audio-duration">⏱ ${escapeHtml(duration)}</span>
        </div>
        <div class="audio-meta-item">
          <small>Source</small>
          <span>${isDefault ? 'Built-in Default' : 'Custom Upload'}</span>
        </div>
      </div>

      <div class="audio-file-picker">
        <label class="audio-file-label" for="audio-file-${t.id}">
          <span class="file-pick-icon">📁</span>
          <span class="file-pick-text" id="selected-file-name-${t.id}">Choose new audio file…</span>
          <input type="file" id="audio-file-${t.id}" class="audio-native-input" accept="audio/*,.mp3,.wav,.m4a,.aac,.ogg,.flac,.webm" data-team="${t.id}" />
        </label>
      </div>

      <div class="audio-card-actions">
        <button type="button" class="btn btn-secondary btn-sm audio-preview-btn ${isPlaying ? 'playing' : ''}" data-action="preview-audio" data-team="${t.id}" data-url="${escapeHtml(url)}">
          ${isPlaying ? '■ Stop' : '▶ Preview'}
        </button>
        <button type="button" class="btn btn-primary btn-sm audio-upload-btn" data-action="upload-audio" data-team="${t.id}">
          Upload & Save
        </button>
        ${!isDefault ? `<button type="button" class="btn btn-ghost btn-sm audio-restore-btn" data-action="restore-default-audio" data-team="${t.id}" title="Restore original default hook">Restore Default</button>` : ''}
      </div>
      <div class="audio-upload-status" id="audio-status-${t.id}"></div>
    </div>`;
  }).join('');

  return `<div class="audio-manager-container">
    <div class="audio-manager-banner">
      <div class="audio-banner-info">
        <strong>Preserved Defaults & Instant Celebration System</strong>
        <p>All 10 franchise defaults are permanently preserved. Custom uploads support MP3, WAV, M4A, AAC, OGG, FLAC and WebM (up to 8 MB) with automatic duration verification.</p>
      </div>
    </div>
    <div class="audio-manager-grid">
      ${cards}
    </div>
  </div>`;
}

function renderHostAudioTab() {
  return `<div class="form-card audio-form-card" style="max-width:1160px;margin:0 auto">
    ${renderHostSubnav()}
    <div class="kicker">Victory Anthem Management</div>
    <h2>Franchise Audio Manager</h2>
    <p class="sub" style="margin-bottom:18px">Manage celebration anthems played automatically when a player is sold to each franchise. Defaults remain permanent until intentionally replaced.</p>
    ${renderFranchiseAudioList(false)}
  </div>`;
}

function renderAddPlayerModal() {
  return `<div class="pool-modal-overlay" id="pool-modal-overlay">
    <div class="pool-modal-card">
      <div class="pool-modal-head">
        <div>
          <div class="kicker">New Candidate Entry</div>
          <h3>Add Player to Pool</h3>
        </div>
        <button type="button" class="close-x" data-action="close-pool-modal">×</button>
      </div>
      <form id="add-player-form">
        <div class="field" style="margin-bottom:12px">
          <label>Full Player Name *</label>
          <input class="input" name="name" required placeholder="e.g. Jasprit Bumrah" autofocus/>
        </div>
        <div class="field-row" style="margin-bottom:12px">
          <div class="field">
            <label>Nationality *</label>
            <input class="input" name="nationality" id="player-modal-nationality" list="nationality-datalist" placeholder="e.g. India, Australia" value="India" required />
            <datalist id="nationality-datalist">
              <option value="India">India</option>
              <option value="Australia">Australia</option>
              <option value="England">England</option>
              <option value="South Africa">South Africa</option>
              <option value="New Zealand">New Zealand</option>
              <option value="West Indies">West Indies</option>
              <option value="Sri Lanka">Sri Lanka</option>
              <option value="Afghanistan">Afghanistan</option>
              <option value="Bangladesh">Bangladesh</option>
              <option value="Zimbabwe">Zimbabwe</option>
              <option value="Ireland">Ireland</option>
              <option value="Netherlands">Netherlands</option>
              <option value="USA">USA</option>
            </datalist>
          </div>
          <div class="field">
            <label>Origin Classification *</label>
            <select class="select" name="origin" id="player-modal-origin">
              <option value="Domestic" selected>Domestic (India)</option>
              <option value="Overseas">Overseas</option>
            </select>
          </div>
        </div>
        <div class="field-row" style="margin-bottom:12px">
          <div class="field">
            <label>Playing Role *</label>
            <select class="select" name="roleBucket">
              <option value="Batter">Batter</option>
              <option value="Bowler" selected>Bowler</option>
              <option value="All-rounder">All-Rounder</option>
              <option value="Keeper">Wicketkeeper-Batter</option>
            </select>
          </div>
          <div class="field">
            <label>Role Subtype / Specialization</label>
            <input class="input" name="roleSubtype" list="role-subtypes-datalist" placeholder="e.g. Fast Bowler, Spinner, Batting All-rounder" value="Fast Bowler"/>
            <datalist id="role-subtypes-datalist">
              <option value="Fast Bowler">Fast Bowler</option>
              <option value="Right-arm Fast">Right-arm Fast</option>
              <option value="Left-arm Fast">Left-arm Fast</option>
              <option value="Off-spinner">Off-spinner</option>
              <option value="Leg-spinner">Leg-spinner</option>
              <option value="Left-arm Orthodox">Left-arm Orthodox</option>
              <option value="Top-order Batter">Top-order Batter</option>
              <option value="Middle-order Batter">Middle-order Batter</option>
              <option value="Finisher">Finisher</option>
              <option value="Batting All-rounder">Batting All-rounder</option>
              <option value="Bowling All-rounder">Bowling All-rounder</option>
              <option value="Wicketkeeper-Batter">Wicketkeeper-Batter</option>
            </datalist>
          </div>
        </div>
        <div class="field-row" style="margin-bottom:12px">
          <div class="field">
            <label>Capped Status *</label>
            <select class="select" name="cappedStatus" id="player-modal-capped">
              <option value="Capped" selected>Capped</option>
              <option value="Uncapped">Uncapped (₹20L default)</option>
            </select>
          </div>
          <div class="field">
            <label>Auction Set / Category</label>
            <input class="input" name="auctionSet" placeholder="e.g. BO1, BA1, AL1, WK1" value="BO1"/>
          </div>
        </div>
        <div class="field" style="margin-bottom:12px">
          <label>Base Price (₹ Cr) * <small style="color:var(--muted)">(Uncapped default: ₹0.20 Cr · Overseas default: ₹1.00 Cr)</small></label>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <input class="input" name="basePriceCr" id="modal-base-price" type="number" min="0.1" max="20" step="0.05" value="2.00" required style="max-width:140px"/>
            <div class="quick-price-chips" style="display:flex;gap:4px;flex-wrap:wrap">
              <button type="button" class="btn btn-ghost btn-sm price-chip" data-price="0.20">₹20 L</button>
              <button type="button" class="btn btn-ghost btn-sm price-chip" data-price="0.30">₹30 L</button>
              <button type="button" class="btn btn-ghost btn-sm price-chip" data-price="0.50">₹50 L</button>
              <button type="button" class="btn btn-ghost btn-sm price-chip" data-price="0.75">₹75 L</button>
              <button type="button" class="btn btn-ghost btn-sm price-chip" data-price="1.00">₹1 Cr</button>
              <button type="button" class="btn btn-ghost btn-sm price-chip" data-price="1.50">₹1.5 Cr</button>
              <button type="button" class="btn btn-ghost btn-sm price-chip" data-price="2.00">₹2 Cr</button>
            </div>
          </div>
        </div>
        <div class="field" style="margin-bottom:12px">
          <label>Player Photo</label>
          <div class="pool-image-preview-box">
            <div class="preview-avatar">
              <img id="pool-player-preview-img" src="" style="display:none" alt="Preview"/>
              <span id="pool-player-preview-ph">👤</span>
            </div>
            <div style="flex:1">
              <input class="input" id="pool-player-image-url" name="image" placeholder="Image URL (https://...) or upload file below"/>
              <div style="margin-top:6px;display:flex;align-items:center;gap:8px">
                <input type="file" id="pool-player-file-input" accept="image/*" style="font-size:11px;color:#8da0b1"/>
                <small style="color:#64748b">PNG, JPG, WebP (max 5MB)</small>
              </div>
            </div>
          </div>
        </div>
        <div class="field-row" style="margin-bottom:12px">
          <div class="field">
            <label>Profile / Source Reference (Optional)</label>
            <input class="input" name="candidateSource" placeholder="e.g. Cricinfo profile or domestic registry sheet"/>
          </div>
          <div class="field">
            <label>Administrative Notes (Optional)</label>
            <input class="input" name="notes" placeholder="e.g. Scored 420 runs in SMAT 2026"/>
          </div>
        </div>
        <div style="display:flex;gap:16px;flex-wrap:wrap;margin:16px 0;padding:12px;background:rgba(255,255,255,0.02);border:1px solid var(--line);border-radius:8px">
          <label class="check-row" style="margin:0">
            <input type="checkbox" name="includeInMini" checked/>
            <span>Include in Mini Auction</span>
          </label>
          <label class="check-row" style="margin:0">
            <input type="checkbox" name="includeInMega" checked/>
            <span>Include in Mega Auction</span>
          </label>
          <label class="check-row" style="margin:0">
            <input type="checkbox" name="excluded"/>
            <span>Exclude initially from pool</span>
          </label>
        </div>
        <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:16px">
          <button type="button" class="btn btn-secondary" data-action="close-pool-modal">Cancel</button>
          <button type="submit" class="btn btn-primary">Save Candidate</button>
        </div>
      </form>
    </div>
  </div>`;
}

function renderEditPlayerModal(player) {
  return `<div class="pool-modal-overlay" id="pool-modal-overlay">
    <div class="pool-modal-card">
      <div class="pool-modal-head">
        <div>
          <div class="kicker">Update Candidate Record</div>
          <h3>Edit Player: ${escapeHtml(player.name)}</h3>
        </div>
        <button type="button" class="close-x" data-action="close-pool-modal">×</button>
      </div>
      <form id="edit-player-form" data-id="${escapeHtml(player.id)}">
        <div class="field" style="margin-bottom:12px">
          <label>Full Player Name *</label>
          <input class="input" name="name" required value="${escapeHtml(player.name)}"/>
        </div>
        <div class="field-row" style="margin-bottom:12px">
          <div class="field">
            <label>Nationality *</label>
            <input class="input" name="nationality" id="player-modal-nationality" list="nationality-datalist" value="${escapeHtml(player.nationality || (player.origin === 'Overseas' ? 'Overseas' : 'India'))}" required />
            <datalist id="nationality-datalist">
              <option value="India">India</option>
              <option value="Australia">Australia</option>
              <option value="England">England</option>
              <option value="South Africa">South Africa</option>
              <option value="New Zealand">New Zealand</option>
              <option value="West Indies">West Indies</option>
              <option value="Sri Lanka">Sri Lanka</option>
              <option value="Afghanistan">Afghanistan</option>
              <option value="Bangladesh">Bangladesh</option>
              <option value="Zimbabwe">Zimbabwe</option>
              <option value="Ireland">Ireland</option>
              <option value="Netherlands">Netherlands</option>
              <option value="USA">USA</option>
            </datalist>
          </div>
          <div class="field">
            <label>Origin Classification *</label>
            <select class="select" name="origin" id="player-modal-origin">
              <option value="Domestic" ${player.origin !== 'Overseas' ? 'selected' : ''}>Domestic (India)</option>
              <option value="Overseas" ${player.origin === 'Overseas' ? 'selected' : ''}>Overseas</option>
            </select>
          </div>
        </div>
        <div class="field-row" style="margin-bottom:12px">
          <div class="field">
            <label>Playing Role *</label>
            <select class="select" name="roleBucket">
              <option value="Batter" ${player.roleBucket === 'Batter' ? 'selected' : ''}>Batter</option>
              <option value="Bowler" ${player.roleBucket === 'Bowler' ? 'selected' : ''}>Bowler</option>
              <option value="All-rounder" ${player.roleBucket === 'All-rounder' ? 'selected' : ''}>All-Rounder</option>
              <option value="Keeper" ${player.roleBucket === 'Keeper' ? 'selected' : ''}>Wicketkeeper-Batter</option>
            </select>
          </div>
          <div class="field">
            <label>Role Subtype / Specialization</label>
            <input class="input" name="roleSubtype" list="role-subtypes-datalist" value="${escapeHtml(player.roleSubtype || player.role || '')}"/>
            <datalist id="role-subtypes-datalist">
              <option value="Fast Bowler">Fast Bowler</option>
              <option value="Right-arm Fast">Right-arm Fast</option>
              <option value="Left-arm Fast">Left-arm Fast</option>
              <option value="Off-spinner">Off-spinner</option>
              <option value="Leg-spinner">Leg-spinner</option>
              <option value="Left-arm Orthodox">Left-arm Orthodox</option>
              <option value="Top-order Batter">Top-order Batter</option>
              <option value="Middle-order Batter">Middle-order Batter</option>
              <option value="Finisher">Finisher</option>
              <option value="Batting All-rounder">Batting All-rounder</option>
              <option value="Bowling All-rounder">Bowling All-rounder</option>
              <option value="Wicketkeeper-Batter">Wicketkeeper-Batter</option>
            </datalist>
          </div>
        </div>
        <div class="field-row" style="margin-bottom:12px">
          <div class="field">
            <label>Capped Status *</label>
            <select class="select" name="cappedStatus" id="player-modal-capped">
              <option value="Capped" ${player.cappedStatus === 'Capped' ? 'selected' : ''}>Capped</option>
              <option value="Uncapped" ${player.cappedStatus === 'Uncapped' ? 'selected' : ''}>Uncapped (₹20L default)</option>
            </select>
          </div>
          <div class="field">
            <label>Auction Set / Category</label>
            <input class="input" name="auctionSet" value="${escapeHtml(player.auctionSet || '')}"/>
          </div>
        </div>
        <div class="field" style="margin-bottom:12px">
          <label>Base Price (₹ Cr) * <small style="color:var(--muted)">(Uncapped default: ₹0.20 Cr · Overseas default: ₹1.00 Cr)</small></label>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <input class="input" name="basePriceCr" id="modal-base-price" type="number" min="0.1" max="20" step="0.05" value="${Number(player.basePriceCr).toFixed(2)}" required style="max-width:140px"/>
            <div class="quick-price-chips" style="display:flex;gap:4px;flex-wrap:wrap">
              <button type="button" class="btn btn-ghost btn-sm price-chip" data-price="0.20">₹20 L</button>
              <button type="button" class="btn btn-ghost btn-sm price-chip" data-price="0.30">₹30 L</button>
              <button type="button" class="btn btn-ghost btn-sm price-chip" data-price="0.50">₹50 L</button>
              <button type="button" class="btn btn-ghost btn-sm price-chip" data-price="0.75">₹75 L</button>
              <button type="button" class="btn btn-ghost btn-sm price-chip" data-price="1.00">₹1 Cr</button>
              <button type="button" class="btn btn-ghost btn-sm price-chip" data-price="1.50">₹1.5 Cr</button>
              <button type="button" class="btn btn-ghost btn-sm price-chip" data-price="2.00">₹2 Cr</button>
            </div>
          </div>
        </div>
        <div class="field" style="margin-bottom:12px">
          <label>Player Photo</label>
          <div class="pool-image-preview-box">
            <div class="preview-avatar">
              <img id="pool-player-preview-img" src="${escapeHtml(player.image || '')}" style="${player.image ? 'display:block' : 'display:none'}" alt="Preview"/>
              <span id="pool-player-preview-ph" style="${player.image ? 'display:none' : 'display:block'}">${escapeHtml(initials(player.name))}</span>
            </div>
            <div style="flex:1">
              <input class="input" id="pool-player-image-url" name="image" value="${escapeHtml(player.image || '')}" placeholder="Image URL (https://...) or upload file below"/>
              <div style="margin-top:6px;display:flex;align-items:center;gap:8px">
                <input type="file" id="pool-player-file-input" accept="image/*" style="font-size:11px;color:#8da0b1"/>
                <small style="color:#64748b">PNG, JPG, WebP (max 5MB)</small>
              </div>
            </div>
          </div>
        </div>
        <div class="field-row" style="margin-bottom:12px">
          <div class="field">
            <label>Profile / Source Reference (Optional)</label>
            <input class="input" name="candidateSource" value="${escapeHtml(player.candidateSource || '')}" placeholder="e.g. Cricinfo profile or registration reference"/>
          </div>
          <div class="field">
            <label>Administrative Notes (Optional)</label>
            <input class="input" name="notes" value="${escapeHtml(player.notes || '')}" placeholder="e.g. Scored 420 runs in SMAT 2026"/>
          </div>
        </div>
        <div style="display:flex;gap:16px;flex-wrap:wrap;margin:16px 0;padding:12px;background:rgba(255,255,255,0.02);border:1px solid var(--line);border-radius:8px">
          <label class="check-row" style="margin:0">
            <input type="checkbox" name="includeInMini" ${player.includeInMini !== false ? 'checked' : ''}/>
            <span>Include in Mini Auction</span>
          </label>
          <label class="check-row" style="margin:0">
            <input type="checkbox" name="includeInMega" ${player.includeInMega !== false ? 'checked' : ''}/>
            <span>Include in Mega Auction</span>
          </label>
          <label class="check-row" style="margin:0">
            <input type="checkbox" name="excluded" ${player.excluded ? 'checked' : ''}/>
            <span>Exclude from auction pool</span>
          </label>
        </div>
        <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:16px">
          <button type="button" class="btn btn-secondary" data-action="close-pool-modal">Cancel</button>
          <button type="submit" class="btn btn-primary">Save Changes</button>
        </div>
      </form>
    </div>
  </div>`;
}

function renderDeletePlayerModal(playerId) {
  const player = (state.bootstrap?.candidates || []).find(p => p.id === playerId);
  if (!player) return '';
  return `<div class="pool-modal-overlay" id="pool-modal-overlay">
    <div class="pool-modal-card" style="max-width:480px">
      <div class="pool-modal-head">
        <div>
          <div class="kicker" style="color:#ef4444">Permanent Action</div>
          <h3>Delete Candidate Record</h3>
        </div>
        <button type="button" class="close-x" data-action="close-pool-modal">×</button>
      </div>
      <p style="font-size:14px;color:#cbd5e1;line-height:1.5">
        Are you sure you want to permanently delete <strong>${escapeHtml(player.name)}</strong> (${escapeHtml(player.role || '')}, ${fmtCr(player.basePriceCr)}) from the candidate database?
      </p>
      <div class="notice" style="margin:16px 0;background:rgba(239,68,68,0.1);border-color:rgba(239,68,68,0.3);color:#fca5a5">
        ⚠️ This operation modifies the authoritative player registry. If you only want to temporarily exclude this candidate from the upcoming auction, use the <strong>Exclude</strong> button instead.
      </div>
      <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:18px">
        <button type="button" class="btn btn-secondary" data-action="close-pool-modal">Cancel</button>
        <button type="button" class="btn btn-danger" data-action="confirm-delete-player" data-id="${escapeHtml(player.id)}">Delete Candidate</button>
      </div>
    </div>
  </div>`;
}

function bindHomeHandlers() {
  // Host Subnav
  app.querySelectorAll('[data-action="switch-host-tab"]').forEach(btn => btn.addEventListener('click', () => {
    saveHostSetupDraft();
    state.hostTab = btn.dataset.tab;
    renderHome();
  }));

  // Preserve host setup form edits in real-time
  const draftSetupForm = document.getElementById('host-setup-form');
  if (draftSetupForm) {
    draftSetupForm.addEventListener('change', () => saveHostSetupDraft());
    draftSetupForm.addEventListener('input', () => saveHostSetupDraft());
  }

  // Pool Manager Filters & Search
  const mgrSearch = document.getElementById('pool-mgr-search');
  if (mgrSearch) {
    mgrSearch.addEventListener('input', e => {
      state.poolManager.search = e.target.value;
      state.poolManager.page = 1;
      renderHome();
      const el = document.getElementById('pool-mgr-search');
      if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
    });
  }
  const mgrRole = document.getElementById('pool-mgr-role');
  if (mgrRole) mgrRole.addEventListener('change', e => { state.poolManager.role = e.target.value; state.poolManager.page = 1; renderHome(); });
  const mgrOrigin = document.getElementById('pool-mgr-origin');
  if (mgrOrigin) mgrOrigin.addEventListener('change', e => { state.poolManager.origin = e.target.value; state.poolManager.page = 1; renderHome(); });
  const mgrCapped = document.getElementById('pool-mgr-capped');
  if (mgrCapped) mgrCapped.addEventListener('change', e => { state.poolManager.capped = e.target.value; state.poolManager.page = 1; renderHome(); });
  const mgrPrice = document.getElementById('pool-mgr-price');
  if (mgrPrice) mgrPrice.addEventListener('change', e => { state.poolManager.basePrice = e.target.value; state.poolManager.page = 1; renderHome(); });
  const mgrElig = document.getElementById('pool-mgr-eligibility');
  if (mgrElig) mgrElig.addEventListener('change', e => { state.poolManager.poolEligibility = e.target.value; state.poolManager.page = 1; renderHome(); });
  const mgrSort = document.getElementById('pool-mgr-sort');
  if (mgrSort) mgrSort.addEventListener('change', e => { state.poolManager.sort = e.target.value; renderHome(); });

  app.querySelectorAll('[data-action="pool-reset-filters"]').forEach(btn => btn.addEventListener('click', () => {
    state.poolManager.search = '';
    state.poolManager.role = 'all';
    state.poolManager.origin = 'all';
    state.poolManager.capped = 'all';
    state.poolManager.basePrice = 'all';
    state.poolManager.poolEligibility = 'all';
    state.poolManager.sort = 'default';
    state.poolManager.page = 1;
    renderHome();
  }));

  // Pagination
  app.querySelectorAll('[data-action="pool-prev-page"]').forEach(btn => btn.addEventListener('click', () => {
    state.poolManager.page = Math.max(1, (state.poolManager.page || 1) - 1);
    renderHome();
  }));
  app.querySelectorAll('[data-action="pool-next-page"]').forEach(btn => btn.addEventListener('click', () => {
    state.poolManager.page = (state.poolManager.page || 1) + 1;
    renderHome();
  }));

  // Pool Modals and Actions
  app.querySelectorAll('[data-action="open-add-player"]').forEach(btn => btn.addEventListener('click', () => {
    state.poolManager.addingPlayer = true;
    renderHome();
  }));
  app.querySelectorAll('[data-action="close-pool-modal"]').forEach(btn => btn.addEventListener('click', () => {
    state.poolManager.addingPlayer = false;
    state.poolManager.editingPlayer = null;
    state.poolManager.deletePlayerId = null;
    renderHome();
  }));
  app.querySelectorAll('[data-action="open-edit-player"]').forEach(btn => btn.addEventListener('click', () => {
    const p = (state.bootstrap?.candidates || []).find(c => c.id === btn.dataset.id);
    if (p) {
      state.poolManager.editingPlayer = { ...p };
      renderHome();
    }
  }));
  app.querySelectorAll('[data-action="toggle-player-exclusion"]').forEach(btn => btn.addEventListener('click', async () => {
    const id = btn.dataset.id;
    try {
      const res = await api(`/api/admin/players/${encodeURIComponent(id)}/toggle-exclusion`, { method: 'POST' });
      if (res?.player) {
        const idx = (state.bootstrap?.candidates || []).findIndex(c => c.id === id);
        if (idx !== -1) state.bootstrap.candidates[idx] = res.player;
        if (state.room?.candidatePool) {
          const rIdx = state.room.candidatePool.findIndex(c => c.id === id);
          if (rIdx !== -1) state.room.candidatePool[rIdx] = res.player;
        }
        toast(`${res.player.name} is now ${res.player.excluded ? 'EXCLUDED from' : 'RESTORED to'} pool.`, 'success');
        renderHome();
      }
    } catch (err) {
      toast(err.message || 'Failed to toggle exclusion', 'error');
    }
  }));
  app.querySelectorAll('[data-action="open-delete-player"]').forEach(btn => btn.addEventListener('click', () => {
    state.poolManager.deletePlayerId = btn.dataset.id;
    renderHome();
  }));
  app.querySelectorAll('[data-action="confirm-delete-player"]').forEach(btn => btn.addEventListener('click', async () => {
    const id = btn.dataset.id;
    try {
      const res = await api(`/api/admin/players/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (res?.ok) {
        if (state.bootstrap?.candidates) {
          state.bootstrap.candidates = state.bootstrap.candidates.filter(c => c.id !== id);
        }
        if (state.room?.candidatePool) {
          state.room.candidatePool = state.room.candidatePool.filter(c => c.id !== id);
        }
        state.poolManager.deletePlayerId = null;
        toast('Candidate removed from pool registry.', 'success');
        renderHome();
      }
    } catch (err) {
      toast(err.message || 'Failed to delete candidate', 'error');
    }
  }));
  app.querySelectorAll('[data-action="export-pool-backup"]').forEach(btn => btn.addEventListener('click', () => {
    window.location.href = `/api/admin/players/export?token=${encodeURIComponent(state.ownerToken || '')}`;
  }));

  // Quick price chips
  app.querySelectorAll('.price-chip').forEach(btn => btn.addEventListener('click', () => {
    const p = btn.dataset.price;
    const inp = document.getElementById('modal-base-price');
    if (inp && p) inp.value = Number(p).toFixed(2);
  }));

  // Dynamic pricing & origin listeners
  const modalCapped = document.getElementById('player-modal-capped');
  if (modalCapped) {
    modalCapped.addEventListener('change', e => {
      const inp = document.getElementById('modal-base-price');
      if (e.target.value === 'Uncapped' && inp) {
        inp.value = '0.20';
      } else if (e.target.value === 'Capped' && inp && Number(inp.value) < 1.0) {
        inp.value = '1.00';
      }
    });
  }

  const modalOrigin = document.getElementById('player-modal-origin');
  if (modalOrigin) {
    modalOrigin.addEventListener('change', e => {
      const inp = document.getElementById('modal-base-price');
      if (e.target.value === 'Overseas' && inp && Number(inp.value) < 1.0) {
        inp.value = '1.00';
      }
    });
  }

  const modalNat = document.getElementById('player-modal-nationality');
  if (modalNat) {
    modalNat.addEventListener('input', e => {
      const val = (e.target.value || '').trim().toLowerCase();
      const originSel = document.getElementById('player-modal-origin');
      if (originSel) {
        originSel.value = (val === 'india' || val === 'indian') ? 'Domestic' : 'Overseas';
      }
    });
  }

  // Live URL image preview
  const urlInp = document.getElementById('pool-player-image-url');
  if (urlInp) {
    urlInp.addEventListener('input', e => {
      const val = (e.target.value || '').trim();
      const prevImg = document.getElementById('pool-player-preview-img');
      const prevPh = document.getElementById('pool-player-preview-ph');
      if (val && prevImg) {
        prevImg.src = val;
        prevImg.style.display = 'block';
        if (prevPh) prevPh.style.display = 'none';
      } else if (!val && prevImg) {
        prevImg.style.display = 'none';
        if (prevPh) prevPh.style.display = 'block';
      }
    });
  }

  // File Upload listener for pool player images
  const fileInp = document.getElementById('pool-player-file-input');
  if (fileInp) {
    fileInp.addEventListener('change', async e => {
      const file = e.target.files[0];
      if (!file) return;
      if (file.size > 5 * 1024 * 1024) { toast('Image file must be under 5MB.', 'error'); return; }
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const res = await api('/api/admin/players/upload-image', {
            method: 'POST',
            body: { filename: file.name, base64: reader.result }
          });
          if (res?.imageUrl) {
            const urlInput = document.getElementById('pool-player-image-url');
            if (urlInput) urlInput.value = res.imageUrl;
            const prevImg = document.getElementById('pool-player-preview-img');
            const prevPh = document.getElementById('pool-player-preview-ph');
            if (prevImg) { prevImg.src = res.imageUrl; prevImg.style.display = 'block'; }
            if (prevPh) prevPh.style.display = 'none';
            toast('Image uploaded successfully!', 'success');
          }
        } catch (err) {
          toast(err.message || 'Image upload failed', 'error');
        }
      };
      reader.readAsDataURL(file);
    });
  }

  // Add Player Form Submit
  const addPlayerForm = document.getElementById('add-player-form');
  if (addPlayerForm) {
    addPlayerForm.addEventListener('submit', async e => {
      e.preventDefault();
      const fd = new FormData(addPlayerForm);
      const role = fd.get('roleSubtype')?.trim() || fd.get('role')?.trim() || fd.get('roleBucket');
      const nat = fd.get('nationality')?.trim() || 'India';
      const orig = fd.get('origin') || (nat.toLowerCase() === 'india' ? 'Domestic' : 'Overseas');
      const payload = {
        name: fd.get('name')?.trim(),
        nationality: nat,
        origin: orig,
        cappedStatus: fd.get('cappedStatus') || 'Capped',
        roleBucket: fd.get('roleBucket') || 'Batter',
        role,
        roleSubtype: fd.get('roleSubtype')?.trim() || role,
        basePriceCr: Number(fd.get('basePriceCr')),
        auctionSet: fd.get('auctionSet')?.trim().toUpperCase() || 'GENERAL',
        image: fd.get('image')?.trim() || null,
        candidateSource: fd.get('candidateSource')?.trim() || '',
        notes: fd.get('notes')?.trim() || '',
        includeInMini: fd.get('includeInMini') === 'on',
        includeInMega: fd.get('includeInMega') === 'on',
        excluded: fd.get('excluded') === 'on'
      };
      try {
        const res = await api('/api/admin/players', { method: 'POST', body: payload });
        if (res?.player) {
          if (!state.bootstrap.candidates) state.bootstrap.candidates = [];
          state.bootstrap.candidates.push(res.player);
          if (state.room?.candidatePool) state.room.candidatePool.push(res.player);
          state.poolManager.addingPlayer = false;
          toast(`${res.player.name} added to candidate pool!`, 'success');
          renderHome();
        }
      } catch (err) {
        toast(err.message || 'Failed to add candidate', 'error');
      }
    });
  }

  // Edit Player Form Submit
  const editPlayerForm = document.getElementById('edit-player-form');
  if (editPlayerForm) {
    editPlayerForm.addEventListener('submit', async e => {
      e.preventDefault();
      const id = editPlayerForm.dataset.id;
      const fd = new FormData(editPlayerForm);
      const role = fd.get('roleSubtype')?.trim() || fd.get('role')?.trim() || fd.get('roleBucket');
      const nat = fd.get('nationality')?.trim() || 'India';
      const orig = fd.get('origin') || (nat.toLowerCase() === 'india' ? 'Domestic' : 'Overseas');
      const payload = {
        name: fd.get('name')?.trim(),
        nationality: nat,
        origin: orig,
        cappedStatus: fd.get('cappedStatus') || 'Capped',
        roleBucket: fd.get('roleBucket') || 'Batter',
        role,
        roleSubtype: fd.get('roleSubtype')?.trim() || role,
        basePriceCr: Number(fd.get('basePriceCr')),
        auctionSet: fd.get('auctionSet')?.trim().toUpperCase(),
        image: fd.get('image')?.trim() || null,
        candidateSource: fd.get('candidateSource')?.trim() || '',
        notes: fd.get('notes')?.trim() || '',
        includeInMini: fd.get('includeInMini') === 'on',
        includeInMega: fd.get('includeInMega') === 'on',
        excluded: fd.get('excluded') === 'on'
      };
      try {
        const res = await api(`/api/admin/players/${encodeURIComponent(id)}`, { method: 'PUT', body: payload });
        if (res?.player) {
          const idx = (state.bootstrap?.candidates || []).findIndex(c => c.id === id);
          if (idx !== -1) state.bootstrap.candidates[idx] = res.player;
          if (state.room?.candidatePool) {
            const rIdx = state.room.candidatePool.findIndex(c => c.id === id);
            if (rIdx !== -1) state.room.candidatePool[rIdx] = res.player;
          }
          state.poolManager.editingPlayer = null;
          toast(`Candidate record for ${res.player.name} updated!`, 'success');
          renderHome();
        }
      } catch (err) {
        toast(err.message || 'Failed to update candidate', 'error');
      }
    });
  }

  app.querySelectorAll('[data-action="select-home"]').forEach(btn => btn.addEventListener('click', async () => {
    state.homePanel = btn.dataset.panel;
    if (state.homePanel === 'host' && state.ownerToken) {
      try {
        const current = await api('/api/host/current');
        state.activeRoomData = current?.room ? current : null;
        state.ownerReady = true;
      } catch {
        state.ownerToken = null;
        state.activeRoomData = null;
        state.ownerReady = false;
        store.removeItem('ipl27-owner-token');
      }
    } else if (state.homePanel !== 'host') {
      state.ownerReady = false;
    }
    renderHome();
    requestAnimationFrame(() => {
      const field = document.getElementById(state.homePanel === 'host' && !state.ownerReady ? 'owner-code' : 'quick-room-code');
      const panel = field?.closest('.form-card');
      if (window.matchMedia('(max-width: 880px)').matches) panel?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      field?.focus({ preventScroll: true });
    });
  }));
  app.querySelectorAll('[data-action="select-mode"]').forEach(btn => btn.addEventListener('click', () => {
    state.selectedMode = btn.dataset.mode;
    renderHome();
  }));
  app.querySelectorAll('[data-action="select-ret-mode"]').forEach(btn => btn.addEventListener('click', () => {
    state.selectedRetentionMode = btn.dataset.retMode;
    renderHome();
  }));
  const joinForm = document.getElementById('quick-join-form');
  if (joinForm) joinForm.addEventListener('submit', async e => {
    e.preventDefault();
    const code = document.getElementById('quick-room-code').value.trim().toUpperCase();
    if (!code) return;
    await openJoin(code);
  });
  const ownerForm = document.getElementById('owner-login-form');
  if (ownerForm) ownerForm.addEventListener('submit', async e => {
    e.preventDefault();
    try {
      const result = await api('/api/host/login', { method: 'POST', body: { code: document.getElementById('owner-code').value } });
      state.ownerToken = result.token;
      store.setItem('ipl27-owner-token', result.token);
      state.ownerReady = true;
      state.homePanel = 'host';
      if (result.activeRoomCode) {
        const current = await api(`/api/host/current`);
        if (current && current.room) {
          state.activeRoomData = current;
          renderHome();
          toast(`Host controls unlocked. Active room ${current.room.code} ready to resume or close.`, 'success');
          return;
        }
      }
      state.activeRoomData = null;
      renderHome();
      toast('Host controls unlocked.', 'success');
    } catch (err) { toast(err.message, 'error'); }
  });
  const setupForm = document.getElementById('host-setup-form');
  if (setupForm) setupForm.addEventListener('submit', async e => {
    e.preventDefault();
    if (state.inFlightCreate) return;
    state.inFlightCreate = true;
    const submitBtn = setupForm.querySelector('button[type="submit"]');
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.dataset.originalHtml = submitBtn.innerHTML;
      submitBtn.innerHTML = 'Creating room…';
    }
    const fd = new FormData(setupForm);
    try {
      const result = await api('/api/host/create-room', {
        method: 'POST',
        body: {
          mode: state.selectedMode,
          retentionMode: state.selectedMode === 'mega' ? (state.selectedRetentionMode || 'host') : 'host',
          timerSeconds: Number(fd.get('timerSeconds')),
          maxSquadSize: Number(fd.get('maxSquadSize')),
          maxOverseas: Number(fd.get('maxOverseas')),
          megaPurseCr: Number(fd.get('megaPurseCr') || 120),
          miniPurseAddOnCr: Number(fd.get('miniPurseAddOnCr') ?? 5),
          revisitUnsold: fd.has('revisitUnsold'),
          randomOrder: fd.has('randomOrder')
        }
      });
      state.isHost = true;
      state.participant = null;
      state.roomCode = result.room.code;
      state.view = result.room.status === 'retention' ? 'retention' : 'floor';
      state.ownerReady = false;
      state.activeRoomData = null;
      state.lastVersion = null;
      state.lastEventId = null;
      store.setItem('ipl27-owner-room', result.room.code);
      store.removeItem('ipl27-participant');
      setUrlRoom(state.roomCode);
      try {
        acceptRoom(result.room, true);
      } catch (renderErr) {
        console.error('[ROOM RENDER ERROR]', renderErr);
        toast(renderErr.message || 'Render error during room setup', 'error');
      }
      startPolling();
      toast(`Room ${result.room.code} created.`, 'success');
    } catch (err) {
      toast(err.message, 'error');
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.innerHTML = submitBtn.dataset.originalHtml || 'Create one active room <span>↗</span>';
      }
    } finally {
      state.inFlightCreate = false;
    }
  });
  app.querySelectorAll('[data-action="logout-owner"]').forEach(btn => btn.addEventListener('click', () => {
    state.ownerToken = null;
    state.ownerReady = false;
    state.activeRoomData = null;
    store.removeItem('ipl27-owner-token');
    store.removeItem('ipl27-owner-room');
    renderHome();
  }));
  app.querySelectorAll('[data-action="open-close-room"]').forEach(btn => btn.addEventListener('click', e => {
    e.stopPropagation();
    if (btn.dataset.room) state.existingRoomCode = btn.dataset.room;
    else if (state.activeRoomData?.roomCode) state.existingRoomCode = state.activeRoomData.roomCode;
    state.showCloseModal = true;
    renderHome();
  }));
  app.querySelectorAll('[data-action="cancel-close-room"]').forEach(btn => btn.addEventListener('click', e => {
    e.stopPropagation();
    state.showCloseModal = false;
    renderHome();
  }));
  app.querySelectorAll('[data-action="confirm-close-room"]').forEach(btn => btn.addEventListener('click', async e => {
    e.stopPropagation();
    await handleConfirmCloseRoom();
  }));
  app.querySelectorAll('[data-action="resume-existing-room"], [data-action="enter-existing-room"]').forEach(btn => btn.addEventListener('click', async () => {
    await handleResumeExistingRoom();
  }));

  // Franchise Audio Actions in Home/Host tab
  app.querySelectorAll('[data-action="upload-audio"]').forEach(btn => btn.addEventListener('click', async () => {
    await uploadAudio(btn.dataset.team);
  }));
  app.querySelectorAll('[data-action="preview-audio"]').forEach(btn => btn.addEventListener('click', async () => {
    await previewAudio(btn.dataset.team, btn.dataset.url);
  }));
  app.querySelectorAll('[data-action="restore-default-audio"]').forEach(btn => btn.addEventListener('click', async () => {
    await restoreDefaultAudio(btn.dataset.team);
  }));
  bindAudioInputs();

  if (state.showJoinModal) bindJoinModal();
}

async function handleResumeExistingRoom() {
  try {
    const current = await api('/api/host/current');
    if (!current || !current.room) {
      state.activeRoomData = null;
      renderHome();
      toast('The active room has already ended or closed.', 'error');
      return;
    }
    state.isHost = true;
    state.ownerReady = false;
    state.roomCode = current.room.code;
    state.participant = null;
    state.view = current.room.status === 'retention' ? 'retention' : 'floor';
    state.lastVersion = null;
    state.lastEventId = current.room.lastEvent?.id || null;
    store.setItem('ipl27-owner-room', current.room.code);
    store.removeItem('ipl27-participant');
    setUrlRoom(state.roomCode);
    acceptRoom(current.room, true);
    startPolling();
    toast(`Resumed room ${current.room.code}.`, 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function openJoin(code) {
  try {
    const result = await api(`/api/room/${encodeURIComponent(code)}/state`);
    state.roomCode = result.room.code;
    state.room = result.room;
    state.isHost = false;
    state.participant = null;
    state.showJoinModal = true;
    state.joinDraft = { name: '', teamId: '' };
    state.homePanel = 'join';
    state.lastVersion = null;
    state.lastEventId = result.room.lastEvent?.id || null;
    setUrlRoom(result.room.code);
    renderRoom();
    startPolling();
  } catch (err) { toast(err.message, 'error'); }
}

function renderJoinModal() {
  if (!state.room) return '';
  const claimedIds = new Set(state.room.participants.filter(p => p.teamId && p.clientId !== clientId).map(p => p.teamId));
  const draftTeam = state.joinDraft.teamId;
  const spectatorSelected = draftTeam === '';
  const choices = `<button type="button" class="team-choice ${spectatorSelected ? 'selected' : ''}" data-team-choice=""><span class="team-badge" style="--team-primary:#26394e;--team-secondary:#eef5fb">◎</span><span><strong>Spectator</strong><small>Watch without bidding</small></span></button>` + state.room.teams.map(t => {
    const claimed = claimedIds.has(t.id);
    const occupant = state.room.participants.find(p => p.teamId === t.id);
    const isSelected = draftTeam === t.id && !claimed;
    return `<button type="button" class="team-choice ${isSelected ? 'selected' : ''}" data-team-choice="${t.id}" ${claimed ? 'disabled' : ''} style="${teamStyle(t)}"><span class="team-badge">${escapeHtml(t.id)}</span><span><strong>${escapeHtml(t.name)}</strong><small>${claimed ? `Taken by ${escapeHtml(occupant?.name || 'a participant')}` : `Purse ${fmtCr(t.purseCr)}`}</small></span></button>`;
  }).join('');

  return `<div class="join-veil" id="join-veil"><div class="modal-card"><div class="modal-head"><div><div class="kicker">Room ${escapeHtml(state.room.code)}</div><h2>Join the auction</h2><p class="sub">Choose your display name and, if available, the franchise you want to control.</p></div><button type="button" class="close-x" data-action="close-join">×</button></div><form id="join-room-form"><div class="field"><label>Display name</label><input class="input" name="name" id="join-name" placeholder="Your name" maxlength="40" required value="${escapeHtml(state.joinDraft.name)}" /></div><label class="label-uppercase">Select a franchise</label><div class="team-select-grid">${choices}</div><input type="hidden" name="teamId" id="join-team-id" value="${escapeHtml(draftTeam)}" /><button type="submit" class="btn btn-primary btn-block btn-lg">Join room <span>→</span></button><p class="small-note" style="margin-top:12px">One participant can control each franchise. Spectator mode allows watching.</p></form></div></div>`;
}

function bindJoinModal() {
  app.querySelectorAll('[data-team-choice]').forEach(btn => btn.addEventListener('click', () => {
    if (btn.disabled) return;
    state.joinDraft.teamId = btn.dataset.teamChoice || '';
    app.querySelectorAll('[data-team-choice]').forEach(b => b.classList.toggle('selected', b === btn));
    const hidden = document.getElementById('join-team-id');
    if (hidden) hidden.value = state.joinDraft.teamId;
  }));
  const nameInput = document.getElementById('join-name');
  if (nameInput) nameInput.addEventListener('input', () => { state.joinDraft.name = nameInput.value; });
  const form = document.getElementById('join-room-form');
  if (form) form.addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(form);
    try {
      const result = await api(`/api/room/${encodeURIComponent(state.roomCode)}/join`, {
        method: 'POST',
        body: { clientId, name: fd.get('name'), teamId: fd.get('teamId') || null }
      });
      state.joinDraft = { name: '', teamId: '' };
      state.participant = result.participant;
      state.showJoinModal = false;
      try {
        store.setItem('ipl27-participant', JSON.stringify({
          roomCode: state.roomCode,
          participant: state.participant,
          clientId,
          timestamp: Date.now()
        }));
      } catch {}
      acceptRoom(result.room, true);
      startPolling();
      toast(state.participant.teamId ? `You now control ${state.participant.teamId}.` : 'You joined as a spectator.', 'success');
    } catch (err) { toast(err.message, 'error'); }
  });
  app.querySelectorAll('[data-action="close-join"]').forEach(btn => btn.addEventListener('click', () => {
    state.joinDraft = { name: '', teamId: '' };
    state.showJoinModal = false;
    renderRoom();
  }));
  const veil = document.getElementById('join-veil');
  if (veil) veil.addEventListener('click', e => {
    if (e.target === veil) {
      state.joinDraft = { name: '', teamId: '' };
      state.showJoinModal = false;
      renderRoom();
    }
  });
}

function currentOwnerPanel(room) {
  if (!state.isHost) {
    if (!state.participant) {
      return `<div class="console-status"><div class="panel-meta">Your seat</div><div class="console-big">Join to bid</div><div class="console-desc">Pick an available franchise. Team owners can raise bids; spectators follow the auction.</div></div><div class="control-stack"><button type="button" class="btn btn-primary btn-block" data-action="show-join">Join this room</button></div>`;
    }
    if (state.participant.role === 'spectator') {
      return `<div class="console-status"><div class="panel-meta">Spectator mode</div><div class="console-big">On the floor</div><div class="console-desc">Watching live. To bid, release your spectator seat and claim an available franchise.</div></div><div class="control-stack"><button type="button" class="btn btn-secondary btn-block" data-action="leave-seat">Leave spectator seat</button><button type="button" class="btn btn-ghost btn-block" data-action="show-join">Claim a franchise</button></div>`;
    }
    const team = teamStateById(state.participant.teamId);
    const expected = nextBidAmount(room);
    const p = room.currentPlayer;
    const isLive = room.status === 'live' && room.lotState === 'bidding';
    const audioBlocked = Boolean(room.celebrationActive || room.lotState === 'celebration');
    const canBid = Boolean(!audioBlocked && isLive && !room.lotDone && team && expected != null && room.currentBidTeamId !== team.id && team.purseCr + 0.001 >= expected && team.squad.length < room.maxSquadSize && !(p?.origin === 'Overseas' && team.squad.filter(x => x.overseas).length >= room.maxOverseas) && room.bidEndsAt && Date.now() < room.bidEndsAt);

    let disabledReason = audioBlocked ? 'Victory anthem playing · Bidding unlocks when audio completes.' :
                          !isLive ? 'Waiting for the next lot to start.' :
                          !room.bidEndsAt || Date.now() >= room.bidEndsAt ? 'Timer ended. The lot is settling automatically.' :
                          room.currentBidTeamId === team?.id ? 'You are the highest bidder. Wait for another franchise to raise.' :
                          !team || team.purseCr + 0.001 < expected ? 'Insufficient remaining purse.' :
                          team.squad.length >= room.maxSquadSize ? 'Your squad is full.' :
                          p?.origin === 'Overseas' && team.squad.filter(x => x.overseas).length >= room.maxOverseas ? 'Overseas-player limit reached.' : '';

    const bidLabel = audioBlocked ? 'VICTORY ANTHEM PLAYING…' : room.currentBidTeamId === team?.id ? 'You hold the lead' : `Raise to ${fmtCr(expected)} ↗`;
    return `<div class="console-status"><div class="panel-meta">Your franchise · ${escapeHtml(team?.id || '')}</div><div class="console-big">${fmtCr(team?.purseCr)}</div><div class="console-desc">Remaining purse. ${team?.squad.length || 0}/${room.maxSquadSize} squad slots used · ${team?.overseasCount || 0}/${room.maxOverseas} overseas players.</div></div><div class="control-stack"><button type="button" class="btn btn-primary btn-block btn-lg" data-action="bid" ${canBid ? '' : 'disabled'}>${bidLabel}</button><div class="small-note">${escapeHtml(disabledReason || `Your next valid bid is ${fmtCr(expected)}.`)}</div><button type="button" class="btn btn-ghost btn-block" data-action="leave-seat">Release my seat</button></div>`;
  }

  const p = room.currentPlayer;
  const audioToggleCard = `
    <div class="host-audio-toggle-card">
      <div class="host-audio-toggle-info">
        <span class="host-audio-toggle-title">🔊 Franchise Celebration Audio</span>
        <span class="host-audio-toggle-status ${room.celebrationAudioEnabled !== false ? 'status-on' : 'status-off'}">
          ${room.celebrationAudioEnabled !== false ? 'ENABLED' : 'DISABLED (3s VISUAL)'}
        </span>
      </div>
      <button type="button" class="btn btn-sm ${room.celebrationAudioEnabled !== false ? 'btn-toggle-on' : 'btn-toggle-off'}" data-action="toggle-celebration-audio">
        ${room.celebrationAudioEnabled !== false ? '🔊 Anthem Audio: ON' : '🔇 Anthem Audio: OFF'}
      </button>
    </div>`;

  if (room.status === 'ready') {
    return `<div class="console-status"><div class="panel-meta">Auction controls</div><div class="console-big">Ready to open</div><div class="console-desc">${room.auctionOrder.length} candidates queued. Room code <b>${escapeHtml(room.code)}</b> is ready to share.</div></div><div class="control-stack"><button type="button" class="btn btn-primary btn-block btn-lg" data-action="start-auction">Start auction <span>↗</span></button>${audioToggleCard}<button type="button" class="btn btn-secondary btn-block" data-action="open-audio">Manage franchise audio</button><button type="button" class="btn btn-danger btn-block" data-action="open-close-room">Close room</button></div><div class="price-editor"><div class="panel-meta">Host override · opening base price</div><form id="base-price-form" class="field-row" style="margin-top:10px"><div class="field"><input class="input" name="priceCr" type="number" min="0.2" max="20" step="0.05" value="${p ? p.basePriceCr.toFixed(2) : '0.20'}" ${!p ? 'disabled' : ''}/></div><button type="submit" class="btn btn-ghost btn-sm" ${!p ? 'disabled' : ''}>Update</button></form><div class="small-note" style="margin-top:7px">Adjust base price before first bid.</div></div>`;
  }
  if (room.status === 'finished') {
    return `<div class="console-status"><div class="panel-meta">Auction complete</div><div class="console-big">Hammer down.</div><div class="console-desc">${room.soldCount} players sold. Review final squads and logs.</div></div><div class="control-stack">${audioToggleCard}<button type="button" class="btn btn-secondary btn-block" data-action="open-audio">Manage franchise audio</button><button type="button" class="btn btn-danger btn-block" data-action="open-close-room">Close room</button></div>`;
  }

  const liveLot = room.status === 'live' && room.lotState === 'bidding';
  const hasRtmOpportunity = room.mode === 'mega' && p?.originalTeamId && room.currentBidTeamId && room.currentBidTeamId !== p.originalTeamId && (room.teams.find(t => t.id === p.originalTeamId)?.rtmCount > 0);

  return `<div class="console-status"><div class="panel-meta">Auctioneer console</div><div class="console-big">${room.status === 'paused' ? 'Floor paused' : room.lotDone ? (room.results[p?.id]?.status === 'sold' ? 'Player sold' : 'Lot settled') : 'Live bidding'}</div><div class="console-desc">${room.status === 'paused' ? 'Clock on hold. Resume when ready.' : room.lotDone ? 'Next player starts automatically or click skip.' : 'A bid wins the player when timer ends.'}</div></div>
    <div class="control-stack">${room.status === 'paused' ? `<button type="button" class="btn btn-primary btn-block" data-action="resume-auction">Resume auction</button>` : `<button type="button" class="btn btn-secondary btn-block" data-action="pause-auction" ${room.status !== 'live' ? 'disabled' : ''}>Ⅱ Pause auction</button>`}
      <div class="control-pair"><button type="button" class="btn btn-primary" data-action="mark-sold" ${!liveLot || room.currentBidCr == null ? 'disabled' : ''}>✓ SOLD</button><button type="button" class="btn btn-danger" data-action="mark-unsold" ${!liveLot ? 'disabled' : ''}>× UNSOLD</button></div>
      ${hasRtmOpportunity ? `<button type="button" class="btn btn-gold btn-block" data-action="rtm-match">Match Bid for ${escapeHtml(p.originalTeamId)} (RTM Card)</button>` : ''}
      ${room.celebrationActive && state.isHost ? `<button type="button" class="btn btn-secondary btn-block" data-action="skip-celebration">Skip Celebration ⏭</button>` : ''}
      <button type="button" class="btn btn-secondary btn-block" data-action="next-player" ${!room.lotDone || state.celebration ? 'disabled' : ''}>Next player →</button>
      ${audioToggleCard}
      <button type="button" class="btn btn-ghost btn-block" data-action="open-audio">♫ Franchise audio settings</button><button type="button" class="btn btn-danger btn-block" data-action="open-close-room">Close room</button>
    </div>
    <div class="price-editor"><div class="panel-meta">Host override · base price</div><form id="base-price-form" class="field-row" style="margin-top:10px"><div class="field"><input class="input" name="priceCr" type="number" min="0.2" max="20" step="0.05" value="${p ? p.basePriceCr.toFixed(2) : '0.20'}" ${!p || room.lotDone || room.currentBidCr != null ? 'disabled' : ''}/></div><button type="submit" class="btn btn-ghost btn-sm" ${!p || room.lotDone || room.currentBidCr != null ? 'disabled' : ''}>Update</button></form></div>`;
}

// -----------------------------------------------------------------------------
// Mega Auction Retention Phase Screen
// -----------------------------------------------------------------------------
function renderRetentionView() {
  const room = state.room;
  const isParticipantMode = room?.retentionMode === 'participants';
  const initialSquadsMap = room.initialSquads || state.bootstrap?.initialSquads || {};
  const teams = room.teams || [];
  const confirmedCount = teams.filter(t => t.retentionConfirmed).length;
  const canStart = isParticipantMode ? (confirmedCount >= 1) : true;

  // CASE 1: In participant-managed mode, the Host monitors via the 10-Franchise Readiness Dashboard
  if (isParticipantMode && state.isHost) {
    const allReady = confirmedCount === 10;
    const readinessText = confirmedCount === 0
      ? '0 / 10 franchises confirmed — At least one franchise must confirm retentions before the auction can start.'
      : `${confirmedCount} / 10 franchises confirmed — You can start with the confirmed retentions and finalize the remaining franchises automatically.`;

    const franchiseRows = teams.map(t => {
      const occupant = (room.participants || []).find(p => p.teamId === t.id);
      const isConfirmed = t.retentionConfirmed;
      const isAutoFinalized = Boolean(t.autoFinalized || t.retentionFinalizedBy === 'host');
      const statusText = isConfirmed
        ? (isAutoFinalized
            ? `AUTO-FINALIZED (HOST) · 0 retentions · ${fmtCr(t.startingPurseCr)} starting purse · 6 RTMs`
            : `✓ Confirmed (${t.retentions?.length || 0} retained · ${fmtCr(t.retentionCostCr || 0)} spend · ${t.rtmCount ?? 6} RTMs)`)
        : occupant
          ? `Awaiting selection · ${escapeHtml(occupant.name)} drafting selections`
          : `Awaiting owner · No participant joined yet (auto-finalizes on start)`;
      const badgeText = isConfirmed
        ? (isAutoFinalized ? 'AUTO-FINALIZED (HOST)' : '✓ CONFIRMED')
        : occupant ? 'IN PROGRESS' : 'AWAITING OWNER';
      const badgeClass = isConfirmed ? (isAutoFinalized ? 'gold' : 'lime') : occupant ? 'gold' : '';

      return `<div class="retention-status-card ${isConfirmed ? 'confirmed' : ''}" style="${teamStyle(t)}">
        <div class="ret-status-left">
          ${teamBadge(t.id)}
          <div>
            <div class="ret-team-title"><strong>${escapeHtml(t.name)}</strong> (${escapeHtml(t.short || t.id)})</div>
            <div class="ret-team-occupant">${occupant ? `👤 Controlled by <b>${escapeHtml(occupant.name)}</b>` : `<span style="opacity:0.65">Unclaimed franchise</span>`}</div>
            <div class="ret-team-details">${escapeHtml(statusText)}</div>
          </div>
        </div>
        <div class="ret-status-right">
          <span class="tag ${badgeClass}">${badgeText}</span>
        </div>
      </div>`;
    }).join('');

    return `<div class="room-title-row">
      <div>
        <div class="kicker">MEGA AUCTION · PARTICIPANT RETENTION SELECTION</div>
        <h1 class="page-title">FRANCHISE <em>RETENTION DASHBOARD</em></h1>
        <div class="page-subtitle">Mode: Participants select retentions for their own franchises · IPL 2025–27 Reference Regulations</div>
      </div>
      <div class="room-actions">
        <button type="button" class="btn btn-danger btn-sm" data-action="open-close-room">Close Room</button>
        <span class="pill ${allReady ? 'pill-green' : ''}">${confirmedCount} / 10 FRANCHISES CONFIRMED</span>
      </div>
    </div>

    <section class="retention-view">
      <div class="retention-hero">
        <div class="panel-head">
          <span class="panel-title">Franchise Retention Readiness Monitor</span>
          <span class="panel-meta">HOST DASHBOARD · READY TO START WHEN ≥1 CONFIRMED</span>
        </div>
        <div class="retention-summary-grid">
          <div class="retention-stat-card"><small>Confirmed Franchises</small><strong class="${canStart ? 'highlight-green' : ''}">${confirmedCount} / 10</strong></div>
          <div class="retention-stat-card"><small>Pending Franchises</small><strong class="${canStart ? '' : 'highlight-gold'}">${10 - confirmedCount}</strong></div>
          <div class="retention-stat-card"><small>Claimed by Owners</small><strong>${teams.filter(t => (room.participants || []).some(p => p.teamId === t.id)).length} / 10</strong></div>
          <div class="retention-stat-card"><small>Minimum Start Requirement</small><strong>1 Confirmed Franchise</strong></div>
        </div>
      </div>

      <div class="retention-status-list" style="display:grid;gap:12px;margin:20px 0">
        ${franchiseRows}
      </div>

      <div class="retention-actions-bar">
        <div class="retention-actions-left">
          <div><strong>Host Readiness:</strong> ${readinessText}</div>
        </div>
        <div class="retention-actions-right">
          <button type="button" class="btn ${canStart ? 'btn-gold' : 'btn-secondary'} btn-lg" data-action="finalize-retentions" ${canStart ? '' : 'disabled title="At least one franchise must confirm retentions before starting"'}>Finalize Remaining Teams & Start Auction</button>
        </div>
      </div>
    </section>`;
  }

  // CASE 2: Participant in participant-managed mode who has NOT claimed a team (Spectator)
  if (isParticipantMode && (!state.participant || !state.participant.teamId)) {
    const franchiseRows = teams.map(t => {
      const occupant = (room.participants || []).find(p => p.teamId === t.id);
      const isConfirmed = t.retentionConfirmed;
      return `<div class="retention-status-card ${isConfirmed ? 'confirmed' : ''}" style="${teamStyle(t)}">
        <div class="ret-status-left">
          ${teamBadge(t.id)}
          <div>
            <div class="ret-team-title"><strong>${escapeHtml(t.name)}</strong> (${escapeHtml(t.short || t.id)})</div>
            <div class="ret-team-occupant">${occupant ? `Controlled by <b>${escapeHtml(occupant.name)}</b>` : `<b style="color:var(--accent)">Available to claim!</b>`}</div>
            <div class="ret-team-details">${isConfirmed ? `✓ Retentions confirmed (${t.retentions?.length || 0} players)` : occupant ? 'Owner drafting selections' : 'Join as this team owner to select retentions'}</div>
          </div>
        </div>
        <div class="ret-status-right">
          ${occupant ? `<span class="tag ${isConfirmed ? 'lime' : ''}">${isConfirmed ? '✓ CONFIRMED' : 'CLAIMED'}</span>` : `<button type="button" class="btn btn-primary btn-sm" data-action="claim-team" data-team="${t.id}">Claim ${t.id} ↗</button>`}
        </div>
      </div>`;
    }).join('');

    return `<div class="room-title-row">
      <div>
        <div class="kicker">MEGA AUCTION · PARTICIPANT RETENTION SELECTION</div>
        <h1 class="page-title">FRANCHISE <em>RETENTIONS</em></h1>
        <div class="page-subtitle">Each franchise owner selects their own retentions. Claim an available franchise below to select players.</div>
      </div>
      <div class="room-actions">
        <button type="button" class="btn btn-primary" data-action="show-join">Claim a Franchise ↗</button>
      </div>
    </div>
    <section class="retention-view">
      <div class="retention-status-list" style="display:grid;gap:12px;margin:20px 0">
        ${franchiseRows}
      </div>
    </section>`;
  }

  // CASE 3: Active Franchise Editor
  // In participant-managed mode: participant edits THEIR OWN team only
  // In host-managed mode: host can switch between all 10 teams via tabs
  let activeTeamId = isParticipantMode ? state.participant?.teamId : state.selectedRetentionTeam;
  if (!activeTeamId) {
    activeTeamId = teams[0]?.id || 'CSK';
  }
  state.selectedRetentionTeam = activeTeamId;
  const currentTeam = teams.find(t => t.id === activeTeamId) || teams[0];
  const squad = initialSquadsMap[activeTeamId] || [];
  const isConfirmed = Boolean(currentTeam.retentionConfirmed);

  // Rehydrate draft list from confirmed retentions if confirmed on server
  if (isConfirmed) {
    state.retentionDraft[activeTeamId] = currentTeam.retentions ? currentTeam.retentions.map(r => ({ name: r.name, type: r.type || 'capped' })) : [];
  } else if (!state.retentionDraft[activeTeamId]) {
    state.retentionDraft[activeTeamId] = currentTeam.retentions ? currentTeam.retentions.map(r => ({ name: r.name, type: r.type || 'capped' })) : [];
  }
  const draftList = state.retentionDraft[activeTeamId];
  const draftNames = new Set(draftList.map(x => (x.name || '').toLowerCase().trim()));

  // Local calculation of cost & slabs
  let cappedCount = 0;
  let uncappedCount = 0;
  let totalCostCr = 0;
  for (const item of draftList) {
    if (item.type === 'capped') {
      if (cappedCount < RETENTION_SLABS_CR.length) {
        totalCostCr += RETENTION_SLABS_CR[cappedCount];
      }
      cappedCount++;
    } else {
      totalCostCr += UNCAPPED_COST_CR;
      uncappedCount++;
    }
  }
  const totalCount = cappedCount + uncappedCount;
  const rtmLeft = Math.max(0, 6 - totalCount);
  const remainingPurseCr = Math.max(0, roundCr(currentTeam.startingPurseCr - totalCostCr));
  const isInvalid = totalCount > 6 || cappedCount > 5 || uncappedCount > 2 || totalCostCr > currentTeam.startingPurseCr;

  let validationMsg = '';
  if (totalCount > 6) validationMsg = 'Maximum 6 combined direct retentions and RTM cards allowed.';
  else if (cappedCount > 5) validationMsg = 'Maximum 5 capped players allowed.';
  else if (uncappedCount > 2) validationMsg = 'Maximum 2 uncapped players allowed.';
  else if (totalCostCr > currentTeam.startingPurseCr) validationMsg = `Total cost (₹${totalCostCr} Cr) exceeds starting purse (₹${currentTeam.startingPurseCr} Cr).`;

  // Authorization check: cannot edit if locked/confirmed
  const canControl = isParticipantMode
    ? Boolean(state.participant && state.participant.teamId === activeTeamId && !isConfirmed)
    : Boolean(state.isHost && !isConfirmed);

  // Filter roster
  if (!state.retentionFilter) state.retentionFilter = 'all';
  const filter = state.retentionFilter;
  const filteredSquad = squad.filter(p => {
    if (filter === 'all') return true;
    if (filter === 'retained') return draftNames.has((p.name || '').toLowerCase().trim());
    const role = (p.roleBucket || p.role || '').toLowerCase();
    if (filter === 'batter') return role.includes('bat');
    if (filter === 'bowler') return role.includes('bowl');
    if (filter === 'allrounder') return role.includes('all') || role.includes('round');
    if (filter === 'keeper') return role.includes('keep') || role.includes('wk');
    return true;
  });

  // Team Navigation Tabs: ONLY displayed in host-managed mode
  const teamTabs = !isParticipantMode ? teams.map(t => {
    const isTeamConfirmed = t.retentionConfirmed;
    return `<button type="button" class="retention-team-btn ${t.id === activeTeamId ? 'active' : ''}" data-action="select-ret-team" data-team="${t.id}" style="${teamStyle(t)}">${teamBadge(t.id)}<span>${escapeHtml(t.short || t.id)}</span><span class="ret-status-dot ${isTeamConfirmed ? '' : 'pending'}" title="${isTeamConfirmed ? 'Confirmed' : 'Pending'}"></span></button>`;
  }).join('') : '';

  // Roster cards
  const rosterCards = filteredSquad.map(p => {
    const pNorm = (p.name || '').toLowerCase().trim();
    const isSelected = draftNames.has(pNorm);
    const selItem = draftList.find(x => (x.name || '').toLowerCase().trim() === pNorm);
    const isOverseas = p.overseas || p.origin === 'Overseas' || p.nationality !== 'India';
    const isUncappedEligible = !isOverseas && (p.cappedStatus === 'Uncapped' || p.cappedStatus === 'Needs verification');
    const currentType = selItem?.type || (isUncappedEligible ? 'uncapped' : 'capped');

    let slabCost = 0;
    if (isSelected) {
      if (currentType === 'capped') {
        const cappedIdx = draftList.filter((x, idx) => x.type === 'capped' && draftList.findIndex(y => (y.name || '').toLowerCase().trim() === pNorm) >= idx).length - 1;
        slabCost = RETENTION_SLABS_CR[Math.min(cappedIdx, RETENTION_SLABS_CR.length - 1)] || 18;
      } else {
        slabCost = UNCAPPED_COST_CR;
      }
    } else {
      slabCost = (isUncappedEligible && currentType === 'uncapped') ? UNCAPPED_COST_CR : (RETENTION_SLABS_CR[cappedCount] || 18);
    }

    return `<article class="retention-player-card ${isSelected ? 'is-selected' : ''} ${isConfirmed ? 'is-locked' : ''}" data-player="${escapeHtml(p.name)}" data-uncapped="${isUncappedEligible && currentType === 'uncapped'}">
      <div class="retention-card-header-row">
        <label class="retention-checkbox-wrap" title="${canControl ? 'Click to retain/release' : ''}">
          <input type="checkbox" class="retention-checkbox" data-action="toggle-retain" data-player="${escapeHtml(p.name)}" data-uncapped="${isUncappedEligible && currentType === 'uncapped'}" ${isSelected ? 'checked' : ''} ${!canControl ? 'disabled' : ''} />
          <span class="retention-check-indicator"></span>
        </label>
        <span class="retention-slab-preview">${isSelected ? `<strong class="tag lime">✓ Retained: ₹${slabCost} Cr (${currentType})</strong>` : `<small style="color:var(--muted)">Est: ₹${slabCost} Cr</small>`}</span>
      </div>
      <div class="retention-player-top">
        <div class="retention-player-photo">${p.image ? `<img src="${escapeHtml(p.image)}" alt="${escapeHtml(p.name)}" onerror="this.style.display='none';this.parentElement.classList.add('no-photo')"/>` : ''}<span class="photo-placeholder">${escapeHtml(initials(p.name))}</span></div>
        <div class="retention-player-details">
          <div class="retention-player-name" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</div>
          <div class="retention-player-meta">${escapeHtml(p.role || p.roleBucket || 'Player')} · ${escapeHtml(p.nationality || 'India')}</div>
          <div class="retention-player-tags">
            <span class="tag ${isOverseas ? '' : 'lime'}">${isOverseas ? 'Overseas' : 'Domestic'}</span>
            <span class="tag">${isUncappedEligible ? 'Uncapped eligible' : 'Capped'}</span>
          </div>
        </div>
      </div>
      <div class="retention-card-actions">
        ${isUncappedEligible && canControl ? `
          <div class="retention-type-toggle">
            <label>Type:</label>
            <select data-action="toggle-ret-type" data-player="${escapeHtml(p.name)}">
              <option value="capped" ${currentType === 'capped' ? 'selected' : ''}>Capped (Slab)</option>
              <option value="uncapped" ${currentType === 'uncapped' ? 'selected' : ''}>Uncapped (₹4 Cr)</option>
            </select>
          </div>
        ` : `<span></span>`}
        ${canControl ? `<button type="button" class="retention-select-btn ${isSelected ? 'selected' : ''}" data-action="toggle-retain" data-player="${escapeHtml(p.name)}" data-uncapped="${isUncappedEligible && currentType === 'uncapped'}">${isSelected ? '✓ Selected — Deselect' : '+ Select Player'}</button>` : `<span class="tag ${isSelected ? 'lime' : ''}">${isConfirmed ? (isSelected ? '✓ Confirmed' : 'Released') : (isSelected ? 'Selected' : 'Available')}</span>`}
      </div>
    </article>`;
  }).join('');

  const unconfirmedTeams = teams.filter(t => !t.retentionConfirmed);
  const unconfirmedList = unconfirmedTeams.map(t => t.id).join(', ');

  return `<div class="room-title-row">
    <div>
      <div class="kicker">${isParticipantMode ? `MEGA AUCTION · YOUR FRANCHISE (${escapeHtml(currentTeam.id)})` : 'MEGA AUCTION · HOST RETENTION SELECTION'}</div>
      <h1 class="page-title">${teamBadge(currentTeam.id)} ${escapeHtml(currentTeam.name)} <em>RETENTIONS</em></h1>
      <div class="page-subtitle">${isParticipantMode ? 'Select and confirm retentions for your team before the auction begins.' : 'Host configures retentions for all 10 franchises.'} · Slabs: ₹18, 14, 11, 18, 14 Cr · Uncapped: ₹4 Cr · Max 6 Retentions/RTMs</div>
    </div>
    <div class="room-actions">
      ${state.isHost ? '<button type="button" class="btn btn-danger btn-sm" data-action="open-close-room">Close Room</button>' : ''}
      <span class="pill ${currentTeam.retentionConfirmed ? 'pill-green' : ''}">${currentTeam.retentionConfirmed ? `✓ ${currentTeam.id} CONFIRMED` : 'DRAFT IN PROGRESS'} · ${confirmedCount} / 10 TEAMS READY</span>
    </div>
  </div>

  <section class="retention-view">
    <div class="retention-hero">
      <div class="panel-head">
        <span class="panel-title">${teamBadge(currentTeam.id)} ${escapeHtml(currentTeam.name)} Retention Budget</span>
        <span class="panel-meta">${currentTeam.retentionConfirmed ? '✓ CONFIRMED ON SERVER' : 'LOCAL DRAFT REVIEW'}</span>
      </div>
      <div class="retention-summary-grid">
        <div class="retention-stat-card"><small>Retained Players</small><strong class="${totalCount > 6 ? 'highlight-red' : ''}">${totalCount} / 6</strong></div>
        <div class="retention-stat-card"><small>Capped Retentions</small><strong class="${cappedCount > 5 ? 'highlight-red' : ''}">${cappedCount} / 5</strong></div>
        <div class="retention-stat-card"><small>Uncapped Retentions</small><strong class="${uncappedCount > 2 ? 'highlight-red' : ''}">${uncappedCount} / 2</strong></div>
        <div class="retention-stat-card"><small>RTM Cards Remaining</small><strong class="highlight-gold">${rtmLeft}</strong></div>
        <div class="retention-stat-card"><small>Retention Spend</small><strong class="${totalCostCr > currentTeam.startingPurseCr ? 'highlight-red' : ''}">${fmtCr(totalCostCr)}</strong></div>
        <div class="retention-stat-card"><small>Remaining Auction Purse</small><strong>${fmtCr(remainingPurseCr)}</strong></div>
      </div>
      ${validationMsg ? `<div class="toast error" style="margin-top:12px;position:static">${escapeHtml(validationMsg)}</div>` : ''}
      ${currentTeam.retentionConfirmed ? `
        <div class="retention-confirmed-banner">
          <div class="ret-conf-badge">✓ FRANCHISE RETENTIONS CONFIRMED & LOCKED</div>
          <div class="ret-conf-msg">
            <strong>${escapeHtml(currentTeam.name)}</strong> has locked ${draftList.length} retention(s) for <strong>${fmtCr(currentTeam.retentionCostCr)}</strong>.
            Starting purse: ${fmtCr(currentTeam.startingPurseCr)} · Remaining auction purse: <strong>${fmtCr(currentTeam.purseCr)}</strong> · RTM cards available: <strong>${currentTeam.rtmCount}</strong>.
          </div>
          <div class="ret-conf-progression">
            <strong>Franchise Readiness:</strong> ${confirmedCount} / 10 franchises confirmed.
            ${confirmedCount < 10 ? `Waiting for remaining franchise owners (${escapeHtml(unconfirmedList)}). The host will finalize and open the auction floor once ready.` : `All 10 franchises confirmed! The auction host is now opening the auction floor.`}
          </div>
        </div>
      ` : ''}
    </div>

    ${teamTabs ? `<div class="retention-team-nav">${teamTabs}</div>` : ''}

    <div class="retention-filter-bar">
      <span class="filter-label">Filter roster:</span>
      <button type="button" class="ret-filter-btn ${filter === 'all' ? 'active' : ''}" data-ret-filter="all">All Candidates (${squad.length})</button>
      <button type="button" class="ret-filter-btn ${filter === 'batter' ? 'active' : ''}" data-ret-filter="batter">Batters</button>
      <button type="button" class="ret-filter-btn ${filter === 'bowler' ? 'active' : ''}" data-ret-filter="bowler">Bowlers</button>
      <button type="button" class="ret-filter-btn ${filter === 'allrounder' ? 'active' : ''}" data-ret-filter="allrounder">All-Rounders</button>
      <button type="button" class="ret-filter-btn ${filter === 'keeper' ? 'active' : ''}" data-ret-filter="keeper">Wicketkeepers</button>
      <button type="button" class="ret-filter-btn ${filter === 'retained' ? 'active' : ''}" data-ret-filter="retained">Selected (${draftList.length})</button>
    </div>

    <div class="retention-roster-grid">${rosterCards}</div>

    <div class="retention-actions-bar">
      <div class="retention-actions-left">
        <div><strong>${escapeHtml(currentTeam.name)}</strong> · ${draftList.length} selected (${fmtCr(totalCostCr)})</div>
        ${canControl ? `
          <button type="button" class="btn btn-primary btn-lg" data-action="confirm-retention" ${isInvalid ? 'disabled' : ''}>Confirm ${escapeHtml(currentTeam.id)} Retentions</button>
          <button type="button" class="btn btn-ghost" data-action="reset-retention">Reset Selections</button>
        ` : isConfirmed ? `
          <span class="pill pill-green">✓ Retentions Confirmed on Server</span>
        ` : `<span class="small-note">Viewing mode · Only ${escapeHtml(currentTeam.id)} owner can edit this roster.</span>`}
      </div>
      <div class="retention-actions-right">
        ${state.isHost ? `<button type="button" class="btn ${canStart ? 'btn-gold' : 'btn-secondary'} btn-lg" data-action="finalize-retentions" ${canStart ? '' : 'disabled'}>Finalize Remaining Teams & Start Auction</button>` : ''}
      </div>
    </div>
  </section>`;
}

function bindRetentionHandlers() {
  const room = state.room;
  if (!room) return;
  const isParticipantMode = room?.retentionMode === 'participants';

  // Global & Host handlers within Retention Phase
  app.querySelectorAll('[data-action="finalize-retentions"]').forEach(btn => btn.addEventListener('click', async () => {
    if (!state.isHost) return;
    const confirmedCount = (state.room?.teams || []).filter(t => t.retentionConfirmed).length;
    if (confirmedCount === 0) {
      toast('At least one franchise must confirm retentions before starting the auction.', 'error');
      return;
    }
    const msg = confirmedCount === 10
      ? 'Start Mega Auction floor with all 10 franchises confirmed?'
      : `Start Mega Auction now? The ${confirmedCount} confirmed franchise(s) will be locked and the remaining ${10 - confirmedCount} franchise(s) will be finalized automatically with 0 retentions.`;
    if (!confirm(msg)) return;
    try {
      btn.disabled = true;
      const res = await api(`/api/room/${encodeURIComponent(state.roomCode)}/action`, {
        method: 'POST',
        body: { action: 'start' }
      });
      acceptRoom(res.room, true);
      toast('Mega Auction started successfully!', 'success');
    } catch (err) {
      toast(err.message, 'error');
      btn.disabled = false;
    }
  }));

  app.querySelectorAll('[data-action="open-close-room"]').forEach(btn => btn.addEventListener('click', e => {
    e.stopPropagation();
    state.showCloseModal = true;
    renderRoom();
  }));
  app.querySelectorAll('[data-action="cancel-close-room"]').forEach(btn => btn.addEventListener('click', e => {
    e.stopPropagation();
    state.showCloseModal = false;
    renderRoom();
  }));
  app.querySelectorAll('[data-action="confirm-close-room"]').forEach(btn => btn.addEventListener('click', async e => {
    e.stopPropagation();
    await handleConfirmCloseRoom();
  }));

  // Claim team buttons from Case 2
  app.querySelectorAll('[data-action="claim-team"]').forEach(btn => btn.addEventListener('click', () => {
    state.joinDraft = { name: '', teamId: btn.dataset.team || '' };
    state.showJoinModal = true;
    renderRoom();
  }));

  // Host team selector tabs
  app.querySelectorAll('[data-action="select-ret-team"]').forEach(btn => btn.addEventListener('click', () => {
    state.selectedRetentionTeam = btn.dataset.team;
    renderRoom();
  }));

  // Active Team Roster Drafting Handlers (Case 3)
  const activeTeamId = isParticipantMode
    ? state.participant?.teamId
    : (state.selectedRetentionTeam || room.teams[0]?.id || 'CSK');

  if (!activeTeamId) return;

  const currentTeam = room.teams.find(t => t.id === activeTeamId) || room.teams[0];
  const isConfirmed = Boolean(currentTeam.retentionConfirmed);

  if (!state.retentionDraft[activeTeamId]) {
    state.retentionDraft[activeTeamId] = currentTeam.retentions
      ? currentTeam.retentions.map(r => ({ name: r.name, type: r.type || 'capped' }))
      : [];
  }
  const draftList = state.retentionDraft[activeTeamId];

  const canControl = isParticipantMode
    ? Boolean(state.participant && state.participant.teamId === activeTeamId && !isConfirmed)
    : Boolean(state.isHost && !isConfirmed);

  // Filter handlers
  app.querySelectorAll('[data-ret-filter]').forEach(btn => btn.addEventListener('click', () => {
    state.retentionFilter = btn.dataset.retFilter;
    renderRoom();
  }));

  // Helper function to toggle retention with limit validation
  function toggleRetain(playerName, isUncappedDefault) {
    if (!canControl) {
      if (isConfirmed) {
        toast('Retentions for this franchise are already confirmed and locked.', 'info');
      }
      return;
    }

    const norm = (playerName || '').toLowerCase().trim();
    const existingIdx = draftList.findIndex(x => (x.name || '').toLowerCase().trim() === norm);
    if (existingIdx >= 0) {
      draftList.splice(existingIdx, 1);
      renderRoom();
      return;
    }

    // Checking limits before adding
    let cappedCount = 0;
    let uncappedCount = 0;
    let totalCostCr = 0;
    for (const item of draftList) {
      if (item.type === 'capped') {
        if (cappedCount < RETENTION_SLABS_CR.length) totalCostCr += RETENTION_SLABS_CR[cappedCount];
        cappedCount++;
      } else {
        totalCostCr += UNCAPPED_COST_CR;
        uncappedCount++;
      }
    }

    if (cappedCount + uncappedCount >= 6) {
      toast('Maximum 6 combined direct retentions and RTM cards allowed.', 'error');
      return;
    }

    const type = isUncappedDefault ? 'uncapped' : 'capped';
    if (type === 'capped') {
      if (cappedCount >= 5) {
        toast('Maximum 5 capped players allowed under retention rules.', 'error');
        return;
      }
      const nextCost = RETENTION_SLABS_CR[cappedCount] || 18;
      if (totalCostCr + nextCost > currentTeam.startingPurseCr) {
        toast(`Retention cost would exceed franchise starting purse of ₹${currentTeam.startingPurseCr} Cr.`, 'error');
        return;
      }
    } else {
      if (uncappedCount >= 2) {
        toast('Maximum 2 uncapped players allowed under retention rules.', 'error');
        return;
      }
      if (totalCostCr + UNCAPPED_COST_CR > currentTeam.startingPurseCr) {
        toast(`Retention cost would exceed franchise starting purse of ₹${currentTeam.startingPurseCr} Cr.`, 'error');
        return;
      }
    }

    draftList.push({ name: playerName, type });
    renderRoom();
  }

  // Toggle retention button and checkbox clicks
  app.querySelectorAll('[data-action="toggle-retain"]').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation();
      const playerName = el.dataset.player;
      const isUncapped = el.dataset.uncapped === 'true';
      toggleRetain(playerName, isUncapped);
    });
  });

  // Clicking anywhere on player card
  app.querySelectorAll('.retention-player-card').forEach(card => {
    card.addEventListener('click', e => {
      if (e.target.closest('select') || e.target.closest('button') || e.target.closest('input')) return;
      const playerName = card.dataset.player;
      const isUncapped = card.dataset.uncapped === 'true';
      toggleRetain(playerName, isUncapped);
    });
  });

  // Category toggle dropdown
  app.querySelectorAll('[data-action="toggle-ret-type"]').forEach(sel => {
    sel.addEventListener('click', e => e.stopPropagation());
    sel.addEventListener('change', e => {
      e.stopPropagation();
      const playerName = sel.dataset.player;
      const item = draftList.find(x => (x.name || '').toLowerCase().trim() === (playerName || '').toLowerCase().trim());
      if (item) {
        item.type = sel.value;
        renderRoom();
      }
    });
  });

  // Confirm retentions
  app.querySelectorAll('[data-action="confirm-retention"]').forEach(btn => btn.addEventListener('click', async () => {
    if (!canControl) return;

    // Frontend validation
    let cappedCount = 0;
    let uncappedCount = 0;
    let totalCostCr = 0;
    for (const item of draftList) {
      if (item.type === 'capped') {
        if (cappedCount < RETENTION_SLABS_CR.length) totalCostCr += RETENTION_SLABS_CR[cappedCount];
        cappedCount++;
      } else {
        totalCostCr += UNCAPPED_COST_CR;
        uncappedCount++;
      }
    }
    const totalCount = cappedCount + uncappedCount;
    if (totalCount > 6) {
      toast('Maximum 6 combined direct retentions and RTM cards allowed.', 'error');
      return;
    }
    if (cappedCount > 5) {
      toast('Maximum 5 capped players allowed.', 'error');
      return;
    }
    if (uncappedCount > 2) {
      toast('Maximum 2 uncapped players allowed.', 'error');
      return;
    }
    if (totalCostCr > currentTeam.startingPurseCr) {
      toast(`Total spend ₹${totalCostCr} Cr exceeds starting purse of ₹${currentTeam.startingPurseCr} Cr.`, 'error');
      return;
    }

    try {
      btn.disabled = true;
      btn.textContent = 'Confirming…';
      const payload = {
        clientId,
        teamId: activeTeamId,
        retentions: draftList.map(r => ({ name: r.name, type: r.type }))
      };
      const res = await api(`/api/room/${encodeURIComponent(state.roomCode)}/retention/confirm`, {
        method: 'POST',
        body: payload
      });
      acceptRoom(res.room, true);
      toast(`✓ Retentions confirmed for ${activeTeamId}!`, 'success');
    } catch (err) {
      toast(err.message || 'Confirmation failed.', 'error');
      btn.disabled = false;
      btn.textContent = `Confirm ${activeTeamId} Retentions`;
    }
  }));

  // Reset selections
  app.querySelectorAll('[data-action="reset-retention"]').forEach(btn => btn.addEventListener('click', async () => {
    if (!canControl) return;
    state.retentionDraft[activeTeamId] = [];
    try {
      btn.disabled = true;
      const res = await api(`/api/room/${encodeURIComponent(state.roomCode)}/retention/cancel`, {
        method: 'POST',
        body: { clientId, teamId: activeTeamId }
      });
      acceptRoom(res.room, true);
      toast(`Selections reset for ${activeTeamId}.`, 'success');
    } catch {
      renderRoom();
    }
  }));
}

// -----------------------------------------------------------------------------
// Auction Floor Views
// -----------------------------------------------------------------------------
function renderFloor() {
  const room = state.room;
  const p = room.currentPlayer;
  const liveLot = Boolean(room.status === 'live' && room.lotState === 'bidding');
  const roleText = p ? `${p.nationality || 'Unknown'} · ${p.origin || 'Classification pending'}` : 'The candidate queue is complete.';
  const sold = room.soldCount || 0;
  const processed = room.processedCount || 0;
  const remaining = Math.max(0, candidatesRemaining(room));
  const roundTitle = room.round === 2 ? 'UNSOLD REVISIT' : 'PLAYER AUCTION';
  const avatar = p ? imageFrame(p, 'focus-frame') : `<div class="photo-frame focus-frame no-photo"><span class="photo-placeholder">✓<small>COMPLETE</small></span></div>`;
  const bids = [...(room.currentBidHistory || [])].slice(-5).reverse();
  const bidRows = bids.length ? bids.map(b => `<div class="bid-line"><div class="bid-team-name">${teamBadge(b.teamId)}<span>${escapeHtml(b.bidderName)} · ${escapeHtml(b.teamName)}</span></div><div class="bid-amount">${fmtCr(b.amountCr)}</div></div>`).join('') : `<div class="empty-log">No bids yet. The next valid bid starts at the base price.</div>`;
  const bidCap = room.currentBidTeamId ? `Leading · ${escapeHtml(room.currentBidTeamId)}` : 'Waiting for first bid';

  const celebToggleBtn = state.isHost ? `
    <button type="button" class="btn btn-sm ${room.celebrationAudioEnabled !== false ? 'btn-ghost' : 'btn-danger'}" data-action="toggle-celebration-audio" title="Toggle franchise celebration audio for all participants">
      ${room.celebrationAudioEnabled !== false ? 'Anthem: ON 🔊' : 'Anthem: OFF 🔇'}
    </button>` : `<span class="pill ${room.celebrationAudioEnabled !== false ? '' : 'pill-muted'}" title="Celebration Audio Status">Anthem: ${room.celebrationAudioEnabled !== false ? 'ON 🔊' : 'OFF 🔇'}</span>`;

  return `<div class="room-title-row"><div><div class="kicker">${roundTitle} · ${room.mode.toUpperCase()} MODE</div><h1 class="page-title">THE <em>AUCTION FLOOR</em></h1><div class="page-subtitle">Room ${escapeHtml(room.code)} · ${room.round === 2 ? `Revisit round · ${room.totalInRound} unsold returns` : 'First pass · proposed set order'} · One authoritative server clock</div></div><div class="room-actions">${celebToggleBtn}${!state.participant && !state.isHost ? `<button type="button" class="btn btn-primary" data-action="show-join">Join to bid</button>` : state.participant ? `<span class="pill">${state.participant.teamId ? `${escapeHtml(state.participant.teamId)} OWNER` : 'SPECTATOR'}</span>` : `<span class="pill">OWNER / AUCTIONEER</span>`}</div></div>
    <div class="floor-grid">
      <section class="panel player-focus"><div class="panel-head"><span class="panel-title">Now on the block</span><span class="panel-meta">LOT ${p ? String(processed + 1).padStart(3,'0') : '—'}</span></div>
        <div class="player-card-body">
          <div class="player-photo ${p?.image ? 'has-photo' : ''}">${p ? `<span class="player-rank">${escapeHtml(p.auctionSet || 'PLAYER SET')}</span><span class="tag lime set-badge">${escapeHtml(p.origin || 'Player')}</span>` : ''}${avatar}</div>
          <div class="player-details">${p ? `<div class="panel-meta">${escapeHtml(p.auctionSet || 'Auction candidate')}</div><div class="player-name">${escapeHtml(p.name)}</div><div class="player-subline">${escapeHtml(roleText)}</div><div class="tags"><span class="tag lime">${escapeHtml(p.roleBucket || p.role)}</span><span class="tag">${escapeHtml(p.cappedStatus || 'Capped')}</span>${p.originalTeamId ? `<span class="tag">Previous: ${escapeHtml(p.originalTeamId)}</span>` : ''}</div><div class="price-row"><div><span class="label-uppercase">Base price</span><strong>${fmtCr(p.basePriceCr)}</strong></div><div class="set-number"><span class="label-uppercase">Set order</span><strong>${escapeHtml(p.auctionSet || 'Candidate pool')}</strong></div></div>` : `<div class="player-name">AUCTION COMPLETE</div><p class="page-subtitle">All available candidates have been processed. Check squads and logs.</p>`}</div>
        </div>
      </section>
      <section class="panel bidding-panel"><div class="panel-head"><span class="panel-title">Live bid board</span>${statusPill(room.status)}</div><div class="live-stage"><div class="live-label"><i></i>${(room.celebrationActive || room.lotState === 'celebration') ? 'Celebrating previous sale…' : room.lotDone ? 'Lot settled' : room.status === 'ready' ? 'Floor not open' : room.status === 'paused' ? 'Clock on hold' : 'Current leading bid'}</div><div class="current-bid ${room.currentBidCr == null ? 'empty' : ''}">${room.currentBidCr == null ? fmtCr(p?.basePriceCr) : fmtCr(room.currentBidCr)}</div><div class="bid-caption">${room.currentBidCr == null ? 'Base price · awaiting first bid' : `<b>${bidCap}</b> · ${escapeHtml(room.currentBidderName || '')}`}</div><div class="bid-meta"><div class="meta-block"><small>Sold</small><strong>${sold}</strong></div><div class="meta-block"><small>Processed</small><strong>${processed}</strong></div><div class="meta-block"><small>In queue</small><strong>${remaining}</strong></div><div class="meta-block"><small>Round</small><strong>${room.round} / 2</strong></div></div><div class="timer-row"><div class="timer-ring" id="timer-value">${room.status === 'ready' ? '—' : '10'}</div><div class="timer-copy"><strong>Bid countdown</strong><span id="timer-caption">${room.status === 'ready' ? 'Timer starts when auction opens' : 'Timer resets after each valid bid'}</span><div class="timer-bar"><span id="timer-fill"></span></div></div></div></div>
        <div class="bid-controls">${state.participant?.role === 'teamOwner' ? `<button type="button" class="btn btn-primary bid-main" data-action="bid" ${!canUserBid(room) ? 'disabled' : ''}>${(room.celebrationActive || room.lotState === 'celebration') ? 'VICTORY ANTHEM PLAYING…' : room.currentBidTeamId === state.participant.teamId ? '✓ YOU HOLD THE LEAD' : `RAISE TO ${fmtCr(nextBidAmount(room))} ↗`}</button>` : `<button type="button" class="btn btn-secondary bid-main" data-action="show-join" ${state.isHost ? 'disabled' : ''}>${state.isHost ? 'AUCTIONEER VIEW' : 'JOIN TO PLACE A BID'}</button>`}<button type="button" class="btn btn-secondary" data-action="copy-room" title="Copy room code">⧉</button></div><p class="bid-help">${state.participant?.role === 'teamOwner' ? `Bids rise in fixed increments. You cannot bid against yourself.` : `Share room code ${escapeHtml(room.code)} with franchise owners.`}</p>
        ${state.isHost ? `
        <div class="host-mobile-actions">
          <div class="host-action-trio">
            <button type="button" class="btn btn-sold" data-action="mark-sold" ${!liveLot || room.currentBidCr == null ? 'disabled' : ''}>✓ SOLD</button>
            <button type="button" class="btn btn-unsold" data-action="mark-unsold" ${!liveLot ? 'disabled' : ''}>✕ UNSOLD</button>
            <button type="button" class="btn btn-skip" data-action="next-player" ${!room.lotDone || state.celebration ? 'disabled' : ''}>Skip Player ⏭</button>
          </div>
        </div>` : ''}
        <div class="bid-log"><div class="bid-log-head"><span>Recent bids</span><span>${bids.length} RAISES</span></div>${bidRows}</div>
      </section>
      <section class="panel auction-console"><div class="panel-head"><span class="panel-title">${state.isHost ? 'Auctioneer controls' : 'Franchise controls'}</span><span class="panel-meta">${state.isHost ? 'HOST ONLY' : state.participant?.role === 'teamOwner' ? escapeHtml(state.participant.teamId) : 'VIEW ONLY'}</span></div>${currentOwnerPanel(room)}</section>
    </div>
    <div class="player-stats-strip"><div class="stat-card"><span class="stat-icon">₹</span><div><small>Top bid</small><strong>${room.currentBidCr == null ? '—' : fmtCr(room.currentBidCr)}</strong></div></div><div class="stat-card"><span class="stat-icon">✓</span><div><small>Players sold</small><strong>${sold}</strong></div></div><div class="stat-card"><span class="stat-icon">×</span><div><small>Unsold in round ${room.round}</small><strong>${room.round === 1 ? room.unsoldRound1.length : room.unsoldRound2.length}</strong></div></div><div class="stat-card"><span class="stat-icon">⌁</span><div><small>Participating teams</small><strong>${room.participants.filter(x=>x.teamId).length}/10</strong></div></div></div>
    <section class="team-section"><div class="section-header"><div><h2>Franchise purse board</h2><p>Purses and role composition update immediately after a sale is confirmed.</p></div><button type="button" class="btn btn-ghost btn-sm" data-view="squads">Open full squads →</button></div><div class="team-grid">${room.teams.map(teamCard).join('')}</div></section>`;
}

function candidatesRemaining(room) {
  if (room.status === 'finished') return 0;
  const currentQueue = room.auctionOrder.length - (room.currentIndex == null ? room.auctionOrder.length : room.currentIndex) - (room.lotDone ? 1 : 0);
  return Math.max(0, currentQueue);
}

function canUserBid(room) {
  if (!state.participant || state.participant.role !== 'teamOwner') return false;
  if (room.celebrationActive || room.lotState === 'celebration') return false;
  const team = room.teams.find(t => t.id === state.participant.teamId);
  const p = room.currentPlayer;
  const next = nextBidAmount(room);
  const isLive = room.status === 'live' && room.lotState === 'bidding';
  return Boolean(
    team && p && isLive && !room.lotDone &&
    room.bidEndsAt && Date.now() < room.bidEndsAt &&
    next != null &&
    room.currentBidTeamId !== state.participant.teamId &&
    team.purseCr + 0.001 >= next &&
    team.squad.length < room.maxSquadSize &&
    !(p.origin === 'Overseas' && team.squad.filter(x => x.overseas).length >= room.maxOverseas)
  );
}

function teamCard(team) {
  const pct = team.startingPurseCr > 0 ? Math.max(0, Math.min(100, (team.purseCr / team.startingPurseCr) * 100)) : 0;
  const participant = state.room.participants.find(p => p.teamId === team.id);
  return `<article class="team-card" style="${teamStyle(team)}"><div class="team-card-top">${teamBadge(team.id)}<div class="team-card-name"><strong>${escapeHtml(team.name)}</strong><small>${participant ? `<span class="owner-seat">● ${escapeHtml(participant.name)}</span>` : 'No franchise owner joined'}</small></div></div><div class="team-purse-line"><small>Purse remaining</small><strong>${fmtCr(team.purseCr)}</strong></div><div class="team-mini-bar"><span style="width:${pct}%"></span></div><div class="team-card-bottom"><span>Squad <b>${team.squad.length}/${state.room.maxSquadSize}</b></span><span>Spent <b>${fmtCr(team.spentCr)}</b></span></div><div class="team-card-bottom"><span>B ${team.roleCounts?.Batter || 0} · AR ${team.roleCounts?.['All-rounder'] || 0}</span><span>BW ${team.roleCounts?.Bowler || 0} · WK ${team.roleCounts?.Keeper || 0}</span></div></article>`;
}

function renderPlayersView() {
  if (state.isHost && state.hostPoolMode) {
    return `<div class="room-title-row"><div><div class="kicker">Host Administration</div><h1 class="page-title">PLAYER <em>REGISTRY</em></h1><div class="page-subtitle">Add, edit, exclude or configure candidate pool for IPL 2027.</div></div><div class="room-actions"><button type="button" class="btn btn-secondary" data-action="toggle-pool-manager-view">← Return to Lot Grid</button></div></div>${renderPlayerPoolManager()}`;
  }

  const room = state.room;
  const pool = room.candidatePool || state.bootstrap.candidates;
  const shown = pool.filter(p => {
    if (state.query && !`${p.name} ${p.role} ${p.nationality} ${p.auctionSet}`.toLowerCase().includes(state.query.toLowerCase())) return false;
    if (state.poolSet !== 'all' && p.auctionSet !== state.poolSet) return false;
    if (state.poolRole !== 'all' && p.roleBucket !== state.poolRole) return false;
    const result = room.results[p.id];
    if (state.poolStatus === 'pending' && result) return false;
    if (state.poolStatus === 'sold' && result?.status !== 'sold') return false;
    if (state.poolStatus === 'unsold' && result?.status !== 'unsold') return false;
    return true;
  });
  const options = [...new Set(pool.map(p => p.auctionSet).filter(Boolean))].map(s => `<option value="${escapeHtml(s)}" ${state.poolSet === s ? 'selected' : ''}>${escapeHtml(s)}</option>`).join('');

  return `<div class="room-title-row"><div><div class="kicker">${pool.length} candidate records</div><h1 class="page-title">PLAYER <em>POOL</em></h1><div class="page-subtitle">Available candidates for this auction floor.</div></div><div class="room-actions">${state.isHost ? `<button type="button" class="btn btn-secondary btn-sm" data-action="toggle-pool-manager-view">⚙ Manage Registry</button>` : ''}<span class="pill">${shown.length} MATCHES</span></div></div>
    <section class="table-panel"><div class="table-tools"><input class="input" id="pool-search" placeholder="Search player, role or country…" value="${escapeHtml(state.query)}"/><select class="select" id="pool-role"><option value="all">All roles</option>${['Batter','All-rounder','Bowler','Keeper'].map(r=>`<option ${state.poolRole===r?'selected':''}>${r}</option>`).join('')}</select><select class="select" id="pool-set"><option value="all">All auction sets</option>${options}</select><select class="select" id="pool-status"><option value="all" ${state.poolStatus==='all'?'selected':''}>All statuses</option><option value="pending" ${state.poolStatus==='pending'?'selected':''}>Not processed</option><option value="sold" ${state.poolStatus==='sold'?'selected':''}>Sold</option><option value="unsold" ${state.poolStatus==='unsold'?'selected':''}>Unsold</option></select></div>
      <div class="pool-grid">${shown.map(p => poolCard(p, room.results[p.id])).join('') || `<div class="empty-state" style="grid-column:1/-1"><div class="empty-icon">⌕</div><h3>No players match</h3><p>Try a different name or filter.</p></div>`}</div></section>`;
}

function poolCard(p, result) {
  const status = result?.status || 'pending';
  const statusText = status === 'sold' ? `SOLD · ${result.teamId}` : status === 'unsold' ? 'UNSOLD / revisit' : 'In candidate pool';
  return `<article class="pool-card"><div class="pool-photo">${p.image ? `<img src="${escapeHtml(p.image)}" alt="${escapeHtml(p.name)}" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='grid'"/><div class="photo-fallback" style="display:none">${escapeHtml(initials(p.name))}<small>PLAYER</small></div>` : `<div class="photo-fallback">${escapeHtml(initials(p.name))}<small>PLAYER</small></div>`}</div><div class="pool-info"><h3>${escapeHtml(p.name)}</h3><p>${escapeHtml(p.role)} · ${escapeHtml(p.nationality)}<br/>${escapeHtml(p.auctionSet || 'Candidate set')}</p><div class="tags" style="margin-top:0"><span class="tag lime">${fmtCr(p.basePriceCr)}</span><span class="tag">${escapeHtml(p.cappedStatus || 'Capped')}</span></div><div style="margin-top:8px"><span class="row-status ${status}">${escapeHtml(statusText)}</span></div></div></article>`;
}

function renderSquadsView() {
  const room = state.room;
  return `<div class="room-title-row"><div><div class="kicker">Live team management</div><h1 class="page-title">FRANCHISE <em>SQUADS</em></h1><div class="page-subtitle">Sold and retained players appear here. Purse and squad limits update in real time.</div></div><div class="room-actions"><span class="pill">${room.teams.reduce((s,t)=>s+t.squad.length,0)} SQUAD ENTRIES</span><span class="pill">${room.teams.reduce((s,t)=>s+t.purchases.length,0)} NEW BUYS</span></div></div>
    <div class="squad-team-grid">${room.teams.map(t => squadCard(t, room)).join('')}</div>`;
}

function squadCard(team, room) {
  const pct = team.startingPurseCr > 0 ? Math.min(100, team.purseCr / team.startingPurseCr * 100) : 0;
  const roleCounts = team.roleCounts || { Batter: 0, 'All-rounder': 0, Bowler: 0, Keeper: 0 };
  const rows = team.squad.slice().sort((a, b) => a.name.localeCompare(b.name)).map(p => `<div class="roster-row">${tinyPlayerImage(p)}<div class="roster-name"><strong>${escapeHtml(p.name)}</strong><small>${escapeHtml(p.role || p.roleBucket || 'Player')} · ${p.overseas ? 'Overseas' : 'Domestic'}</small></div><span class="roster-kind">${p.salaryCr != null ? fmtCr(p.salaryCr) : (p.cappedStatus === 'Uncapped' ? 'UNCAPPED' : 'SQUAD')}</span></div>`).join('');
  return `<article class="squad-card" style="${teamStyle(team)}"><div class="squad-card-header"><div class="squad-team-heading">${teamBadge(team.id)}<div><h3>${escapeHtml(team.name)}</h3><p>${team.squad.length} players · ${team.purchases.length} auction buys</p></div></div><div class="squad-money"><strong>${fmtCr(team.purseCr)}</strong><small>Remaining</small></div></div><div class="squad-progress"><span style="width:${pct}%"></span></div><div class="squad-stats"><div class="squad-stat"><strong>${team.squad.length}</strong><small>Squad</small></div><div class="squad-stat"><strong>${team.overseasCount || 0}</strong><small>Overseas</small></div><div class="squad-stat"><strong>${fmtCr(team.spentCr)}</strong><small>Total spend</small></div><div class="squad-stat"><strong>${room.maxSquadSize - team.squad.length}</strong><small>Slots left</small></div></div><div class="squad-role-grid"><span class="squad-role-pill">Batters <b>${roleCounts.Batter || 0}</b></span><span class="squad-role-pill">All-rounders <b>${roleCounts['All-rounder'] || 0}</b></span><span class="squad-role-pill">Bowlers <b>${roleCounts.Bowler || 0}</b></span><span class="squad-role-pill">Keepers <b>${roleCounts.Keeper || 0}</b></span></div><div class="squad-roster-list">${rows || `<div class="empty-state"><h3>No players yet</h3><p>Purchases and retentions appear here.</p></div>`}</div></article>`;
}

function renderHistoryView() {
  const room = state.room;
  const history = (room.auctionHistory || []).slice().reverse();
  const sold = history.filter(x => x.type === 'sold');
  const totalSpend = sold.reduce((s, x) => s + Number(x.priceCr || 0), 0);
  return `<div class="room-title-row"><div><div class="kicker">Auction ledger</div><h1 class="page-title">AUCTION <em>LOG</em></h1><div class="page-subtitle">Every settled lot, winning franchise, final price and timestamp in this room.</div></div><div class="room-actions"><button type="button" class="btn btn-secondary" data-action="export-log">Export log CSV ↓</button></div></div>
    <div class="log-summary"><div class="stat-card"><span class="stat-icon">✓</span><div><small>Sold</small><strong>${sold.length}</strong></div></div><div class="stat-card"><span class="stat-icon">×</span><div><small>Unsold records</small><strong>${history.filter(x=>x.type==='unsold').length}</strong></div></div><div class="stat-card"><span class="stat-icon">₹</span><div><small>Total auction spend</small><strong>${fmtCr(totalSpend)}</strong></div></div><div class="stat-card"><span class="stat-icon">⌁</span><div><small>Active round</small><strong>${room.round}</strong></div></div></div>
    <section class="table-panel"><div class="panel-head"><span class="panel-title">Settled lots</span><span class="panel-meta">${history.length} EVENTS</span></div><div class="table-scroll"><table class="data-table"><thead><tr><th>Player</th><th>Role</th><th>Base price</th><th>Result</th><th>Winner</th><th>Final bid</th><th>Round</th><th>Time</th></tr></thead><tbody>${history.map(item => `<tr><td><div class="table-player">${tinyPlayerImage({image:item.image,name:item.playerName})}<div><strong>${escapeHtml(item.playerName)}</strong><small>${escapeHtml(item.nationality || '')}</small></div></div></td><td>${escapeHtml(item.role || '—')}</td><td>${fmtCr(item.basePriceCr)}</td><td><span class="row-status ${item.type==='sold'?'sold':'unsold'}">${item.type==='sold'?'SOLD':'UNSOLD'}</span></td><td>${item.teamId ? `${teamBadge(item.teamId)} ${escapeHtml(item.teamName)}` : '—'}</td><td>${item.priceCr == null?'—':fmtCr(item.priceCr)}</td><td>${item.round}</td><td>${new Date(item.at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</td></tr>`).join('') || `<tr><td colspan="8"><div class="empty-state"><div class="empty-icon">▤</div><h3>No settled lots yet</h3><p>Results appear once lots are marked SOLD or UNSOLD.</p></div></td></tr>`}</tbody></table></div></section>`;
}

function renderAudioModal() {
  return `<div class="join-veil" id="audio-veil">
    <div class="modal-card audio-modal-card" style="width:min(100%,940px);max-height:90vh;overflow-y:auto">
      <div class="modal-head">
        <div>
          <div class="kicker">Victory Anthem Settings</div>
          <h2>Franchise Audio Manager</h2>
          <p class="sub">Configure victory anthems for all 10 franchises during live auction. Defaults remain permanent.</p>
        </div>
        <button type="button" class="close-x" data-action="close-audio">×</button>
      </div>
      ${renderFranchiseAudioList(true)}
    </div>
  </div>`;
}

function renderRoom() {
  if (!state.room) return renderHome();

  const isRetentionPhase = state.room.mode === 'mega' && state.room.status === 'retention';
  const viewMarkup = isRetentionPhase
    ? renderRetentionView()
    : state.view === 'players' ? renderPlayersView()
    : state.view === 'squads' ? renderSquadsView()
    : state.view === 'history' ? renderHistoryView()
    : renderFloor();

  const participant = state.participant;
  const participantLabel = state.isHost ? 'HOST' : participant ? participant.teamId ? `${participant.teamId} OWNER` : 'SPECTATOR' : 'VIEW ONLY';

  app.innerHTML = `${headerMarkup(true)}<main class="room-layout">
    <div class="room-context-row"><div><div class="kicker">${escapeHtml(participantLabel)} · ${escapeHtml(state.room.mode.toUpperCase())} AUCTION · ROOM ${escapeHtml(state.room.code)}</div><div class="context-status">${statusPill(state.room.status)} <span>${state.room.teams.filter(t=>state.room.participants.some(p=>p.teamId===t.id)).length}/10 franchises claimed</span></div></div><div class="room-actions">${!participant && !state.isHost ? `<button type="button" class="btn btn-primary" data-action="show-join">Join as a franchise ↗</button>` : participant ? `<button type="button" class="btn btn-ghost" data-action="leave-seat">Leave seat</button>` : ''}${state.isHost ? `<button type="button" class="btn btn-secondary" data-action="open-audio">♫ Team audio</button><button type="button" class="btn btn-danger btn-sm" data-action="open-close-room">Close Room</button>` : ''}<button type="button" class="btn btn-ghost" data-action="copy-room">Share ${escapeHtml(state.room.code)} ⧉</button></div></div>
    ${!isRetentionPhase ? `<nav class="nav-tabs"><button type="button" class="nav-tab ${state.view==='floor'?'active':''}" data-view="floor">Auction floor</button><button type="button" class="nav-tab ${state.view==='players'?'active':''}" data-view="players">Player pool <span style="opacity:.65">${state.room.auctionOrder.length}</span></button><button type="button" class="nav-tab ${state.view==='squads'?'active':''}" data-view="squads">Franchise squads</button><button type="button" class="nav-tab ${state.view==='history'?'active':''}" data-view="history">Auction log</button></nav>` : ''}
    ${viewMarkup}
    <div class="footer-note" style="padding-left:0;padding-right:0">${escapeHtml(state.room.ruleNote || '')} · Fan-made IPL 2027 Simulator.</div>
  </main>
  ${state.showJoinModal ? renderJoinModal() : ''}${state.modalType === 'audio' && state.isHost ? renderAudioModal() : ''}${state.showCloseModal ? renderCloseModal() : ''}`;

  bindRoomHandlers();
  if (isRetentionPhase) bindRetentionHandlers();
  updateTimerText();
  if (state.showJoinModal) bindJoinModal();
  syncCelebrationModal();
}

function bindRoomHandlers() {
  app.querySelectorAll('[data-view]').forEach(btn => btn.addEventListener('click', () => {
    state.view = btn.dataset.view;
    renderRoom();
  }));

  // Volume slider and mute toggle
  const volSlider = document.querySelector('.volume-slider');
  if (volSlider) {
    volSlider.addEventListener('input', e => {
      const val = Number(e.target.value);
      state.audioVolume = val;
      state.muteAudio = val === 0;
      store.setItem('ipl27-volume', String(val));
      store.setItem('ipl27-mute', String(state.muteAudio));
      if (state.currentAudio) state.currentAudio.volume = val;
    });
  }

  app.querySelectorAll('[data-action="toggle-mute"]').forEach(btn => btn.addEventListener('click', () => {
    state.muteAudio = !state.muteAudio;
    store.setItem('ipl27-mute', String(state.muteAudio));
    if (state.currentAudio) state.currentAudio.volume = state.muteAudio ? 0 : state.audioVolume;
    renderRoom();
  }));

  app.querySelectorAll('[data-action]').forEach(btn => btn.addEventListener('click', async e => {
    const action = btn.dataset.action;
    try {
      if (action === 'home') { e.preventDefault(); return goHome(); }
      if (action === 'unlock-audio') { unlockAudioEngine(); return; }
      if (action === 'toggle-pool-manager-view') { state.hostPoolMode = !state.hostPoolMode; renderRoom(); return; }
      if (action === 'show-join') { state.joinDraft = { name: '', teamId: '' }; state.showJoinModal = true; renderRoom(); return; }
      if (action === 'close-join') { state.joinDraft = { name: '', teamId: '' }; state.showJoinModal = false; renderRoom(); return; }
      if (action === 'copy-room') { await copyText(`${window.location.origin}/?room=${state.roomCode}`); toast('Room link copied.', 'success'); return; }
      if (action === 'close-audio') { state.modalType = null; renderRoom(); return; }
      if (action === 'open-audio') { state.modalType = 'audio'; renderRoom(); return; }
      if (action === 'select-mode') { state.selectedMode = btn.dataset.mode; renderHome(); return; }
      if (action === 'leave-seat') { await leaveSeat(); return; }
      if (action === 'toggle-celebration-audio') {
        if (!state.isHost) return;
        const newEnabled = state.room.celebrationAudioEnabled === false ? true : false;
        await hostAction('set-audio-enabled', { enabled: newEnabled });
        toast(`Franchise celebration audio turned ${newEnabled ? 'ON' : 'OFF'}.`, 'success');
        return;
      }
      if (action === 'preview-audio') { await previewAudio(btn.dataset.team, btn.dataset.url); return; }
      if (action === 'upload-audio') { await uploadAudio(btn.dataset.team); return; }
      if (action === 'test-audio') { testAudio(btn.dataset.url); return; }
      if (action === 'clear-audio' || action === 'restore-default-audio') { await restoreDefaultAudio(btn.dataset.team); return; }
      if (action === 'export-log') { return exportLog(); }
      if (action === 'start-auction') { await hostAction('start'); toast('Auction floor is live.', 'success'); return; }
      if (action === 'pause-auction') { await hostAction('pause'); toast('Auction paused.', 'success'); return; }
      if (action === 'resume-auction') { await hostAction('resume'); toast('Auction resumed.', 'success'); return; }
      if (action === 'mark-sold') { await hostAction('sold'); return; }
      if (action === 'mark-unsold') { await hostAction('unsold'); return; }
      if (action === 'rtm-match') { await hostAction('rtm-match'); return; }
      if (action === 'skip-celebration') {
        if (!state.isHost) return;
        const celebrationId = state.celebration?.celebrationId || state.celebration?.id || state.room?.lastEvent?.celebrationId;
        stopCurrentAudio();
        state.celebration = null;
        if (state.celebrationTimeout) { clearTimeout(state.celebrationTimeout); state.celebrationTimeout = null; }
        dismissCelebrationUI();
        const result = await api(`/api/room/${encodeURIComponent(state.roomCode)}/action`, {
          method: 'POST',
          body: { action: 'skip-celebration', celebrationId }
        });
        acceptRoom(result.room, false);
        toast('Celebration skipped.', 'success');
        return;
      }
      if (action === 'next-player' || action === 'skip-player') {
        if (state.celebration) state.celebration = null;
        stopCurrentAudio();
        await hostAction('next');
        return;
      }
      if (action === 'close-room' || action === 'open-close-room') {
        state.showCloseModal = true;
        renderRoom();
        return;
      }
      if (action === 'bid') { await placeBid(); return; }
    } catch (err) { toast(err.message, 'error'); }
  }));

  app.querySelectorAll('[data-action="open-close-room"]').forEach(btn => btn.addEventListener('click', e => {
    e.stopPropagation();
    state.showCloseModal = true;
    renderRoom();
  }));
  app.querySelectorAll('[data-action="cancel-close-room"]').forEach(btn => btn.addEventListener('click', e => {
    e.stopPropagation();
    state.showCloseModal = false;
    renderRoom();
  }));
  app.querySelectorAll('[data-action="confirm-close-room"]').forEach(btn => btn.addEventListener('click', async e => {
    e.stopPropagation();
    await handleConfirmCloseRoom();
  }));

  const priceForm = document.getElementById('base-price-form');
  if (priceForm) {
    priceForm.addEventListener('submit', async e => {
      e.preventDefault();
      const val = Number(new FormData(priceForm).get('priceCr'));
      try {
        await hostAction('set-base-price', { priceCr: val });
        toast('Base price updated for this room.', 'success');
      } catch (err) { toast(err.message, 'error'); }
    });
  }

  const search = document.getElementById('pool-search');
  if (search) {
    search.addEventListener('input', () => {
      state.query = search.value;
      const pos = search.selectionStart;
      renderRoom();
      const x = document.getElementById('pool-search');
      x?.focus();
      x?.setSelectionRange(pos, pos);
    });
  }

  const role = document.getElementById('pool-role');
  if (role) role.addEventListener('change', () => { state.poolRole = role.value; renderRoom(); });
  const set = document.getElementById('pool-set');
  if (set) set.addEventListener('change', () => { state.poolSet = set.value; renderRoom(); });
  const status = document.getElementById('pool-status');
  if (status) status.addEventListener('change', () => { state.poolStatus = status.value; renderRoom(); });

  if (state.modalType === 'audio') bindAudioInputs();
}

function bindAudioInputs() {
  const veil = document.getElementById('audio-veil');
  if (veil) veil.addEventListener('click', e => { if (e.target === veil) { state.modalType = null; renderRoom(); } });

  document.querySelectorAll('.audio-native-input').forEach(input => {
    input.addEventListener('change', () => {
      const teamId = input.dataset.team;
      const file = input.files?.[0];
      const nameEl = document.getElementById(`selected-file-name-${teamId}`);
      if (nameEl) {
        if (file) {
          const mb = (file.size / (1024 * 1024)).toFixed(2);
          nameEl.textContent = `${file.name} (${mb} MB)`;
          nameEl.classList.add('has-file');
        } else {
          nameEl.textContent = 'Choose new audio file…';
          nameEl.classList.remove('has-file');
        }
      }
    });
  });
}

function stopPreviewAudio() {
  if (state.previewAudio) {
    try {
      state.previewAudio.pause();
      state.previewAudio.currentTime = 0;
    } catch {}
    state.previewAudio = null;
  }
  state.previewTeamId = null;
  updatePreviewButtons();
}

function updatePreviewButtons() {
  document.querySelectorAll('[data-action="preview-audio"]').forEach(btn => {
    const isPlaying = btn.dataset.team === state.previewTeamId;
    btn.innerHTML = isPlaying ? '■ Stop' : '▶ Preview';
    btn.classList.toggle('playing', isPlaying);
  });
}

async function previewAudio(teamId, fallbackUrl) {
  if (state.previewTeamId === teamId) {
    stopPreviewAudio();
    return;
  }
  stopPreviewAudio();

  const fileInput = document.getElementById(`audio-file-${teamId}`);
  const file = fileInput?.files?.[0];
  let src = fallbackUrl;
  if (file) {
    src = URL.createObjectURL(file);
  } else if (!src) {
    const audioMap = state.room?.teamAudio || state.bootstrap?.audio || {};
    src = audioMap[teamId] || `/audio/${teamId.toLowerCase()}-hook.mp3`;
  }

  const audio = new Audio(src);
  audio.volume = state.muteAudio ? 0 : (state.audioVolume ?? 1);
  state.previewAudio = audio;
  state.previewTeamId = teamId;
  updatePreviewButtons();

  audio.onended = () => {
    stopPreviewAudio();
  };
  audio.onerror = () => {
    toast(`Could not play audio preview for ${teamId}.`, 'error');
    stopPreviewAudio();
  };

  try {
    await audio.play();
  } catch (err) {
    if (err.name === 'NotAllowedError') {
      toast('Click "Enable Auction Audio" in topbar or interact with page to allow audio playback.', 'error');
    } else {
      toast(`Preview playback failed: ${err.message}`, 'error');
    }
    stopPreviewAudio();
  }
}

async function hostAction(action, extra = {}) {
  if (!state.roomCode) throw new Error('No active room.');
  const result = await api(`/api/room/${encodeURIComponent(state.roomCode)}/action`, { method: 'POST', body: { action, ...extra } });
  if (result.closed) return result;
  acceptRoom(result.room, false);
  return result;
}

async function placeBid() {
  if (!state.participant) throw new Error('Join a franchise before bidding.');
  if (state.inFlightAction) return;

  // Priority 2: Immediate local visual feedback on click without artificial delays
  const bidButtons = document.querySelectorAll('.bid-main, button[data-action="bid"]');
  const originalHtmlMap = new Map();
  bidButtons.forEach(btn => {
    originalHtmlMap.set(btn, btn.innerHTML);
    btn.classList.add('bid-submitting');
    btn.disabled = true;
    btn.innerHTML = '<span class="bid-spinner"></span> SUBMITTING BID…';
  });

  state.inFlightAction = true;
  const bidRequestId = 'bid_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9);
  const clientSentAt = performance.now();

  try {
    const nextAmount = nextBidAmount(state.room);
    const result = await api(`/api/room/${encodeURIComponent(state.roomCode)}/bid`, {
      method: 'POST',
      body: {
        clientId,
        amountCr: nextAmount,
        bidRequestId,
        clientSentAt
      }
    });

    const rtt = performance.now() - clientSentAt;
    console.log(`[BID LATENCY] Click-to-ack RTT: ${rtt.toFixed(1)}ms | Server duration: ${result.timing?.serverDurationMs ?? '?'}ms | Wait queue: ${result.timing?.waitQueueMs ?? '?'}ms`);

    bidButtons.forEach(btn => {
      btn.classList.remove('bid-submitting');
      btn.classList.add('bid-accepted');
      btn.innerHTML = '✓ BID ACCEPTED!';
    });

    acceptRoom(result.room, false);

    setTimeout(() => {
      bidButtons.forEach(btn => {
        btn.classList.remove('bid-accepted');
      });
      if (state.room) fastUpdateBidStage(state.room);
    }, 350);

  } catch (err) {
    bidButtons.forEach(btn => {
      btn.classList.remove('bid-submitting', 'bid-accepted');
      const orig = originalHtmlMap.get(btn);
      if (orig) btn.innerHTML = orig;
      btn.disabled = false;
    });
    if (state.room) fastUpdateBidStage(state.room);
    toast(err.message, 'error');
  } finally {
    state.inFlightAction = false;
  }
}

async function leaveSeat() {
  if (!state.participant) { state.showJoinModal = true; renderRoom(); return; }
  try {
    await api(`/api/room/${encodeURIComponent(state.roomCode)}/leave`, { method: 'POST', body: { clientId } });
  } catch {}
  state.participant = null;
  store.removeItem('ipl27-participant');
  state.showJoinModal = true;
  renderRoom();
  toast('Your seat has been released.', 'success');
}

async function uploadAudio(teamId) {
  const fileInput = document.getElementById(`audio-file-${teamId}`);
  const file = fileInput?.files?.[0];
  if (!file) {
    toast(`Please choose an audio file for ${teamId} first.`, 'error');
    return;
  }
  if (file.size > 8 * 1024 * 1024) {
    toast('Audio files must be 8 MB or smaller.', 'error');
    return;
  }

  const ext = file.name.split('.').pop().toLowerCase();
  const allowed = ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac', 'webm'];
  if (!allowed.includes(ext)) {
    toast(`Unsupported audio format ".${ext}". Supported: ${allowed.join(', ')}`, 'error');
    return;
  }

  const statusEl = document.getElementById(`audio-status-${teamId}`);
  const uploadBtn = document.querySelector(`[data-action="upload-audio"][data-team="${teamId}"]`);
  if (uploadBtn) { uploadBtn.disabled = true; uploadBtn.textContent = 'Uploading…'; }
  if (statusEl) { statusEl.innerHTML = '<span class="status-uploading"><span class="audio-spinner"></span> Validating & uploading file…</span>'; }

  try {
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('Failed to read file from disk.'));
      reader.readAsDataURL(file);
    });

    const result = await api('/api/host/audio', {
      method: 'POST',
      body: {
        teamId,
        fileName: file.name,
        mimeType: file.type || 'audio/mpeg',
        dataBase64: dataUrl
      }
    });

    if (!result.ok) throw new Error(result.error || 'Server rejected audio upload.');

    if (!state.bootstrap.audio) state.bootstrap.audio = {};
    state.bootstrap.audio[teamId] = result.audioUrl;
    if (!state.bootstrap.teamAudioMetadata) state.bootstrap.teamAudioMetadata = {};
    state.bootstrap.teamAudioMetadata[teamId] = {
      teamId,
      fileName: result.fileName || file.name,
      durationSec: result.durationSec,
      isDefault: false,
      url: result.audioUrl,
      status: 'Ready'
    };

    if (state.room) {
      if (!state.room.teamAudio) state.room.teamAudio = {};
      state.room.teamAudio[teamId] = result.audioUrl;
      if (!state.room.teamAudioMetadata) state.room.teamAudioMetadata = {};
      state.room.teamAudioMetadata[teamId] = state.bootstrap.teamAudioMetadata[teamId];
    }

    preloadTeamAudio({ [teamId]: result.audioUrl });
    toast(`✓ ${teamId} anthem updated (${result.durationSec ? result.durationSec.toFixed(1) + 's' : 'verified'}).`, 'success');

    if (state.modalType === 'audio') {
      renderRoom();
    } else if (state.hostTab === 'audio') {
      renderHome();
    }
  } catch (err) {
    if (statusEl) { statusEl.innerHTML = `<span class="status-error">✕ ${escapeHtml(err.message)}</span>`; }
    toast(err.message, 'error');
  } finally {
    if (uploadBtn) { uploadBtn.disabled = false; uploadBtn.textContent = 'Upload & Save'; }
  }
}

async function restoreDefaultAudio(teamId) {
  try {
    const result = await api('/api/host/audio', {
      method: 'POST',
      body: { teamId, clear: true, restoreDefault: true }
    });

    if (!result.ok) throw new Error(result.error || 'Could not restore default audio.');

    if (!state.bootstrap.audio) state.bootstrap.audio = {};
    state.bootstrap.audio[teamId] = result.audioUrl;
    if (!state.bootstrap.teamAudioMetadata) state.bootstrap.teamAudioMetadata = {};
    state.bootstrap.teamAudioMetadata[teamId] = {
      teamId,
      fileName: result.fileName,
      durationSec: result.durationSec,
      isDefault: true,
      url: result.audioUrl,
      status: 'Default'
    };

    if (state.room) {
      if (!state.room.teamAudio) state.room.teamAudio = {};
      state.room.teamAudio[teamId] = result.audioUrl;
      if (!state.room.teamAudioMetadata) state.room.teamAudioMetadata = {};
      state.room.teamAudioMetadata[teamId] = state.bootstrap.teamAudioMetadata[teamId];
    }

    preloadTeamAudio({ [teamId]: result.audioUrl });
    toast(`✓ Restored default anthem for ${teamId}.`, 'success');

    if (state.modalType === 'audio') {
      renderRoom();
    } else if (state.hostTab === 'audio') {
      renderHome();
    }
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function clearAudio(teamId) {
  await restoreDefaultAudio(teamId);
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const t = document.createElement('textarea');
    t.value = text;
    document.body.appendChild(t);
    t.select();
    document.execCommand('copy');
    t.remove();
  }
}

function exportLog() {
  const room = state.room;
  const headers = ['Player', 'Role', 'Nationality', 'Result', 'Franchise', 'Base Price Cr', 'Final Price Cr', 'Round', 'Timestamp'];
  const rows = (room.auctionHistory || []).map(x => [x.playerName, x.role, x.nationality, x.type, x.teamName || '', x.basePriceCr, x.priceCr ?? '', x.round, x.at]);
  const csv = [headers, ...rows].map(row => row.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `ipl27-auction-${room.code}-log.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function goHome() {
  stopCurrentAudio();
  dismissCelebrationUI();
  state.celebration = null;
  state.activeCelebrationId = null;
  if (state.participant && state.roomCode) {
    try { await api(`/api/room/${state.roomCode}/leave`, { method: 'POST', body: { clientId } }); } catch {}
  }
  stopPolling();
  state.room = null;
  state.roomCode = null;
  state.participant = null;
  state.isHost = false;
  state.showJoinModal = false;
  state.modalType = null;
  state.celebration = null;
  store.removeItem('ipl27-participant');
  setUrlRoom(null);
  renderHome();
}


async function init() {
  try {
    state.bootstrap = await api('/api/bootstrap');
    preloadTeamAudio(state.bootstrap?.audio);

    if (state.ownerToken) {
      try {
        const current = await api('/api/host/current');
        if (current && current.room) {
          state.activeRoomData = current;
          state.ownerReady = true;

          const urlRoom = new URLSearchParams(window.location.search).get('room')?.toUpperCase();
          const lastOwnerRoom = store.getItem('ipl27-owner-room');

          if (urlRoom === current.room.code || lastOwnerRoom === current.room.code) {
            state.isHost = true;
            state.ownerReady = false;
            state.roomCode = current.room.code;
            state.participant = null;
            state.view = current.room.status === 'retention' ? 'retention' : 'floor';
            state.lastVersion = null;
            state.lastEventId = current.room.lastEvent?.id || null;
            store.removeItem('ipl27-participant');
            setUrlRoom(state.roomCode);
            try {
              acceptRoom(current.room, true);
            } catch (renderErr) {
              console.error('[HOST RESTORE RENDER ERROR]', renderErr);
              toast(renderErr.message || 'Render error on room resume', 'error');
            }
            startPolling();
            return;
          }
          state.homePanel = 'host';
        } else {
          state.activeRoomData = null;
          state.ownerReady = true;
        }
      } catch (err) {
        if (err.message && /401|Owner login required/i.test(err.message)) {
          state.ownerToken = null;
          state.activeRoomData = null;
          store.removeItem('ipl27-owner-token');
        } else {
          console.warn('[HOST RECOVERY ERROR]', err);
        }
      }
    }

    // Guard: If host session is active, do not fall through to participant join
    if (state.isHost && state.room) return;

    // Restore participant session
    const urlCode = new URLSearchParams(window.location.search).get('room')?.toUpperCase() || null;
    try {
      const saved = store.getItem('ipl27-participant');
      if (saved) {
        const data = JSON.parse(saved);
        const age = Date.now() - (data.timestamp || 0);
        const targetRoom = urlCode || data.roomCode;
        if (age < 4 * 60 * 60 * 1000 && targetRoom && targetRoom === data.roomCode) {
          const roomState = await api(`/api/room/${data.roomCode}/state`);
          if (roomState?.room) {
            let participant = (roomState.room.participants || []).find(p => p.clientId === clientId);
            if (!participant && data.participant) {
              try {
                const rejoined = await api(`/api/room/${data.roomCode}/join`, {
                  method: 'POST',
                  body: { clientId, name: data.participant.name, teamId: data.participant.teamId || null }
                });
                participant = rejoined.participant;
                roomState.room = rejoined.room;
              } catch (rejoinErr) {
                console.warn('[SESSION] Auto-rejoin failed:', rejoinErr.message);
              }
            }
            if (participant) {
              state.roomCode = data.roomCode;
              state.participant = participant;
              state.isHost = false;
              state.lastVersion = null;
              state.lastEventId = roomState.room.lastEvent?.id || null;
              setUrlRoom(state.roomCode);
              acceptRoom(roomState.room, true);
              startPolling();
              return;
            }
          }
        } else if (age >= 4 * 60 * 60 * 1000) {
          store.removeItem('ipl27-participant');
        }
      }
    } catch {
      store.removeItem('ipl27-participant');
    }

    const code = new URLSearchParams(window.location.search).get('room');
    if (code) { await openJoin(code.toUpperCase()); return; }
    renderHome();
  } catch (err) {
    app.innerHTML = `${headerMarkup(false)}<main class="landing-inner"><div class="form-card"><h2>Could not load auction database</h2><p class="sub">${escapeHtml(err.message)}</p><button type="button" class="btn btn-primary" onclick="location.reload()">Try again</button></div></main>`;
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('click', () => {
    if (!state.audioUnlocked) {
      state.audioUnlocked = true;
      try {
        store.setItem('ipl27-audio-unlocked', 'true');
        sessionStorage.setItem('ipl27-audio-unlocked', 'true');
      } catch {}
      const unlockPill = document.querySelector('.btn-audio-enable');
      if (unlockPill) unlockPill.remove();
    }
  }, { capture: true, passive: true });
}

init();
