const http = require('http');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const BASE_URL = 'http://localhost:3333';

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

// Client-side render simulation to test renderFloor() directly in Node
function testClientRenderFloor(room, isHost) {
  // Read app.js code
  const appCode = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

  // Create isolated sandbox context with minimal browser mocks
  const vm = require('vm');
  const domMock = {
    addEventListener: () => {},
    querySelectorAll: () => [],
    getElementById: () => null,
    innerHTML: '',
    style: {}
  };

  const sandbox = {
    document: {
      getElementById: () => domMock,
      createElement: () => domMock,
      body: domMock,
      addEventListener: () => {}
    },
    window: {
      localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
      location: { origin: 'http://localhost:3333', href: 'http://localhost:3333' },
      matchMedia: () => ({ matches: false }),
      addEventListener: () => {}
    },
    crypto: { randomUUID: () => '11111111-2222-3333-4444-555555555555' },
    setTimeout: () => {},
    clearTimeout: () => {},
    requestAnimationFrame: () => {},
    cancelAnimationFrame: () => {},
    performance: { now: () => Date.now() },
    console,
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
  };

  vm.createContext(sandbox);
  // Execute app.js in sandbox
  vm.runInContext(appCode, sandbox);

  // Set up room state in sandbox
  sandbox._tempRoom = room;
  sandbox._tempIsHost = isHost;
  vm.runInContext('state.room = _tempRoom; state.isHost = _tempIsHost; state.roomCode = _tempRoom.code;', sandbox);

  // Call renderFloor() in the sandbox
  let output;
  try {
    output = vm.runInContext('renderFloor()', sandbox);
  } catch (err) {
    throw new Error(`renderFloor crashed: ${err.message}\n${err.stack}`);
  }

  assert(typeof output === 'string', 'renderFloor must return a string');
  assert(output.includes(room.code), 'renderFloor must contain room code');
  return output;
}

