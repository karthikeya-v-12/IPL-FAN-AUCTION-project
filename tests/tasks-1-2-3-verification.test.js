'use strict';

const assert = require('node:assert');
const http = require('node:http');

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3333';
const OWNER_CODE = 'ipl2027owner';

function request(path, options = {}) {
  const url = new URL(path, BASE_URL);
  const headers = Object.assign({}, options.headers);
  let bodyData = null;

  if (options.body != null) {
    bodyData = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
    if (!headers['content-type']) headers['content-type'] = 'application/json';
    headers['content-length'] = Buffer.byteLength(bodyData);
  }

  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method: options.method || 'GET',
      headers
    }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        let parsed = data;
        try { parsed = JSON.parse(data); } catch {}
        resolve({ status: res.statusCode, data: parsed });
      });
    });
    req.on('error', reject);
    if (bodyData) req.write(bodyData);
    req.end();
  });
}

async function getRoomState(code) {
  const res = await request(`/api/room/${code}/state`);
  return res.data.room;
}

async function closeActiveRoom(headers) {
  try {
    const cur = await request('/api/host/current', { headers });
    if (cur.data?.roomCode) {
      await request(`/api/room/${cur.data.roomCode}/action`, { method: 'POST', headers, body: { action: 'close' } });
    }
  } catch {}
}

