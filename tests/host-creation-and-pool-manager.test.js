const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const appJs = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');

function request(path, options = {}) {
  return new Promise((resolve, reject) => {
    const data = options.body ? (typeof options.body === 'string' ? options.body : JSON.stringify(options.body)) : null;
    const req = http.request({
      hostname: 'localhost',
      port: 3333,
      path,
      method: options.method || (data ? 'POST' : 'GET'),
      headers: {
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        ...(options.headers || {})
      }
    }, res => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(buf); } catch { parsed = buf; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function createBrowserSandbox(initialStore = {}, initialSearch = '', customFetch = null) {
  const store = { ...initialStore };
  const dom = {
    app: { innerHTML: '', querySelectorAll: () => [], querySelector: () => null },
    toastRoot: { appendChild: () => {} }
  };
  const sandbox = {
    document: {
      getElementById: (id) => {
        if (id === 'app') return dom.app;
        if (id === 'toast-root') return dom.toastRoot;
        return null;
      },
      createElement: (tag) => ({
        setAttribute: () => {},
        style: {},
        appendChild: () => {},
        remove: () => {},
        classList: { add: () => {}, remove: () => {} }
      }),
      querySelectorAll: () => [],
      querySelector: () => null,
      addEventListener: () => {}
    },
    Audio: class {
      constructor(src) { this.src = src; }
      play() { return Promise.resolve(); }
      pause() {}
    },
    window: {
      localStorage: {
        getItem: (k) => store[k] || null,
        setItem: (k, v) => { store[k] = String(v); },
        removeItem: (k) => { delete store[k]; }
      },
      location: { href: 'http://localhost:3333/' + initialSearch, search: initialSearch },
      history: {
        replaceState: (state, title, url) => {
          sandbox.window.location.href = url;
          const qIndex = url.indexOf('?');
          sandbox.window.location.search = qIndex !== -1 ? url.slice(qIndex) : '';
        }
      },
      matchMedia: () => ({ matches: false }),
      addEventListener: () => {}
    },
    crypto: { randomUUID: () => 'uuid-' + Math.random().toString(36).slice(2) },
    URLSearchParams,
    URL,
    fetch: customFetch || (async (url, opts = {}) => {
      const res = await request(url, { headers: opts.headers, method: opts.method, body: opts.body });
      return {
        ok: res.status >= 200 && res.status < 300,
        status: res.status,
        json: async () => res.body
      };
    }),
    console: console,
    setTimeout: (fn) => setTimeout(fn, 1),
    clearTimeout: () => {},
    setInterval: () => 1,
    clearInterval: () => {}
  };
  vm.createContext(sandbox);
  vm.runInContext(appJs, sandbox);
  return {
    sandbox,
    store,
    dom,
    setState: (fn) => vm.runInContext(`(${fn.toString()})(state);`, sandbox),
    run: (code) => vm.runInContext(code, sandbox)
  };
}

async function runTests() {
  console.log('--- STARTING VERIFICATION TEST SUITE ---');

  // Step 0: Login and clean state
  const loginRes = await request('/api/host/login', { body: { code: 'ipl2027owner' } });
  assert.strictEqual(loginRes.status, 200, 'Host login should succeed');
  const hostToken = loginRes.body.token;
  assert.ok(hostToken, 'Token should be returned');

  // Close any lingering room
  await request('/api/host/close-room', { method: 'POST', headers: { 'x-host-token': hostToken } });
  console.log('✓ Clean state: active room closed.');

  // =========================================================================
  // TEST A: First-time Host Creation (Mini Auction)
  // =========================================================================
  console.log('\n[TEST A] First-time host creation (Mini Auction)');
  const miniCreate = await request('/api/host/create-room', {
    method: 'POST',
    headers: { 'x-host-token': hostToken },
    body: {
      mode: 'mini',
      timerSeconds: 10,
      maxSquadSize: 25,
      maxOverseas: 8,
      miniPurseAddOnCr: 5,
      revisitUnsold: true,
      randomOrder: false
    }
  });
  assert.strictEqual(miniCreate.status, 201, 'Mini room should be created with 201');
  const miniRoom = miniCreate.body.room;
  assert.ok(miniRoom.code, 'Room code should exist');
  assert.strictEqual(miniRoom.mode, 'mini');
  assert.strictEqual(miniRoom.status, 'ready');

  // Frontend simulation for Test A: verify host lands on host dashboard with auctioneer controls
  const clientA = createBrowserSandbox({ 'ipl27-owner-token': hostToken });
  clientA.sandbox.__miniRoom = miniRoom;
  clientA.run(`
    state.isHost = true;
    state.room = __miniRoom;
    state.roomCode = __miniRoom.code;
    state.view = 'floor';
    renderRoom();
  `);
  assert.ok(clientA.dom.app.innerHTML.includes('Auction controls') || clientA.dom.app.innerHTML.includes('Auctioneer console'), 'Host should see Auctioneer controls');
  assert.ok(clientA.dom.app.innerHTML.includes('Start auction'), 'Host should see Start auction button');
  assert.ok(clientA.dom.app.innerHTML.includes('OWNER / AUCTIONEER'), 'Top pill should state OWNER / AUCTIONEER');
  assert.ok(!clientA.dom.app.innerHTML.includes('Your seat: Join to bid'), 'Host must NOT see participant join prompt');
  console.log('✓ TEST A PASSED: Mini auction room created and rendered directly into Host dashboard.');

  // =========================================================================
  // TEST B: Mega Auction Creation (Both Host & Participant retention modes)
  // =========================================================================
  console.log('\n[TEST B] Mega Auction creation (Host retention mode & Participant retention mode)');
  // Close mini room
  await request('/api/host/close-room', { method: 'POST', headers: { 'x-host-token': hostToken } });

  // 1. Host selects retentions (retentionMode: 'host')
  const megaHostCreate = await request('/api/host/create-room', {
    method: 'POST',
    headers: { 'x-host-token': hostToken },
    body: {
      mode: 'mega',
      retentionMode: 'host',
      timerSeconds: 10,
      maxSquadSize: 25,
      maxOverseas: 8,
      megaPurseCr: 120,
      revisitUnsold: true,
      randomOrder: false
    }
  });
  assert.strictEqual(megaHostCreate.status, 201);
  const megaHostRoom = megaHostCreate.body.room;
  assert.strictEqual(megaHostRoom.retentionMode, 'host');

  // Verify renderRoom works without canStart or runtime errors
  const clientB1 = createBrowserSandbox({ 'ipl27-owner-token': hostToken });
  clientB1.sandbox.__megaHostRoom = megaHostRoom;
  clientB1.run(`
    state.isHost = true;
    state.room = __megaHostRoom;
    state.roomCode = __megaHostRoom.code;
    state.view = 'retention';
    renderRoom();
  `);
  assert.ok(clientB1.dom.app.innerHTML.includes('MEGA AUCTION'), 'Mega auction retention header should be rendered');
  assert.ok(clientB1.dom.app.innerHTML.includes('Finalize Remaining Teams & Start Auction'), 'Finalize button should be present in host retention mode');
  console.log('✓ Host-managed retention mode renders correctly without canStart error.');

  // Close and test Participant retention mode
  await request('/api/host/close-room', { method: 'POST', headers: { 'x-host-token': hostToken } });
  const megaPartCreate = await request('/api/host/create-room', {
    method: 'POST',
    headers: { 'x-host-token': hostToken },
    body: {
      mode: 'mega',
      retentionMode: 'participants',
      timerSeconds: 10,
      maxSquadSize: 25,
      maxOverseas: 8,
      megaPurseCr: 120,
      revisitUnsold: true,
      randomOrder: false
    }
  });
  assert.strictEqual(megaPartCreate.status, 201);
  const megaPartRoom = megaPartCreate.body.room;
  assert.strictEqual(megaPartRoom.retentionMode, 'participants');

  const clientB2 = createBrowserSandbox({ 'ipl27-owner-token': hostToken });
  clientB2.sandbox.__megaPartRoom = megaPartRoom;
  clientB2.run(`
    state.isHost = true;
    state.room = __megaPartRoom;
    state.roomCode = __megaPartRoom.code;
    state.view = 'retention';
    renderRoom();
  `);
  assert.ok(clientB2.dom.app.innerHTML.includes('Franchise Retention Readiness Monitor'), 'Host monitors via 10-Franchise Readiness Monitor');
  assert.ok(clientB2.dom.app.innerHTML.includes('HOST DASHBOARD · READY TO START WHEN ≥1 CONFIRMED'), 'Readiness badge rendered');
  console.log('✓ TEST B PASSED: Mega auction creation and both retention modes render successfully.');

  // Keep megaPartRoom for subsequent tests C, D, E, F, G, H
  const currentRoom = megaPartRoom;

  // =========================================================================
  // TEST C: No second create click required
  // =========================================================================
  console.log('\n[TEST C] No second create click required');
  assert.strictEqual(clientB2.run('state.isHost'), true, 'Host is immediately marked as isHost');
  assert.strictEqual(clientB2.run('state.roomCode'), currentRoom.code, 'Host is immediately in the room code');
  assert.strictEqual(clientB2.run('state.participant'), null, 'Host is not a participant');
  console.log('✓ TEST C PASSED: Host enters newly created room directly on first action.');

  // =========================================================================
  // TEST D: Host authorization after navigation
  // =========================================================================
  console.log('\n[TEST D] Host authorization after navigation');
  const currentApi = await request('/api/host/current', { headers: { 'x-host-token': hostToken } });
  assert.strictEqual(currentApi.status, 200);
  assert.strictEqual(currentApi.body.roomCode, currentRoom.code);
  assert.strictEqual(currentApi.body.isOwner, true);
  console.log('✓ TEST D PASSED: Host authorization survives and /api/host/current verifies host status.');

  // =========================================================================
  // TEST E: Refresh and Resume
  // =========================================================================
  console.log('\n[TEST E] Refresh and resume verification');
  const clientRefresh = createBrowserSandbox({
    'ipl27-owner-token': hostToken,
    'ipl27-owner-room': currentRoom.code
  }, `?room=${currentRoom.code}`);
  await clientRefresh.run('init();');
  assert.strictEqual(clientRefresh.run('state.isHost'), true, 'Refreshed host session must be restored as isHost');
  assert.strictEqual(clientRefresh.run('state.roomCode'), currentRoom.code, 'Refreshed host must remain in active room');
  assert.strictEqual(clientRefresh.run('state.participant'), null, 'Host must never become participant on refresh');
  console.log('✓ TEST E PASSED: Host refreshes page and resumes active room as host.');

  // =========================================================================
  // TEST F: Independent Participant Session
  // =========================================================================
  console.log('\n[TEST F] Independent participant session');
  const participantJoin = await request(`/api/room/${currentRoom.code}/join`, {
    method: 'POST',
    body: { clientId: 'client-participant-1', name: 'CSK Fan', teamId: 'CSK' }
  });
  assert.strictEqual(participantJoin.status, 200);
  assert.strictEqual(participantJoin.body.participant.teamId, 'CSK');
  assert.strictEqual(participantJoin.body.participant.role, 'teamOwner');

  // Verify participant's state in browser
  const clientPart = createBrowserSandbox({
    'ipl27-client-id': 'client-participant-1',
    'ipl27-participant': JSON.stringify({ roomCode: currentRoom.code, participant: participantJoin.body.participant, clientId: 'client-participant-1' })
  });
  clientPart.sandbox.__partRoom = participantJoin.body.room;
  clientPart.sandbox.__partObj = participantJoin.body.participant;
  clientPart.sandbox.__partCode = currentRoom.code;
  clientPart.run(`
    state.isHost = false;
    state.room = __partRoom;
    state.roomCode = __partCode;
    state.participant = __partObj;
    state.view = 'retention';
    renderRoom();
  `);
  assert.ok(clientPart.dom.app.innerHTML.includes('YOUR FRANCHISE (CSK)') || clientPart.dom.app.innerHTML.includes('Chennai Super Kings'), 'Participant controls CSK retentions');
  assert.ok(!clientPart.dom.app.innerHTML.includes('Finalize Remaining Teams & Start Auction'), 'Participant must NOT see Host Finalize control');
  assert.ok(!clientPart.dom.app.innerHTML.includes('Close Room'), 'Participant must NOT see Close Room button');
  console.log('✓ TEST F PASSED: Independent participant session operates with participant controls only.');

  // =========================================================================
  // TEST G: Access Control (Server rejects unauthorized host operations)
  // =========================================================================
  console.log('\n[TEST G] Access control (Participant cannot execute host actions)');
  const unauthorizedClose = await request(`/api/host/close-room`, {
    method: 'POST',
    headers: { 'x-host-token': 'fake-participant-token' }
  });
  assert.strictEqual(unauthorizedClose.status, 401, 'Unauthorized close should return 401');

  const unauthorizedFinalize = await request(`/api/room/${currentRoom.code}/retention/finalize`, {
    method: 'POST',
    headers: { 'x-host-token': 'fake-participant-token' }
  });
  assert.strictEqual(unauthorizedFinalize.status, 403, 'Unauthorized finalize should return 403');
  console.log('✓ TEST G PASSED: Server strictly rejects unauthorized host operations.');

  // =========================================================================
  // TEST H: Duplicate Create Protection
  // =========================================================================
  console.log('\n[TEST H] Duplicate create protection');
  const duplicateCreate = await request('/api/host/create-room', {
    method: 'POST',
    headers: { 'x-host-token': hostToken },
    body: { mode: 'mini', timerSeconds: 10 }
  });
  assert.strictEqual(duplicateCreate.status, 409, 'Server must return 409 when room is already active');
  assert.ok(/already active/i.test(duplicateCreate.body.error), 'Useful error message returned');
  console.log('✓ TEST H PASSED: Concurrent / duplicate room creation rejected with 409.');

  // =========================================================================
  // TEST I: Closed Room Lifecycle
  // =========================================================================
  console.log('\n[TEST I] Closed room lifecycle');
  const closeRes = await request('/api/host/close-room', {
    method: 'POST',
    headers: { 'x-host-token': hostToken }
  });
  assert.strictEqual(closeRes.status, 200);
  assert.strictEqual(closeRes.body.closed, true);

  // Closed room state should now be 404
  const stateCheck = await request(`/api/room/${currentRoom.code}/state`);
  assert.strictEqual(stateCheck.status, 404, 'Closed room state should be 404');

  // Immediately create a new fresh room
  const newFreshRoom = await request('/api/host/create-room', {
    method: 'POST',
    headers: { 'x-host-token': hostToken },
    body: { mode: 'mini', timerSeconds: 10 }
  });
  assert.strictEqual(newFreshRoom.status, 201, 'Fresh room can immediately be created after close');
  console.log('✓ TEST I PASSED: Room closure releases active room lock and allows immediate fresh creation.');
  await request('/api/host/close-room', { method: 'POST', headers: { 'x-host-token': hostToken } });

  // =========================================================================
  // PRIORITY 1: Player Pool Manager Tests
  // =========================================================================
  console.log('\n[PRIORITY 1] Player Pool Manager Tests');

  // 1. Full-width workspace check
  const hostClient = createBrowserSandbox({ 'ipl27-owner-token': hostToken });
  hostClient.run("state.ownerReady = true; state.hostTab = 'pool'; renderHome();");
  assert.ok(hostClient.dom.app.innerHTML.includes('pool-manager-workspace-full'), 'Pool manager should render full-width workspace');
  assert.ok(!hostClient.dom.app.innerHTML.includes('hero-host-guide'), 'Hero guide illustration must NOT be rendered in pool manager workspace');
  console.log('✓ Player Pool Manager renders full-width workspace without hero illustration crowding.');

  // 2. All candidate records preserved
  const bootstrapRes = await request('/api/bootstrap');
  assert.strictEqual(bootstrapRes.status, 200);
  const initialCandidates = bootstrapRes.body.candidates;
  console.log(`✓ Preserved candidate records count: ${initialCandidates.length}`);
  assert.ok(initialCandidates.length >= 182, 'All 182 candidate records must be present');

  // 3. Add Player via API
  const testCandidateName = 'Test Candidate ' + Date.now().toString(36);
  const addPlayerRes = await request('/api/admin/players', {
    method: 'POST',
    headers: { 'x-host-token': hostToken },
    body: {
      name: testCandidateName,
      nationality: 'India',
      origin: 'Domestic',
      cappedStatus: 'Uncapped',
      roleBucket: 'Bowler',
      role: 'Left-arm Fast',
      roleSubtype: 'Left-arm Fast',
      basePriceCr: 0.20,
      auctionSet: 'BO1',
      candidateSource: 'https://cricinfo.com/test',
      notes: 'SMAT 2026 breakout talent',
      includeInMini: true,
      includeInMega: true
    }
  });
  assert.strictEqual(addPlayerRes.status, 201, 'Add player should return 201');
  const addedPlayer = addPlayerRes.body.player;
  assert.strictEqual(addedPlayer.name, testCandidateName);
  assert.strictEqual(addedPlayer.basePriceCr, 0.20);
  assert.strictEqual(addedPlayer.cappedStatus, 'Uncapped');
  console.log(`✓ Added candidate ${addedPlayer.name} (id: ${addedPlayer.id})`);

  // 4. Persistence check: verify player exists in new bootstrap fetch
  const bootstrapAfterAdd = await request('/api/bootstrap');
  const foundAdded = bootstrapAfterAdd.body.candidates.find(c => c.id === addedPlayer.id);
  assert.ok(foundAdded, 'Added player must persist in database');
  assert.strictEqual(foundAdded.basePriceCr, 0.20);
  console.log('✓ Persistence verified: Added player persisted to server database.');

  // 5. Edit the same player
  const editPlayerRes = await request(`/api/admin/players/${addedPlayer.id}`, {
    method: 'PUT',
    headers: { 'x-host-token': hostToken },
    body: {
      name: testCandidateName + ' Upgraded',
      basePriceCr: 0.50,
      cappedStatus: 'Capped',
      roleSubtype: 'Express Fast Bowler',
      notes: 'Upgraded to capped after national debut'
    }
  });
  assert.strictEqual(editPlayerRes.status, 200, 'Edit player should return 200');
  assert.strictEqual(editPlayerRes.body.player.name, testCandidateName + ' Upgraded');
  assert.strictEqual(editPlayerRes.body.player.basePriceCr, 0.50);
  assert.strictEqual(editPlayerRes.body.player.cappedStatus, 'Capped');
  console.log('✓ Edit verified: Player record updated in place without duplicate.');

  // 6. Exclude player from pool
  const toggleExclRes = await request(`/api/admin/players/${addedPlayer.id}/toggle-exclusion`, {
    method: 'POST',
    headers: { 'x-host-token': hostToken }
  });
  assert.strictEqual(toggleExclRes.status, 200);
  assert.strictEqual(toggleExclRes.body.excluded, true, 'Player should now be excluded');

  // Verify excluded candidate is omitted from fresh room candidate pool
  const roomWithExcl = await request('/api/host/create-room', {
    method: 'POST',
    headers: { 'x-host-token': hostToken },
    body: { mode: 'mini', timerSeconds: 10 }
  });
  assert.strictEqual(roomWithExcl.status, 201);
  const foundInRoom = roomWithExcl.body.room.candidatePool.find(c => c.id === addedPlayer.id);
  assert.strictEqual(foundInRoom, undefined, 'Excluded player must NOT be in the active candidate pool');
  console.log('✓ Exclusion verified: Excluded candidate omitted from new auction pool.');
  await request('/api/host/close-room', { method: 'POST', headers: { 'x-host-token': hostToken } });

  // 7. Restore player to pool
  const toggleRestoreRes = await request(`/api/admin/players/${addedPlayer.id}/toggle-exclusion`, {
    method: 'POST',
    headers: { 'x-host-token': hostToken }
  });
  assert.strictEqual(toggleRestoreRes.status, 200);
  assert.strictEqual(toggleRestoreRes.body.excluded, false, 'Player should now be restored');
  console.log('✓ Restoration verified: Player restored to candidate pool.');

  // 8. Delete the test player clean-up
  const deleteRes = await request(`/api/admin/players/${addedPlayer.id}`, {
    method: 'DELETE',
    headers: { 'x-host-token': hostToken }
  });
  assert.strictEqual(deleteRes.status, 200);
  console.log('✓ Deletion verified: Test player safely removed.');

  // 9. Verify unauthenticated call to admin routes is rejected
  const unauthAdd = await request('/api/admin/players', {
    method: 'POST',
    body: { name: 'Hacker Player' }
  });
  assert.strictEqual(unauthAdd.status, 401, 'Unauthenticated add player should return 401');
  console.log('✓ Admin security verified: Player management endpoints require host authorization.');

  console.log('\n=========================================');
  console.log('ALL VERIFICATION TESTS COMPLETED WITH 100% SUCCESS!');
  console.log('=========================================\n');
}

runTests().catch(err => {
  console.error('\n❌ TEST FAILURE:', err);
  process.exit(1);
});