async function runTests() {
  console.log('================================================================');
  console.log('TEST SUITE: RESUME EXISTING ROOM & liveLot SCOPE VERIFICATION');
  console.log('================================================================');

  // Authenticate host
  const authRes = await request('/api/host/login', {
    method: 'POST',
    body: { code: 'ipl2027owner' }
  });
  assert.strictEqual(authRes.status, 200);
  const token = authRes.json.token;
  const hostHeaders = { 'x-host-token': token, 'x-owner-token': token };

  // Close any existing active room
  await request('/api/host/close-room', { method: 'POST', headers: hostHeaders });

  // TEST A: Ready Room (created but not yet started)
  console.log('\n>>> TEST A: Ready Room Creation and Host Resume');
  const createReadyRes = await request('/api/host/create-room', {
    method: 'POST',
    headers: hostHeaders,
    body: { mode: 'mini', timerSeconds: 10 }
  });
  assert(createReadyRes.status === 200 || createReadyRes.status === 201);
  const readyRoom = createReadyRes.json.room;
  console.log(`   Room created in READY state: ${readyRoom.code}`);

  // Fetch host/current
  const currentReadyRes = await request('/api/host/current', { headers: hostHeaders });
  assert.strictEqual(currentReadyRes.status, 200);
  assert.strictEqual(currentReadyRes.json.room.code, readyRoom.code);
  assert.strictEqual(currentReadyRes.json.room.status, 'ready');

  // Test client-side renderFloor with ready room as host
  console.log('   Simulating Host Resume on Ready Room (renderFloor)...');
  const htmlReady = testClientRenderFloor(currentReadyRes.json.room, true);
  assert(htmlReady.includes('Start auction'), 'Must show start auction button');
  console.log('   ✓ Test A passed: Ready room resumed and rendered without JavaScript error.');

  // TEST B: Room with a Current Live Player
  console.log('\n>>> TEST B: Live Room with Active Player');
  const startRes = await request(`/api/room/${readyRoom.code}/action`, {
    method: 'POST',
    headers: hostHeaders,
    body: { action: 'start' }
  });
  assert.strictEqual(startRes.status, 200);
  const liveRoom = startRes.json.room;
  assert.strictEqual(liveRoom.status, 'live');
  assert.strictEqual(liveRoom.lotState, 'bidding');
  assert(liveRoom.currentPlayer, 'Must have a current player');
  console.log(`   Auction live with lot 1: ${liveRoom.currentPlayer.name} (${liveRoom.currentPlayer.role})`);

  // Place a bid
  await request(`/api/room/${readyRoom.code}/join`, {
    method: 'POST',
    body: { clientId: 'client-rcb', name: 'Virat Fan', teamId: 'RCB', role: 'teamOwner' }
  });
  const bidRes = await request(`/api/room/${readyRoom.code}/bid`, {
    method: 'POST',
    body: { clientId: 'client-rcb' }
  });
  assert.strictEqual(bidRes.status, 200);
  console.log(`   Bid placed by RCB at ₹${bidRes.json.room.currentBidCr} Cr`);

  // Fetch host/current
  const currentLiveRes = await request('/api/host/current', { headers: hostHeaders });
  assert.strictEqual(currentLiveRes.status, 200);
  assert.strictEqual(currentLiveRes.json.room.status, 'live');
  assert.strictEqual(currentLiveRes.json.room.currentBidTeamId, 'RCB');

  // Test client-side renderFloor with live room as host (THIS PREVIOUSLY CRASHED WITH liveLot is not defined!)
  console.log('   Simulating Host Resume on Live Room (renderFloor)...');
  const htmlLive = testClientRenderFloor(currentLiveRes.json.room, true);
  assert(htmlLive.includes('✓ SOLD'), 'Must contain SOLD button');
  assert(htmlLive.includes('✕ UNSOLD'), 'Must contain UNSOLD button');
  assert(htmlLive.includes('Skip Player ⏭'), 'Must contain Skip Player button');
  assert(htmlLive.includes(liveRoom.currentPlayer.name), 'Must contain current player name');
  console.log('   ✓ Test B passed: Live room with active lot resumed and rendered without liveLot error.');

  // TEST C: Refresh and Resume (idempotence)
  console.log('\n>>> TEST C: Browser Refresh Simulation and Repeated Resume');
  const refreshRes = await request('/api/host/current', { headers: hostHeaders });
  assert.strictEqual(refreshRes.status, 200);
  assert.strictEqual(refreshRes.json.room.code, readyRoom.code);
  const htmlRefreshed = testClientRenderFloor(refreshRes.json.room, true);
  assert(htmlRefreshed.includes(liveRoom.currentPlayer.name));
  console.log('   ✓ Test C passed: Refresh and resume preserved room state and rendered cleanly.');

  // TEST D: Closed Room cannot be resumed
  console.log('\n>>> TEST D: Closed Room Handling');
  const closeRes = await request(`/api/room/${readyRoom.code}/action`, {
    method: 'POST',
    headers: hostHeaders,
    body: { action: 'close' }
  });
  assert.strictEqual(closeRes.status, 200);

  const afterCloseRes = await request('/api/host/current', { headers: hostHeaders });
  assert.strictEqual(afterCloseRes.status, 200);
  assert.strictEqual(afterCloseRes.json.room, null, 'Closed room must not be returned as active');
  console.log('   ✓ Test D passed: Closed room authoritatively released.');

  // TEST E: Rupee & Spark Symbol Sizing in CSS
  console.log('\n>>> TEST E: Verify Enriched Rupee & Spark Symbol Sizes in CSS');
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
  assert(css.includes('.stat-icon {') && css.includes('font-size: 19px !important;'), 'Missing enlarged stat-icon font-size');
  assert(css.includes('.float-icon {') && css.includes('font-size: 20px !important;'), 'Missing enlarged float-icon font-size');
  assert(css.includes('.feature-icon {') && css.includes('font-size: 24px !important;'), 'Missing enlarged feature-icon font-size');
  assert(css.includes('.rupee-symbol') && css.includes('font-size: 1.12em !important;'), 'Missing enlarged rupee-symbol font-size');
  assert(css.includes('.spark-symbol') && css.includes('font-size: 1.25em !important;'), 'Missing enlarged spark-symbol font-size');
  console.log('   ✓ Test E passed: Rupee and spark symbol sizes verified.');

  console.log('\n================================================================');
  console.log('ALL TESTS PASSED WITH 100% SUCCESS!');
  console.log('================================================================');
}

runTests().catch(err => {
  console.error('\n❌ TEST FAILED:', err);
  process.exit(1);
});
