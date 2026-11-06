'use strict';

const http = require('node:http');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3333';
const ROOT = path.resolve(__dirname, '..');

function request(urlPath, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, BASE_URL);
    const headers = options.headers || {};
    if (options.body && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }

    const req = http.request(url, {
      method: options.method || 'GET',
      headers
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, data, json });
      });
    });

    req.on('error', reject);
    if (options.body) {
      req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    }
    req.end();
  });
}

async function closeActiveRooms() {
  try {
    await request('/api/host/close-room', { method: 'POST' });
  } catch {}
}

async function runTests() {
  console.log('================================================================');
  console.log('RUNNING SUITE: Audio, Celebration, Popper & Participant Controls');
  console.log('================================================================\n');

  await closeActiveRooms();

  // ---------------------------------------------------------------------------
  // TEST 1: Priority 3 — CSS Layering and Stacking Order
  // ---------------------------------------------------------------------------
  console.log('TEST 1: Verify CSS stacking order (overlay 200, card 205, canvas 210, pointer-events: none)');
  const css = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');
  assert(css.includes('.sale-celebration') && css.includes('z-index: 200') || css.includes('z-index:200'), 'CSS must define .sale-celebration with z-index: 200');
  assert(css.includes('.sale-card') && (css.includes('z-index: 205') || css.includes('z-index:205')), 'CSS must define .sale-card with z-index: 205');
  assert(css.includes('.celebration-confetti-canvas') && (css.includes('z-index: 210') || css.includes('z-index:210')), 'CSS must define .celebration-confetti-canvas with z-index: 210');
  assert(css.includes('pointer-events: none') || css.includes('pointer-events:none'), 'Confetti canvas must have pointer-events: none');
  assert(css.includes('.btn-audio-enable'), 'CSS must include .btn-audio-enable for audio unlock prompt');
  console.log('✓ PASS: CSS stacking order and pointer-events verified.\n');

  // ---------------------------------------------------------------------------
  // TEST 2: Priority 1 & 7 — Host Room Creation & API Permission Enforcement
  // ---------------------------------------------------------------------------
  console.log('TEST 2: Create room as host and test participant authorization enforcement');
  const loginRes = await request('/api/host/login', {
    method: 'POST',
    body: { code: 'ipl2027owner' }
  });
  assert.strictEqual(loginRes.status, 200, 'Host login should succeed');
  const hostToken = loginRes.json.token;
  assert(hostToken, 'Host token must exist');
  const hostCookie = loginRes.headers['set-cookie'] ? loginRes.headers['set-cookie'][0].split(';')[0] : '';

  // Close lingering active room if any
  await request('/api/host/close-room', {
    method: 'POST',
    headers: { 'x-host-token': hostToken }
  });

  const createRes = await request('/api/host/create-room', {
    method: 'POST',
    headers: { 'x-host-token': hostToken },
    body: {
      mode: 'mini',
      timerSeconds: 10,
      purseCr: 120,
      retentionMode: 'host',
      ruleOverrides: { maxSquadSize: 25, maxOverseas: 8 }
    }
  });
  assert.strictEqual(createRes.status, 201, `Failed to create room: ${createRes.data}`);
  const roomCode = createRes.json.room.code;
  console.log(`Created test room ${roomCode} with host session`);

  // Start auction
  const startRes = await request(`/api/room/${roomCode}/action`, {
    method: 'POST',
    headers: { 'x-host-token': hostToken },
    body: { action: 'start' }
  });
  assert.strictEqual(startRes.status, 200, `Failed to start auction: ${startRes.data}`);

  // Join a participant (teamOwner: CSK)
  const joinRes = await request(`/api/room/${roomCode}/join`, {
    method: 'POST',
    body: { name: 'CSK Manager', teamId: 'CSK', clientId: 'test-client-csk' }
  });
  assert.strictEqual(joinRes.status, 200, `Participant join failed: ${joinRes.data}`);

  // Place initial bid as CSK matching base price
  const roomSnap = (await request(`/api/room/${roomCode}/state`)).json.room;
  const baseCr = roomSnap.currentPlayer?.basePriceCr || 1.0;
  const bidRes = await request(`/api/room/${roomCode}/bid`, {
    method: 'POST',
    body: { clientId: 'test-client-csk', amountCr: baseCr }
  });
  assert.strictEqual(bidRes.status, 200, `Bid failed: ${bidRes.data}`);

  // Mark player SOLD as host
  const soldRes = await request(`/api/room/${roomCode}/action`, {
    method: 'POST',
    headers: { 'x-host-token': hostToken },
    body: { action: 'sold' }
  });
  assert.strictEqual(soldRes.status, 200, `Sold action failed: ${soldRes.data}`);
  assert.strictEqual(soldRes.json.room.lotState, 'celebration', 'Room must be in celebration state');
  assert.strictEqual(soldRes.json.room.celebrationActive, true, 'celebrationActive must be true');
  const celebrationId = soldRes.json.room.celebrationId;
  assert(celebrationId, 'celebrationId must be present on room');
  console.log(`✓ PASS: Player marked SOLD; celebrationId = ${celebrationId}`);

  // Test participant trying to skip celebration via API (without host token/cookie)
  console.log('Testing participant bypass rejection (skip-celebration)...');
  const partSkipRes = await request(`/api/room/${roomCode}/action`, {
    method: 'POST',
    body: { action: 'skip-celebration', celebrationId }
  });
  assert.strictEqual(partSkipRes.status, 403, 'Participant must be forbidden (403) from skipping celebration');
  console.log('✓ PASS: Server rejected unauthorized participant skip-celebration with 403.');

  // Test participant trying to end celebration via API (without host token/cookie)
  console.log('Testing participant bypass rejection (end-celebration)...');
  const partEndRes = await request(`/api/room/${roomCode}/action`, {
    method: 'POST',
    body: { action: 'end-celebration', celebrationId }
  });
  assert.strictEqual(partEndRes.status, 403, 'Participant must be forbidden (403) from ending celebration');
  console.log('✓ PASS: Server rejected unauthorized participant end-celebration with 403.\n');

  // ---------------------------------------------------------------------------
  // TEST 3: Priority 4 — Idempotent end-celebration and duplicate calls
  // ---------------------------------------------------------------------------
  console.log('TEST 3: Host skip-celebration and duplicate idempotent call safety');
  const hostSkipRes = await request(`/api/room/${roomCode}/action`, {
    method: 'POST',
    headers: { 'x-host-token': hostToken },
    body: { action: 'skip-celebration', celebrationId }
  });
  assert.strictEqual(hostSkipRes.status, 200, `Host skip-celebration failed: ${hostSkipRes.data}`);
  assert.strictEqual(hostSkipRes.json.room.celebrationActive, false, 'Celebration must be inactive after skip');
  assert.strictEqual(hostSkipRes.json.room.lotState, 'bidding', 'Next lot must be in bidding state');
  console.log('✓ PASS: Host skipped celebration cleanly; next lot started.');

  // Second skip or end call with the same celebrationId should be idempotent and not advance again
  const currentIdx = hostSkipRes.json.room.currentIndex;
  const duplicateRes = await request(`/api/room/${roomCode}/action`, {
    method: 'POST',
    headers: { 'x-host-token': hostToken },
    body: { action: 'end-celebration', celebrationId }
  });
  assert.strictEqual(duplicateRes.status, 200, 'Duplicate end-celebration must return 200');
  assert.strictEqual(duplicateRes.json.room.currentIndex, currentIdx, 'Duplicate call must NOT advance room index again');
  console.log('✓ PASS: Duplicate celebration call handled idempotently with no double-advance.\n');

  // ---------------------------------------------------------------------------
  // TEST 4: Priority 1, 2, 4, 6 — Client VM Simulation (Blinking, Controls, DOM)
  // ---------------------------------------------------------------------------
  console.log('TEST 4: Client VM simulation: Blinking prevention across 25 poll cycles');
  const appJsCode = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');

  // Create lightweight DOM simulation
  class FakeElement {
    constructor(tagName, id = '') {
      this.tagName = tagName.toUpperCase();
      this.id = id;
      this.className = '';
      this.innerHTML = '';
      this.dataset = {};
      this.style = {};
      this.children = [];
      this.eventListeners = {};
    }
    appendChild(child) {
      this.children.push(child);
      return child;
    }
    remove() {
      this.removed = true;
    }
    setAttribute(k, v) { this[k] = v; }
    getAttribute(k) { return this[k]; }
    addEventListener(event, fn) {
      if (!this.eventListeners[event]) this.eventListeners[event] = [];
      this.eventListeners[event].push(fn);
    }
    querySelectorAll() { return []; }
    querySelector() { return null; }
    getContext() {
      return {
        scale: () => {},
        clearRect: () => {},
        save: () => {},
        restore: () => {},
        translate: () => {},
        rotate: () => {},
        fillRect: () => {},
        beginPath: () => {},
        arc: () => {},
        fill: () => {}
      };
    }
    play() {
      return Promise.resolve();
    }
    pause() {}
    removeEventListener() {}
  }

  const appEl = new FakeElement('div', 'app');
  const celebrationRootEl = new FakeElement('div', 'celebration-root');
  const toastRootEl = new FakeElement('div', 'toast-root');
  const elementsById = {
    'app': appEl,
    'celebration-root': celebrationRootEl,
    'toast-root': toastRootEl
  };

  const sandbox = {
    console,
    Date,
    Math,
    Set,
    Array,
    Object,
    String,
    Number,
    Boolean,
    RegExp,
    URL,
    URLSearchParams,
    setTimeout: (fn) => setTimeout(fn, 1),
    clearTimeout: (id) => clearTimeout(id),
    setInterval: () => 1,
    clearInterval: () => {},
    requestAnimationFrame: (fn) => setTimeout(fn, 16),
    cancelAnimationFrame: () => {},
    performance: { now: () => Date.now() },
    document: {
      getElementById: (id) => {
        if (id === 'sale-veil') {
          // If celebration-root has rendered sale-veil, locate it
          if (celebrationRootEl.innerHTML.includes('id="sale-veil"')) {
            const match = celebrationRootEl.innerHTML.match(/data-celebration-id="([^"]+)"/);
            const veil = new FakeElement('div', 'sale-veil');
            if (match) veil.dataset.celebrationId = match[1];
            return veil;
          }
          return null;
        }
        return elementsById[id] || null;
      },
      createElement: (tag) => new FakeElement(tag),
      body: new FakeElement('body'),
      addEventListener: () => {},
      querySelectorAll: () => [],
      querySelector: () => null
    },
    crypto: require('node:crypto'),
    window: {
      innerWidth: 1280,
      innerHeight: 800,
      devicePixelRatio: 1,
      matchMedia: () => ({ matches: false }),
      location: { origin: 'http://localhost:3333', search: '' },
      localStorage: {
        getItem: () => null,
        setItem: () => {},
        removeItem: () => {}
      }
    },
    sessionStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {}
    },
    localStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {}
    },
    Audio: class {
      constructor(src) { this.src = src; }
      play() { return Promise.resolve(); }
      pause() {}
      addEventListener() {}
      removeEventListener() {}
    }
  };

  vm.createContext(sandbox);

  // Load app.js into sandbox and export needed symbols
  const appCodeNoAutoInit = appJsCode.replace(/init\(\);?\s*$/, '') +
    '\n;globalThis.__exported = { state, handleRoomEvent, acceptRoom, headerMarkup, unlockAudioEngine, syncCelebrationModal };';
  vm.runInContext(appCodeNoAutoInit, sandbox);
  const client = sandbox.__exported;

  // Initialize fake state with participant view
  client.state.isHost = false;
  client.state.roomCode = roomCode;
  client.state.audioUnlocked = false;

  // Verify header markup shows one-time audio unlock button for participant
  const headerHtml = client.headerMarkup(true);
  assert(headerHtml.includes('btn-audio-enable'), 'Header markup must render audio unlock button when !state.audioUnlocked');
  assert(headerHtml.includes('Enable auction audio'), 'Audio unlock button must have readable text');
  console.log('✓ PASS: Topbar renders "Enable auction audio" unlock button.');

  // Unlock audio
  client.unlockAudioEngine();
  assert.strictEqual(client.state.audioUnlocked, true, 'Audio must be marked unlocked after unlockAudioEngine');
  const headerAfterHtml = client.headerMarkup(true);
  assert(!headerAfterHtml.includes('btn-audio-enable'), 'Header must hide unlock button once audio is unlocked');
  console.log('✓ PASS: Audio unlock properly toggles and hides prompt.');

  // Simulate a SOLD celebration event arriving
  const testSaleEvent = {
    type: 'sale',
    celebrationId: 'test-cel-12345',
    lotId: 'lot-1',
    playerId: 'p1',
    playerName: 'Virat Kohli',
    teamId: 'RCB',
    teamName: 'Royal Challengers Bengaluru',
    amountCr: 21.0,
    audioUrl: '/audio/rcb.mp3'
  };

  client.handleRoomEvent(testSaleEvent);

  // Verify modal is mounted into celebration-root (NOT into app)
  assert(celebrationRootEl.innerHTML.includes('id="sale-veil"'), 'Celebration modal must be mounted in #celebration-root');
  assert(celebrationRootEl.innerHTML.includes('Virat Kohli'), 'Celebration card must show player name');
  assert(celebrationRootEl.innerHTML.includes('Royal Challengers Bengaluru'), 'Celebration card must show winning team');
  assert(celebrationRootEl.innerHTML.includes('Synchronized with auctioneer'), 'Participant celebration must show sync indicator');
  assert(!celebrationRootEl.innerHTML.includes('Play RCB anthem'), 'Participant view must NOT have manual anthem play button');
  assert(!celebrationRootEl.innerHTML.includes('Skip celebration'), 'Participant view must NOT have skip celebration button');
  console.log('✓ PASS: Participant celebration card has zero manual playback or skip buttons.');

  // BLINKING PREVENTION TEST: Run 25 poll/timer updates while celebration is active
  const initialModalHtml = celebrationRootEl.innerHTML;
  const baseLiveRoom = (await request(`/api/room/${roomCode}/state`)).json.room;
  for (let i = 0; i < 25; i++) {
    // Polling snapshot with active celebration and advancing timestamp
    const pollSnapshot = {
      ...baseLiveRoom,
      celebrationActive: true,
      currentCelebrationId: 'test-cel-12345',
      updatedAt: new Date(Date.now() + i * 1000).toISOString()
    };
    client.acceptRoom(pollSnapshot, false);
    // Modal HTML in #celebration-root must remain completely stable without being wiped or recreated
    assert.strictEqual(celebrationRootEl.innerHTML, initialModalHtml, `Modal was recreated/destroyed on cycle ${i}`);
  }
  console.log('✓ PASS: 25 consecutive poll cycles completed with ZERO modal blinking or DOM destruction.');

  // Clean up
  await closeActiveRooms();
  console.log('\n================================================================');
  console.log('ALL TESTS IN SUITE PASSED SUCCESSFULLY (100%)');
  console.log('================================================================');
}

runTests().then(() => {
  process.exit(0);
}).catch(err => {
  console.error('\n❌ SUITE EXECUTION FAILED:', err);
  process.exit(1);
});