async function runTasksVerification() {
  console.log('='.repeat(80));
  console.log('IPL 2027 AUCTION APP — TASKS 1, 2, 3 VERIFICATION SUITE (TESTS A - G)');
  console.log('='.repeat(80));

  // 1. Host Login
  const loginRes = await request('/api/host/login', { method: 'POST', body: { code: OWNER_CODE } });
  assert.strictEqual(loginRes.status, 200, 'Host login must succeed');
  const hostHeaders = { 'x-host-token': loginRes.data.token };
  await closeActiveRoom(hostHeaders);

  // ===========================================================================
  // TEST A: Mega Auction — Option 1: "Host manages all franchises"
  // ===========================================================================
  console.log('\nTEST A: Option 1 — Host manages all franchises (retentionMode: "host")');
  {
    const roomRes = await request('/api/host/create-room', {
      method: 'POST',
      headers: hostHeaders,
      body: { mode: 'mega', retentionMode: 'host', timerSeconds: 5, megaPurseCr: 120 }
    });
    assert.strictEqual(roomRes.status, 201, 'Mega room created');
    const code = roomRes.data.room.code;
    assert.strictEqual(roomRes.data.room.retentionMode, 'host');
    assert.strictEqual(roomRes.data.room.status, 'retention');

    // Participant joins as CSK
    const joinRes = await request(`/api/room/${code}/join`, {
      method: 'POST',
      body: { clientId: 'p-csk', name: 'CSK Participant', teamId: 'CSK' }
    });
    assert.strictEqual(joinRes.status, 200);

    // Subtest A.1: Participant CANNOT configure or confirm retentions (403 Forbidden)
    const partConfirm = await request(`/api/room/${code}/retention/confirm`, {
      method: 'POST',
      body: { clientId: 'p-csk', teamId: 'CSK', retentions: [{ name: 'Ruturaj Gaikwad', type: 'capped' }] }
    });
    assert.strictEqual(partConfirm.status, 403, 'Participant must be forbidden from configuring retentions in host mode');
    console.log('   ✓ Participant rejected with 403 when attempting to configure retention');

    // Subtest A.2: Participant CANNOT cancel retentions (403 Forbidden)
    const partCancel = await request(`/api/room/${code}/retention/cancel`, {
      method: 'POST',
      body: { clientId: 'p-csk', teamId: 'CSK' }
    });
    assert.strictEqual(partCancel.status, 403, 'Participant must be forbidden from cancelling in host mode');
    console.log('   ✓ Participant rejected with 403 when attempting to cancel retention');

    // Subtest A.3: Host CAN configure retentions for franchises
    const hostCskConfirm = await request(`/api/room/${code}/retention/confirm`, {
      method: 'POST',
      headers: hostHeaders,
      body: { teamId: 'CSK', retentions: [{ name: 'Ruturaj Gaikwad', type: 'capped' }, { name: 'Shivam Dube', type: 'capped' }] }
    });
    assert.strictEqual(hostCskConfirm.status, 200, 'Host can configure CSK retention');
    assert.strictEqual(hostCskConfirm.data.team.retentionConfirmed, true);
    assert.strictEqual(hostCskConfirm.data.team.retentionCostCr, 32.0); // 18 + 14 = 32
    assert.strictEqual(hostCskConfirm.data.team.purseCr, 88.0); // 120 - 32 = 88
    console.log('   ✓ Host successfully configured CSK retention (2 capped, ₹32 Cr deducted, ₹88 Cr left)');

    // Subtest A.4: Host finalizes retentions (auto-confirms remaining 9 teams as 0 retentions)
    const finRes = await request(`/api/room/${code}/retention/finalize`, {
      method: 'POST',
      headers: hostHeaders
    });
    assert.strictEqual(finRes.status, 200, 'Host finalization must succeed');
    const stateAfterFin = await getRoomState(code);
    assert.strictEqual(stateAfterFin.status, 'ready');
    assert.strictEqual(stateAfterFin.retentionFinalized, true);
    // Check that CSK has Ruturaj Gaikwad in squad
    const cskTeam = stateAfterFin.teams.find(t => t.id === 'CSK');
    assert.strictEqual(cskTeam.squad.length, 2);
    assert.strictEqual(cskTeam.squad[0].name, 'Ruturaj Gaikwad');
    // Check that candidate pool does not include Ruturaj Gaikwad
    const pool = stateAfterFin.order || [];
    assert.strictEqual(pool.some(p => p.name === 'Ruturaj Gaikwad'), false, 'Retained player must not be in auction pool');
    console.log('   ✓ Host finalized retention: pool updated, status changed to "ready", retained players excluded');

    await closeActiveRoom(hostHeaders);
  }

  // ===========================================================================
  // TEST B: Mega Auction — Option 2: "Participants select retentions for their own franchises"
  // ===========================================================================
  console.log('\nTEST B: Option 2 — Participants select retentions (retentionMode: "participants")');
  {
    const roomRes = await request('/api/host/create-room', {
      method: 'POST',
      headers: hostHeaders,
      body: { mode: 'mega', retentionMode: 'participants', timerSeconds: 5, megaPurseCr: 120 }
    });
    assert.strictEqual(roomRes.status, 201);
    const code = roomRes.data.room.code;
    assert.strictEqual(roomRes.data.room.retentionMode, 'participants');

    // Participant 1 joins as CSK
    const joinCsk = await request(`/api/room/${code}/join`, {
      method: 'POST',
      body: { clientId: 'client-csk-1', name: 'CSK Boss', teamId: 'CSK' }
    });
    assert.strictEqual(joinCsk.status, 200);

    // Participant 2 joins as MI
    const joinMi = await request(`/api/room/${code}/join`, {
      method: 'POST',
      body: { clientId: 'client-mi-1', name: 'MI Boss', teamId: 'MI' }
    });
    assert.strictEqual(joinMi.status, 200);

    // Subtest B.1: CSK participant CANNOT edit MI's retentions (403 Forbidden)
    const cskHacksMi = await request(`/api/room/${code}/retention/confirm`, {
      method: 'POST',
      body: { clientId: 'client-csk-1', teamId: 'MI', retentions: [{ name: 'Jasprit Bumrah', type: 'capped' }] }
    });
    assert.strictEqual(cskHacksMi.status, 403, 'CSK participant must not be allowed to configure MI');
    console.log('   ✓ Cross-team tampering blocked: CSK participant rejected with 403 when targeting MI');

    // Subtest B.2: CSK participant CAN configure CSK's retentions
    const cskRetRes = await request(`/api/room/${code}/retention/confirm`, {
      method: 'POST',
      body: {
        clientId: 'client-csk-1',
        teamId: 'CSK',
        retentions: [
          { name: 'Ruturaj Gaikwad', type: 'capped' },
          { name: 'Shivam Dube', type: 'capped' },
          { name: 'Sanju Samson', type: 'capped' }
        ]
      }
    });
    assert.strictEqual(cskRetRes.status, 200, 'CSK owner can configure CSK');
    assert.strictEqual(cskRetRes.data.team.retentionConfirmed, true);
    assert.strictEqual(cskRetRes.data.team.retentionCostCr, 43.0); // 18 + 14 + 11 = 43
    assert.strictEqual(cskRetRes.data.team.purseCr, 77.0); // 120 - 43 = 77
    console.log('   ✓ CSK owner confirmed 3 retentions (₹43.00 Cr, remaining purse: ₹77.00 Cr)');

    // Subtest B.3: Persistence across refresh
    const refreshedState = await getRoomState(code);
    const refreshedCsk = refreshedState.teams.find(t => t.id === 'CSK');
    assert.strictEqual(refreshedCsk.retentionConfirmed, true);
    assert.strictEqual(refreshedCsk.retentions.length, 3);
    assert.strictEqual(refreshedCsk.purseCr, 77.0);
    console.log('   ✓ Retention state persists across page refresh / rejoining');

    // Subtest B.4: Host dashboard sees CSK as confirmed and other 9 teams as pending
    const confirmedCount = refreshedState.teams.filter(t => t.retentionConfirmed).length;
    assert.strictEqual(confirmedCount, 1);
    console.log('   ✓ Host dashboard state accurately reflects 1 Confirmed and 9 Pending franchises');

    // Subtest B.5: Host can start auction directly with 1 confirmed participant (auto-finalizing remaining 9)
    const startRes = await request(`/api/room/${code}/action`, {
      method: 'POST',
      headers: hostHeaders,
      body: { action: 'start' }
    });
    assert.strictEqual(startRes.status, 200, 'Host can start auction with single confirmed participant');
    const liveState = await getRoomState(code);
    assert.strictEqual(liveState.status, 'live');
    assert.strictEqual(liveState.retentionFinalized, true);
    console.log('   ✓ Host successfully started auction with 1 confirmed participant; remaining 9 auto-finalized');

    await closeActiveRoom(hostHeaders);
  }

  // ===========================================================================
  // TEST C & D: Single Celebration Lifecycle (No Double SOLD Card) & Smooth Timer Expiry (No Reset to 2-4s)
  // ===========================================================================
  console.log('\nTEST C & D: Single Celebration Lifecycle & Timer Expiry Without Glitch');
  {
    const roomRes = await request('/api/host/create-room', {
      method: 'POST',
      headers: hostHeaders,
      body: { mode: 'mini', timerSeconds: 2 } // 2 second timer
    });
    assert.strictEqual(roomRes.status, 201);
    const code = roomRes.data.room.code;

    // Join CSK and RCB
    await request(`/api/room/${code}/join`, { method: 'POST', body: { clientId: 'csk-1', name: 'CSK Owner', teamId: 'CSK' } });
    await request(`/api/room/${code}/join`, { method: 'POST', body: { clientId: 'rcb-1', name: 'RCB Owner', teamId: 'RCB' } });

    // Start auction
    await request(`/api/room/${code}/action`, { method: 'POST', headers: hostHeaders, body: { action: 'start' } });

    const stateLive = await getRoomState(code);
    assert.strictEqual(stateLive.status, 'live');
    assert.strictEqual(stateLive.lotState, 'bidding');
    const firstPlayerName = stateLive.currentPlayer?.name;
    console.log(`   ✓ Auction started live with player: ${firstPlayerName}`);

    // Place bid
    const bidRes = await request(`/api/room/${code}/bid`, { method: 'POST', body: { clientId: 'csk-1' } });
    assert.strictEqual(bidRes.status, 200);
    console.log(`   ✓ Bid placed by CSK at ₹${bidRes.data.room.currentBidCr} Cr`);

    // Wait for timer to expire (2.3s)
    await new Promise(r => setTimeout(r, 2300));

    // Verify settled state
    const stateSold = await getRoomState(code);
    assert.strictEqual(stateSold.lotDone, true, 'Lot must be marked done');
    assert.strictEqual(stateSold.lotState, 'celebration', 'Lot state must be celebration');
    assert.strictEqual(stateSold.celebrationActive, true, 'Celebration must be active');
    assert.ok(stateSold.celebrationId, 'Must have a distinct celebrationId');

    // TEST D Invariant: Timer countdown must NOT have reset to 2-4 seconds!
    // In server, bidEndsAt must be null during celebration
    assert.strictEqual(stateSold.bidEndsAt, null, 'bidEndsAt must be null when bidding is done');
    console.log('   ✓ Timer countdown did NOT reset to 2-4s: bidEndsAt is null, lotState is celebration');

    // TEST C: Host / Participant dismisses celebration
    const skipRes = await request(`/api/room/${code}/action`, {
      method: 'POST',
      headers: hostHeaders,
      body: { action: 'skip-celebration' }
    });
    assert.strictEqual(skipRes.status, 200);

    const stateNext = await getRoomState(code);
    assert.strictEqual(stateNext.index, 1, 'Index advanced to next player lot');
    assert.strictEqual(stateNext.lotState, 'bidding', 'Next lot is in bidding state');
    assert.strictEqual(stateNext.celebrationActive, false, 'Celebration dismissed cleanly');
    assert.strictEqual(stateNext.auctionHistory.length, 1, 'Exactly one sold record in history');
    assert.strictEqual(stateNext.auctionHistory[0].playerName, firstPlayerName);
    console.log(`   ✓ Single celebration cycle completed: Next player lot (${stateNext.currentPlayer?.name}) loaded without double card or flash`);

    await closeActiveRoom(hostHeaders);
  }

  // ===========================================================================
  // TEST E: Concurrency & Deadline Collision Protection
  // ===========================================================================
  console.log('\nTEST E: Concurrency & Simultaneous Bidding');
  {
    const roomRes = await request('/api/host/create-room', {
      method: 'POST',
      headers: hostHeaders,
      body: { mode: 'mini', timerSeconds: 3 }
    });
    const code = roomRes.data.room.code;
    await request(`/api/room/${code}/join`, { method: 'POST', body: { clientId: 'csk-e', name: 'CSK', teamId: 'CSK' } });
    await request(`/api/room/${code}/join`, { method: 'POST', body: { clientId: 'rcb-e', name: 'RCB', teamId: 'RCB' } });
    await request(`/api/room/${code}/join`, { method: 'POST', body: { clientId: 'mi-e', name: 'MI', teamId: 'MI' } });
    await request(`/api/room/${code}/action`, { method: 'POST', headers: hostHeaders, body: { action: 'start' } });

    // 3 parallel bids
    const [b1, b2, b3] = await Promise.all([
      request(`/api/room/${code}/bid`, { method: 'POST', body: { clientId: 'csk-e' } }),
      request(`/api/room/${code}/bid`, { method: 'POST', body: { clientId: 'rcb-e' } }),
      request(`/api/room/${code}/bid`, { method: 'POST', body: { clientId: 'mi-e' } })
    ]);

    const accepted = [b1, b2, b3].filter(r => r.status === 200);
    assert.strictEqual(accepted.length, 3, 'All 3 simultaneous bids must serialize properly');
    const finalRoom = await getRoomState(code);
    assert.ok(finalRoom.currentBidCr >= 0.3, 'Bids raised consecutively without corruption');
    console.log(`   ✓ 3 simultaneous bids serialized cleanly: current bid ₹${finalRoom.currentBidCr} Cr`);

    await closeActiveRoom(hostHeaders);
  }

  // ===========================================================================
  // TEST F: Real-time Synchronization Across States
  // ===========================================================================
  console.log('\nTEST F: Real-Time Synchronization Across States');
  {
    const roomRes = await request('/api/host/create-room', {
      method: 'POST',
      headers: hostHeaders,
      body: { mode: 'mini', timerSeconds: 5 }
    });
    const code = roomRes.data.room.code;
    const s1 = await getRoomState(code);
    assert.strictEqual(s1.status, 'ready');
    assert.strictEqual(s1.lotState, 'ready');

    await request(`/api/room/${code}/action`, { method: 'POST', headers: hostHeaders, body: { action: 'start' } });
    const s2 = await getRoomState(code);
    assert.strictEqual(s2.status, 'live');
    assert.strictEqual(s2.lotState, 'bidding');

    await request(`/api/room/${code}/action`, { method: 'POST', headers: hostHeaders, body: { action: 'pause' } });
    const s3 = await getRoomState(code);
    assert.strictEqual(s3.status, 'paused');
    assert.strictEqual(s3.lotState, 'paused');

    await request(`/api/room/${code}/action`, { method: 'POST', headers: hostHeaders, body: { action: 'resume' } });
    const s4 = await getRoomState(code);
    assert.strictEqual(s4.status, 'live');
    assert.strictEqual(s4.lotState, 'bidding');

    console.log('   ✓ State transitions (ready -> bidding -> paused -> bidding) fully synchronized');
    await closeActiveRoom(hostHeaders);
  }

  // ===========================================================================
  // TEST G: Mini Auction Unaffected and Rosters Preserved
  // ===========================================================================
  console.log('\nTEST G: Mini Auction Preserved (Rosters, Purses, No Retention Blocking)');
  {
    const roomRes = await request('/api/host/create-room', {
      method: 'POST',
      headers: hostHeaders,
      body: { mode: 'mini', timerSeconds: 5 }
    });
    const code = roomRes.data.room.code;
    const state = await getRoomState(code);
    assert.strictEqual(state.mode, 'mini');
    assert.strictEqual(state.status, 'ready', 'Mini auction bypasses retention and goes straight to ready');

    // Check that pre-existing franchise squads are intact
    const rcb = state.teams.find(t => t.id === 'RCB');
    assert.ok(rcb.squad.length > 0, 'RCB must have pre-existing squad in Mini Auction');
    assert.ok(rcb.squad.some(p => p.name === 'Virat Kohli'), 'Virat Kohli must be on RCB roster');
    console.log(`   ✓ Mini Auction retains pre-existing squad: RCB has ${rcb.squad.length} players including Virat Kohli`);

    await closeActiveRoom(hostHeaders);
  }

  console.log('\n' + '='.repeat(80));
  console.log('✨ ALL TASKS 1, 2, 3 VERIFICATION TESTS (A through G) PASSED 100%!');
  console.log('='.repeat(80) + '\n');
}

runTasksVerification().catch(err => {
  console.error('\n❌ Tasks verification failed:', err);
  process.exit(1);
});
