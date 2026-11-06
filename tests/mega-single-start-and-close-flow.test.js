'use strict';

const assert = require('node:assert');
const http = require('node:http');

const PORT = 3333;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const HOST_ACCESS_CODE = 'ipl2027owner';

function request(method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const reqHeaders = { ...headers };
    let reqBody = null;
    if (body != null) {
      reqBody = typeof body === 'string' ? body : JSON.stringify(body);
      reqHeaders['Content-Type'] = 'application/json';
      reqHeaders['Content-Length'] = Buffer.byteLength(reqBody);
    }
    const req = http.request(url, { method, headers: reqHeaders }, res => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, body: json || raw });
      });
    });
    req.on('error', reject);
    if (reqBody) req.write(reqBody);
    req.end();
  });
}

async function loginHost() {
  const res = await request('POST', '/api/host/login', { code: HOST_ACCESS_CODE });
  assert.strictEqual(res.status, 200, 'Host login should succeed');
  return res.body.token;
}

async function closeActiveRoomIfExists(token) {
  try {
    const current = await request('GET', '/api/host/current', null, { 'x-host-token': token });
    if (current.body && current.body.roomCode) {
      await request('POST', `/api/room/${current.body.roomCode}/action`, { action: 'close' }, { 'x-host-token': token });
    }
  } catch {}
}

async function runTests() {
  console.log('--- STARTING MEGA AUCTION SINGLE PARTICIPANT & CLOSE ROOM SUITE ---');
  const token = await loginHost();
  assert(token, 'Host token received');

  // Ensure clean slate
  await closeActiveRoomIfExists(token);

  // =========================================================================
  // TEST C — ZERO CONFIRMED FRANCHISES REJECTION
  // =========================================================================
  console.log('\n[TEST C] Zero confirmed franchises: start must be rejected with 400');
  const resC = await request('POST', '/api/host/create-room', {
    mode: 'mega',
    retentionMode: 'participants',
    timerSeconds: 10,
    megaPurseCr: 120
  }, { 'x-host-token': token });
  assert.strictEqual(resC.status, 201, 'Mega room created');
  const roomCodeC = resC.body.room.code;

  // Attempt to start before any franchise confirms
  const startAttemptC = await request('POST', `/api/room/${roomCodeC}/action`, { action: 'start' }, { 'x-host-token': token });
  assert.strictEqual(startAttemptC.status, 400, 'Starting with 0 confirmed must fail with 400');
  assert(
    /At least one franchise must confirm/i.test(startAttemptC.body.error),
    `Error message should explain requirement: ${startAttemptC.body.error}`
  );
  console.log('✓ TEST C Passed: Server correctly rejected start with 0 confirmed teams and clear message.');

  // Clean close room
  await request('POST', `/api/room/${roomCodeC}/action`, { action: 'close' }, { 'x-host-token': token });

  // =========================================================================
  // TEST A — ONE PARTICIPANT STARTS A MEGA AUCTION
  // =========================================================================
  console.log('\n[TEST A] One participant confirms, other 9 unconfirmed: Host starts Mega Auction');
  const resA = await request('POST', '/api/host/create-room', {
    mode: 'mega',
    retentionMode: 'participants',
    timerSeconds: 10,
    megaPurseCr: 120
  }, { 'x-host-token': token });
  assert.strictEqual(resA.status, 201, 'Mega room created');
  const roomCodeA = resA.body.room.code;

  // Participant 1 joins as CSK
  const p1 = await request('POST', `/api/room/${roomCodeA}/join`, {
    clientId: 'client-csk-1',
    name: 'CSK Boss',
    teamId: 'CSK'
  });
  assert.strictEqual(p1.status, 200, 'Participant 1 joined as CSK');

  // CSK confirms retentions (e.g. Ruturaj Gaikwad and MS Dhoni)
  const confirmCSK = await request('POST', `/api/room/${roomCodeA}/retention/confirm`, {
    clientId: 'client-csk-1',
    teamId: 'CSK',
    retentions: [
      { name: 'Ruturaj Gaikwad', type: 'capped' },
      { name: 'MS Dhoni', type: 'uncapped' }
    ]
  });
  assert.strictEqual(confirmCSK.status, 200, 'CSK confirmed retentions');
  assert.strictEqual(confirmCSK.body.team.retentions.length, 2);
  assert.strictEqual(confirmCSK.body.team.retentionCostCr, 22); // 18 (slab 1) + 4 (uncapped) = 22
  assert.strictEqual(confirmCSK.body.team.purseCr, 98); // 120 - 22 = 98

  // Host starts the auction with only 1 confirmed franchise!
  const startA = await request('POST', `/api/room/${roomCodeA}/action`, { action: 'start' }, { 'x-host-token': token });
  assert.strictEqual(startA.status, 200, 'Auction must start successfully with 1 confirmed franchise');
  const roomA = startA.body.room;
  assert.strictEqual(roomA.status, 'live', 'Room status should be live');
  assert.strictEqual(roomA.lotState, 'bidding', 'Lot state should be bidding');
  assert(roomA.currentPlayer, 'First player lot should be active');

  // Verify the 9 unconfirmed franchises were auto-finalized properly
  const cskTeam = roomA.teams.find(t => t.id === 'CSK');
  assert.strictEqual(cskTeam.retentions.length, 2, 'CSK confirmed retentions preserved');
  assert.strictEqual(cskTeam.purseCr, 98, 'CSK purse preserved');
  assert.strictEqual(cskTeam.rtmCount, 4, 'CSK RTM cards = 6 - 2 = 4');

  const otherTeams = roomA.teams.filter(t => t.id !== 'CSK');
  assert.strictEqual(otherTeams.length, 9, '9 other teams exist');
  for (const team of otherTeams) {
    assert.strictEqual(team.retentionConfirmed, true, `${team.id} retentionConfirmed should be true`);
    assert.strictEqual(team.autoFinalized, true, `${team.id} should be marked autoFinalized: true`);
    assert.strictEqual(team.retentionFinalizedBy, 'host', `${team.id} should be marked retentionFinalizedBy: host`);
    assert.strictEqual(team.retentions.length, 0, `${team.id} should have 0 retentions`);
    assert.strictEqual(team.purseCr, 120, `${team.id} should retain full starting purse 120 Cr`);
    assert.strictEqual(team.spentCr, 0, `${team.id} spent should be 0`);
    assert.strictEqual(team.rtmCount, 6, `${team.id} should have 6 RTM cards available`);
  }

  // Verify candidate pool has released players and no duplicates
  const poolA = roomA.candidatePool;
  const poolNames = poolA.map(p => p.name.toLowerCase().trim());
  const uniqueNames = new Set(poolNames);
  assert.strictEqual(poolNames.length, uniqueNames.size, 'Candidate pool must not have duplicate candidates');
  assert(!uniqueNames.has('ruturaj gaikwad'), 'Retained player Ruturaj Gaikwad must NOT be in auction pool');
  assert(!uniqueNames.has('ms dhoni'), 'Retained player MS Dhoni must NOT be in auction pool');
  console.log('✓ TEST A Passed: 1 confirmed franchise started Mega Auction; 9 other teams auto-finalized cleanly with 6 RTMs and full purse.');

  // Close room A
  await request('POST', `/api/room/${roomCodeA}/action`, { action: 'close' }, { 'x-host-token': token });

  // =========================================================================
  // TEST B — SEVERAL PARTICIPANTS START A MEGA AUCTION
  // =========================================================================
  console.log('\n[TEST B] Multiple participants confirm retentions: Host starts Mega Auction');
  const resB = await request('POST', '/api/host/create-room', {
    mode: 'mega',
    retentionMode: 'participants',
    timerSeconds: 10,
    megaPurseCr: 120
  }, { 'x-host-token': token });
  assert.strictEqual(resB.status, 201, 'Mega room created');
  const roomCodeB = resB.body.room.code;

  // Participant 1: MI
  await request('POST', `/api/room/${roomCodeB}/join`, { clientId: 'c-mi', name: 'MI Boss', teamId: 'MI' });
  await request('POST', `/api/room/${roomCodeB}/retention/confirm`, {
    clientId: 'c-mi',
    teamId: 'MI',
    retentions: [
      { name: 'Rohit Sharma', type: 'capped' },
      { name: 'Jasprit Bumrah', type: 'capped' },
      { name: 'Suryakumar Yadav', type: 'capped' }
    ]
  });

  // Participant 2: RCB
  await request('POST', `/api/room/${roomCodeB}/join`, { clientId: 'c-rcb', name: 'RCB Boss', teamId: 'RCB' });
  await request('POST', `/api/room/${roomCodeB}/retention/confirm`, {
    clientId: 'c-rcb',
    teamId: 'RCB',
    retentions: [
      { name: 'Virat Kohli', type: 'capped' },
      { name: 'Yash Dayal', type: 'uncapped' }
    ]
  });

  // Host starts the auction
  const startB = await request('POST', `/api/room/${roomCodeB}/action`, { action: 'start' }, { 'x-host-token': token });
  assert.strictEqual(startB.status, 200, 'Auction must start with multiple confirmed teams');
  const roomB = startB.body.room;
  assert.strictEqual(roomB.status, 'live');

  // Verify MI and RCB
  const miTeam = roomB.teams.find(t => t.id === 'MI');
  assert.strictEqual(miTeam.retentions.length, 3);
  assert.strictEqual(miTeam.autoFinalized, undefined);

  const rcbTeam = roomB.teams.find(t => t.id === 'RCB');
  assert.strictEqual(rcbTeam.retentions.length, 2);
  assert.strictEqual(rcbTeam.autoFinalized, undefined);

  // Verify remaining 8 teams auto-finalized
  const autoTeamsB = roomB.teams.filter(t => t.id !== 'MI' && t.id !== 'RCB');
  assert.strictEqual(autoTeamsB.length, 8);
  for (const t of autoTeamsB) {
    assert.strictEqual(t.autoFinalized, true);
    assert.strictEqual(t.retentionConfirmed, true);
    assert.strictEqual(t.purseCr, 120);
  }
  console.log('✓ TEST B Passed: Multiple confirmed teams preserved and 8 remaining auto-finalized.');

  // Close room B
  await request('POST', `/api/room/${roomCodeB}/action`, { action: 'close' }, { 'x-host-token': token });

  // =========================================================================
  // TEST E — CLOSE ROOM AT EACH STAGE
  // =========================================================================
  console.log('\n[TEST E] Close room at each stage');

  // Stage 1: Close during retention
  const resE1 = await request('POST', '/api/host/create-room', { mode: 'mega', retentionMode: 'participants' }, { 'x-host-token': token });
  const codeE1 = resE1.body.room.code;
  const closeE1 = await request('POST', `/api/room/${codeE1}/action`, { action: 'close' }, { 'x-host-token': token });
  assert.strictEqual(closeE1.status, 200, 'Close during retention succeeds');
  const pollE1 = await request('GET', `/api/room/${codeE1}/state`);
  assert.strictEqual(pollE1.status, 404, 'Polling closed room returns 404');
  console.log('✓ Stage 1 Passed: Closed cleanly during retention setup.');

  // Stage 2: Close during active bidding
  const resE2 = await request('POST', '/api/host/create-room', { mode: 'mini', timerSeconds: 15 }, { 'x-host-token': token });
  const codeE2 = resE2.body.room.code;
  await request('POST', `/api/room/${codeE2}/action`, { action: 'start' }, { 'x-host-token': token });
  // Place a bid
  await request('POST', `/api/room/${codeE2}/join`, { clientId: 'bidder-e2', name: 'Bidder E2', teamId: 'CSK' });
  await request('POST', `/api/room/${codeE2}/bid`, { clientId: 'bidder-e2' });

  // Close during live bidding
  const closeE2 = await request('POST', `/api/room/${codeE2}/action`, { action: 'close' }, { 'x-host-token': token });
  assert.strictEqual(closeE2.status, 200, 'Close during bidding succeeds');

  // Verify subsequent bids rejected
  const bidAfterClose = await request('POST', `/api/room/${codeE2}/bid`, { clientId: 'bidder-e2' });
  assert.strictEqual(bidAfterClose.status, 404, 'Bid rejected after room closure');
  console.log('✓ Stage 2 Passed: Closed cleanly during live bidding, subsequent bids rejected.');

  // Stage 3: Close during SOLD celebration
  const resE3 = await request('POST', '/api/host/create-room', { mode: 'mini', timerSeconds: 15 }, { 'x-host-token': token });
  const codeE3 = resE3.body.room.code;
  await request('POST', `/api/room/${codeE3}/action`, { action: 'start' }, { 'x-host-token': token });
  await request('POST', `/api/room/${codeE3}/join`, { clientId: 'bidder-e3', name: 'Bidder E3', teamId: 'CSK' });
  await request('POST', `/api/room/${codeE3}/bid`, { clientId: 'bidder-e3' });
  // Mark sold to enter celebration
  await request('POST', `/api/room/${codeE3}/action`, { action: 'sold' }, { 'x-host-token': token });
  const stateE3 = await request('GET', `/api/room/${codeE3}/state`);
  assert(stateE3.body.room.celebrationActive, 'Celebration should be active');

  // Close during celebration
  const closeE3 = await request('POST', `/api/room/${codeE3}/action`, { action: 'close' }, { 'x-host-token': token });
  assert.strictEqual(closeE3.status, 200, 'Close during celebration succeeds');
  const pollE3 = await request('GET', `/api/room/${codeE3}/state`);
  assert.strictEqual(pollE3.status, 404, 'Room closed during celebration returns 404');
  console.log('✓ Stage 3 Passed: Closed cleanly during SOLD celebration.');

  // Stage 4: Close during paused auction
  const resE4 = await request('POST', '/api/host/create-room', { mode: 'mini', timerSeconds: 15 }, { 'x-host-token': token });
  const codeE4 = resE4.body.room.code;
  await request('POST', `/api/room/${codeE4}/action`, { action: 'start' }, { 'x-host-token': token });
  await request('POST', `/api/room/${codeE4}/action`, { action: 'pause' }, { 'x-host-token': token });
  const stateE4 = await request('GET', `/api/room/${codeE4}/state`);
  assert.strictEqual(stateE4.body.room.status, 'paused', 'Room should be paused');

  const closeE4 = await request('POST', `/api/room/${codeE4}/action`, { action: 'close' }, { 'x-host-token': token });
  assert.strictEqual(closeE4.status, 200, 'Close during pause succeeds');
  console.log('✓ Stage 4 Passed: Closed cleanly during paused state.');

  // =========================================================================
  // TEST F — NEW ROOM AFTER CLOSURE
  // =========================================================================
  console.log('\n[TEST F] New room creation after closure');
  // Attempting to create a room now must succeed because previous was closed!
  const resF = await request('POST', '/api/host/create-room', {
    mode: 'mini',
    timerSeconds: 10
  }, { 'x-host-token': token });
  assert.strictEqual(resF.status, 201, 'Fresh room can be created immediately after closure');
  const codeF = resF.body.room.code;
  assert(codeF, 'New room code assigned');

  // Verify fresh state
  const stateF = await request('GET', `/api/room/${codeF}/state`);
  assert.strictEqual(stateF.body.room.status, 'ready');
  assert.strictEqual(stateF.body.room.index, 0);
  assert.strictEqual(stateF.body.room.participants.length, 0);

  // Close room F
  await request('POST', `/api/room/${codeF}/action`, { action: 'close' }, { 'x-host-token': token });
  console.log('✓ TEST F Passed: Fresh room created cleanly after room closure without state bleed.');

  // =========================================================================
  // TEST G — REGRESSION ACROSS CORE FEATURES
  // =========================================================================
  console.log('\n[TEST G] Regression across mini auction and host-managed mega auction');

  // Mini Auction flow
  const resG1 = await request('POST', '/api/host/create-room', { mode: 'mini', timerSeconds: 8 }, { 'x-host-token': token });
  assert.strictEqual(resG1.status, 201);
  const codeG1 = resG1.body.room.code;
  const startG1 = await request('POST', `/api/room/${codeG1}/action`, { action: 'start' }, { 'x-host-token': token });
  assert.strictEqual(startG1.status, 200);
  assert.strictEqual(startG1.body.room.status, 'live');
  await request('POST', `/api/room/${codeG1}/action`, { action: 'close' }, { 'x-host-token': token });

  // Host-managed mega auction flow
  const resG2 = await request('POST', '/api/host/create-room', { mode: 'mega', retentionMode: 'host', megaPurseCr: 120 }, { 'x-host-token': token });
  assert.strictEqual(resG2.status, 201);
  const codeG2 = resG2.body.room.code;
  // Host configures retentions directly
  await request('POST', `/api/room/${codeG2}/retention/confirm`, {
    teamId: 'CSK',
    retentions: [{ name: 'Ruturaj Gaikwad', type: 'capped' }]
  }, { 'x-host-token': token });
  // Host starts
  const startG2 = await request('POST', `/api/room/${codeG2}/action`, { action: 'start' }, { 'x-host-token': token });
  assert.strictEqual(startG2.status, 200);
  assert.strictEqual(startG2.body.room.status, 'live');
  await request('POST', `/api/room/${codeG2}/action`, { action: 'close' }, { 'x-host-token': token });

  console.log('✓ TEST G Passed: Mini auction and host-managed mega auction flows regression-clean.');

  console.log('\n=======================================================');
  console.log('✅ ALL TESTS IN mega-single-start-and-close-flow PASSED 100%');
  console.log('=======================================================');
}

runTests().catch(err => {
  console.error('\n❌ TEST SUITE FAILED:', err);
  process.exit(1);
});
