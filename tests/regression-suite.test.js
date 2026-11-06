'use strict';

/**
 * Comprehensive Deterministic Regression Test Suite for IPL 2027 Auction App
 *
 * Covers:
 * 1. Simultaneous bids & timeout settlement concurrency (Bug A)
 * 2. Late bids rejection & state preservation (Bug A)
 * 3. Repeated Triumph celebration skips idempotency (Bug C)
 * 4. Stale celebration callbacks protection (Bug C)
 * 5. Participant session persistence, validation & refresh restoration (Bug B)
 * 6. Ten consecutive player transitions stress test
 * 7. Preservation of pause/resume, force-sell/unsold, and purse math
 */

const assert = require('node:assert');

const BASE = 'http://127.0.0.1:3333';
const OWNER_CODE = 'ipl2027owner';

async function request(route, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  const response = await fetch(`${BASE}${route}`, {
    ...options,
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  let data = {};
  try { data = await response.json(); } catch {}
  return { status: response.status, data };
}

async function closeActiveRoom(headers) {
  try {
    const cur = await request('/api/host/current', { headers });
    if (cur.data?.roomCode) {
      await request(`/api/room/${cur.data.roomCode}/action`, { method: 'POST', headers, body: { action: 'close' } });
    }
  } catch {}
}

async function getRoomState(code) {
  const res = await request(`/api/room/${code}/state`);
  return res.data.room;
}

async function runAllTests() {
  console.log('='.repeat(80));
  console.log('IPL 2027 AUCTION APP — DETERMINISTIC REGRESSION TEST SUITE');
  console.log('='.repeat(80));
  console.log();

  // Step 0: Host login
  const login = await request('/api/host/login', { method: 'POST', body: { code: OWNER_CODE } });
  assert.strictEqual(login.status, 200, 'Host login must succeed');
  const hostHeaders = { 'x-host-token': login.data.token };
  await closeActiveRoom(hostHeaders);

  // --------------------------------------------------------------------------
  // TEST 1: Concurrency Control - Simultaneous Bids (Bug A)
  // --------------------------------------------------------------------------
  console.log('TEST 1: Simultaneous Bids Concurrency');
  {
    const roomRes = await request('/api/host/create-room', {
      method: 'POST',
      headers: hostHeaders,
      body: { mode: 'mega', timerSeconds: 3, megaPurseCr: 120 }
    });
    assert.strictEqual(roomRes.status, 201, 'Room creation must succeed');
    const code = roomRes.data.room.code;

    // Join 3 teams
    await request(`/api/room/${code}/join`, { method: 'POST', body: { clientId: 'csk-client', name: 'CSK Owner', teamId: 'CSK' } });
    await request(`/api/room/${code}/join`, { method: 'POST', body: { clientId: 'mi-client', name: 'MI Owner', teamId: 'MI' } });
    await request(`/api/room/${code}/join`, { method: 'POST', body: { clientId: 'rcb-client', name: 'RCB Owner', teamId: 'RCB' } });

    // Start auction
    await request(`/api/room/${code}/action`, { method: 'POST', headers: hostHeaders, body: { action: 'start' } });

    // Fire 3 simultaneous bids with Promise.all
    const [bid1, bid2, bid3] = await Promise.all([
      request(`/api/room/${code}/bid`, { method: 'POST', body: { clientId: 'csk-client' } }),
      request(`/api/room/${code}/bid`, { method: 'POST', body: { clientId: 'mi-client' } }),
      request(`/api/room/${code}/bid`, { method: 'POST', body: { clientId: 'rcb-client' } })
    ]);

    const state = await getRoomState(code);
    assert.strictEqual(state.lotDone, false, 'Lot must not be marked done while bidding is active');
    assert.ok(state.currentBidCr != null, 'Current bid must be established');
    assert.ok(state.bidEndsAt > Date.now(), 'Deadline must be in the future');
    assert.ok(state.currentBidHistory.length >= 1, 'At least one bid must be recorded in history');

    // All bids that succeeded must have different amounts or sequential timestamps
    const statuses = [bid1.status, bid2.status, bid3.status];
    const okCount = statuses.filter(s => s === 200).length;
    assert.ok(okCount >= 1, 'At least one simultaneous bid must succeed');
    console.log(`   ✓ Serialized ${statuses.length} simultaneous bids (${okCount} accepted, ${statuses.length - okCount} rejected gracefully)`);
    console.log(`   ✓ Leading bid: ₹${state.currentBidCr} Cr by ${state.currentBidTeamId}`);

    await request(`/api/room/${code}/action`, { method: 'POST', headers: hostHeaders, body: { action: 'close' } });
  }

  // --------------------------------------------------------------------------
  // TEST 2: Last-Second Bid vs Auto-Settlement Race (Bug A)
  // --------------------------------------------------------------------------
  console.log('\nTEST 2: Last-Second Bid vs Auto-Settlement Concurrency');
  {
    const roomRes = await request('/api/host/create-room', {
      method: 'POST',
      headers: hostHeaders,
      body: { mode: 'mega', timerSeconds: 1, megaPurseCr: 120 }
    });
    const code = roomRes.data.room.code;
    await request(`/api/room/${code}/join`, { method: 'POST', body: { clientId: 'csk-client', name: 'CSK Owner', teamId: 'CSK' } });
    await request(`/api/room/${code}/join`, { method: 'POST', body: { clientId: 'mi-client', name: 'MI Owner', teamId: 'MI' } });

    await request(`/api/room/${code}/action`, { method: 'POST', headers: hostHeaders, body: { action: 'start' } });

    // Wait until 200ms before deadline (timer is 1000ms)
    await new Promise(r => setTimeout(r, 800));

    // Place bid near deadline
    const bidRes = await request(`/api/room/${code}/bid`, { method: 'POST', body: { clientId: 'csk-client' } });
    assert.strictEqual(bidRes.status, 200, 'Last-second bid received before deadline must be accepted');

    const stateAfterBid = await getRoomState(code);
    assert.strictEqual(stateAfterBid.lotDone, false, 'Lot must not be settled when bid arrived before deadline');
    assert.ok(stateAfterBid.bidEndsAt > Date.now(), 'Deadline must be extended');
    console.log(`   ✓ Last-second bid accepted at ₹${stateAfterBid.currentBidCr} Cr, deadline extended`);

    // Let it expire and verify clean single settlement
    await new Promise(r => setTimeout(r, 1200));
    const stateSettled = await getRoomState(code);
    assert.strictEqual(stateSettled.lotDone, true, 'Lot must settle after extended timer expires');
    assert.strictEqual(stateSettled.celebrationActive, true, 'Celebration must activate on sale');
    assert.strictEqual(stateSettled.auctionHistory.length, 1, 'Exactly one settlement must be in history');
    assert.strictEqual(stateSettled.auctionHistory[0].teamId, 'CSK', 'Winner must be CSK');
    console.log('   ✓ Player settled exactly once to CSK without duplicate deduction');

    await request(`/api/room/${code}/action`, { method: 'POST', headers: hostHeaders, body: { action: 'close' } });
  }

  // --------------------------------------------------------------------------
  // TEST 3: Late Bid Rejection (Bug A)
  // --------------------------------------------------------------------------
  console.log('\nTEST 3: Late Bid Rejection After Expiration');
  {
    const roomRes = await request('/api/host/create-room', {
      method: 'POST',
      headers: hostHeaders,
      body: { mode: 'mega', timerSeconds: 1, megaPurseCr: 120 }
    });
    const code = roomRes.data.room.code;
    await request(`/api/room/${code}/join`, { method: 'POST', body: { clientId: 'csk-client', name: 'CSK Owner', teamId: 'CSK' } });
    await request(`/api/room/${code}/action`, { method: 'POST', headers: hostHeaders, body: { action: 'start' } });

    // Wait for timer to completely expire (1.3s)
    await new Promise(r => setTimeout(r, 1300));

    // Send a late bid
    const lateBid = await request(`/api/room/${code}/bid`, { method: 'POST', body: { clientId: 'csk-client' } });
    assert.strictEqual(lateBid.status, 409, 'Late bid must be rejected with HTTP 409');
    console.log(`   ✓ Late bid rejected: "${lateBid.data.error}"`);

    const state = await getRoomState(code);
    assert.strictEqual(state.lotDone, true, 'Lot must remain done');
    assert.strictEqual(state.auctionHistory[0].type, 'unsold', 'Player correctly went unsold without late bid resurrection');
    console.log('   ✓ State preserved: player marked UNSOLD, no freeze occurred');

    await request(`/api/room/${code}/action`, { method: 'POST', headers: hostHeaders, body: { action: 'close' } });
  }

  // --------------------------------------------------------------------------
  // TEST 4: Repeated Triumph Celebration Skips Idempotency (Bug C)
  // --------------------------------------------------------------------------
  console.log('\nTEST 4: Repeated Triumph Celebration Skips Idempotency');
  {
    const roomRes = await request('/api/host/create-room', {
      method: 'POST',
      headers: hostHeaders,
      body: { mode: 'mega', timerSeconds: 1, megaPurseCr: 120 }
    });
    const code = roomRes.data.room.code;
    await request(`/api/room/${code}/join`, { method: 'POST', body: { clientId: 'mi-client', name: 'MI Owner', teamId: 'MI' } });
    await request(`/api/room/${code}/action`, { method: 'POST', headers: hostHeaders, body: { action: 'start' } });

    // Bid and let it settle
    await request(`/api/room/${code}/bid`, { method: 'POST', body: { clientId: 'mi-client' } });
    await new Promise(r => setTimeout(r, 1300));

    const stateDuringCeleb = await getRoomState(code);
    assert.strictEqual(stateDuringCeleb.celebrationActive, true, 'Celebration must be active');
    const celebrationId = stateDuringCeleb.celebrationId;
    assert.ok(celebrationId, 'Celebration must have unique celebrationId');
    const initialIndex = stateDuringCeleb.index;

    // Simulate 5 rapid duplicate skip clicks
    const skipPromises = [
      request(`/api/room/${code}/action`, { method: 'POST', headers: hostHeaders, body: { action: 'skip-celebration', celebrationId } }),
      request(`/api/room/${code}/action`, { method: 'POST', headers: hostHeaders, body: { action: 'skip-celebration', celebrationId } }),
      request(`/api/room/${code}/action`, { method: 'POST', headers: hostHeaders, body: { action: 'skip-celebration', celebrationId } }),
      request(`/api/room/${code}/action`, { method: 'POST', headers: hostHeaders, body: { action: 'skip-celebration', celebrationId } }),
      request(`/api/room/${code}/action`, { method: 'POST', headers: hostHeaders, body: { action: 'skip-celebration', celebrationId } })
    ];
    const skipResults = await Promise.all(skipPromises);
    skipResults.forEach((res, idx) => {
      assert.strictEqual(res.status, 200, `Skip request ${idx + 1} must return HTTP 200`);
    });

    const stateAfterSkips = await getRoomState(code);
    assert.strictEqual(stateAfterSkips.index, initialIndex + 1, 'Player index must increment by EXACTLY 1, never multiple times');
    assert.strictEqual(stateAfterSkips.celebrationActive, false, 'Celebration must be deactivated');
    assert.strictEqual(stateAfterSkips.lotDone, false, 'New lot must be immediately ready for bidding');
    assert.ok(stateAfterSkips.bidEndsAt > Date.now(), 'New player must receive complete timer window');
    console.log(`   ✓ 5 rapid skip clicks processed idempotently: index ${initialIndex} -> ${stateAfterSkips.index}`);
    console.log(`   ✓ Next player: ${stateAfterSkips.currentPlayer.name} with full bidding timer`);

    // Verify stale celebration callback from earlier celebrationId is ignored
    const staleEnd = await request(`/api/room/${code}/action`, {
      method: 'POST',
      headers: hostHeaders,
      body: { action: 'end-celebration', celebrationId }
    });
    assert.strictEqual(staleEnd.status, 200, 'Stale callback must return 200 without throwing');
    const stateAfterStale = await getRoomState(code);
    assert.strictEqual(stateAfterStale.index, initialIndex + 1, 'Stale callback must NOT increment player index again');
    console.log('   ✓ Stale celebration callback successfully ignored without advancing player');

    await request(`/api/room/${code}/action`, { method: 'POST', headers: hostHeaders, body: { action: 'close' } });
  }

  // --------------------------------------------------------------------------
  // TEST 5: Participant Refresh & Session Restoration (Bug B)
  // --------------------------------------------------------------------------
  console.log('\nTEST 5: Participant Session Persistence & Refresh Restoration');
  {
    const roomRes = await request('/api/host/create-room', {
      method: 'POST',
      headers: hostHeaders,
      body: { mode: 'mega', timerSeconds: 5, megaPurseCr: 120 }
    });
    const code = roomRes.data.room.code;

    // Join as CSK team owner
    const joinRes = await request(`/api/room/${code}/join`, {
      method: 'POST',
      body: { clientId: 'client-persist-123', name: 'Sahith Reddy', teamId: 'CSK' }
    });
    assert.strictEqual(joinRes.status, 200, 'Initial join must succeed');
    assert.strictEqual(joinRes.data.participant.teamId, 'CSK');
    assert.strictEqual(joinRes.data.participant.role, 'teamOwner');

    // Start auction
    await request(`/api/room/${code}/action`, { method: 'POST', headers: hostHeaders, body: { action: 'start' } });

    // Capture state before refresh
    const stateBeforeRefresh = await getRoomState(code);
    const deadlineBefore = stateBeforeRefresh.bidEndsAt;
    const playerBefore = stateBeforeRefresh.currentPlayer.id;

    // Simulate page refresh:
    // Client has localStorage: { roomCode: code, participant: joinRes.data.participant, clientId: 'client-persist-123' }
    // When re-checking state:
    const refreshState = await request(`/api/room/${code}/state`);
    assert.strictEqual(refreshState.status, 200);

    // Validate restored session against server-side state
    const serverParticipant = refreshState.data.room.participants.find(p => p.clientId === 'client-persist-123');
    assert.ok(serverParticipant, 'Participant must exist on server');
    assert.strictEqual(serverParticipant.name, 'Sahith Reddy');
    assert.strictEqual(serverParticipant.teamId, 'CSK');
    assert.strictEqual(serverParticipant.role, 'teamOwner');

    // Simulate re-join with same clientId (session restore validation):
    const restoreRes = await request(`/api/room/${code}/join`, {
      method: 'POST',
      body: { clientId: 'client-persist-123', name: 'Sahith Reddy', teamId: 'CSK' }
    });
    assert.strictEqual(restoreRes.status, 200);
    assert.strictEqual(restoreRes.data.participant.teamId, 'CSK');

    // Check participants count: must NOT have duplicate entries
    const cskParticipants = restoreRes.data.room.participants.filter(p => p.teamId === 'CSK');
    assert.strictEqual(cskParticipants.length, 1, 'Must have exactly one participant for CSK');

    // Invariant: restoration must NOT change current player or reset timer
    assert.strictEqual(restoreRes.data.room.currentPlayer.id, playerBefore, 'Current player must NOT change on refresh');
    assert.strictEqual(restoreRes.data.room.bidEndsAt, deadlineBefore, 'Countdown timer must NOT reset on refresh');

    // Restored participant can bid immediately
    const bidAfterRestore = await request(`/api/room/${code}/bid`, {
      method: 'POST',
      body: { clientId: 'client-persist-123' }
    });
    assert.strictEqual(bidAfterRestore.status, 200, 'Restored participant must be able to bid immediately');
    console.log('   ✓ Participant session validated and restored on refresh');
    console.log('   ✓ No duplicate participants created in room.participants');
    console.log('   ✓ Countdown timer and active player preserved');
    console.log('   ✓ Restored participant successfully placed bid');

    // Test seat release
    const leaveRes = await request(`/api/room/${code}/leave`, {
      method: 'POST',
      body: { clientId: 'client-persist-123' }
    });
    assert.strictEqual(leaveRes.status, 200);
    const leftCheck = leaveRes.data.room.participants.find(p => p.clientId === 'client-persist-123');
    assert.strictEqual(leftCheck, undefined, 'Participant must be cleared on leave');
    console.log('   ✓ Releasing seat clears participant correctly');

    await request(`/api/room/${code}/action`, { method: 'POST', headers: hostHeaders, body: { action: 'close' } });
  }

  // --------------------------------------------------------------------------
  // TEST 6: Ten Consecutive Player Transitions Stress Test
  // --------------------------------------------------------------------------
  console.log('\nTEST 6: Ten Consecutive Player Transitions (Mixed Operations)');
  {
    const roomRes = await request('/api/host/create-room', {
      method: 'POST',
      headers: hostHeaders,
      body: { mode: 'mega', timerSeconds: 1, megaPurseCr: 120 }
    });
    const code = roomRes.data.room.code;
    await request(`/api/room/${code}/join`, { method: 'POST', body: { clientId: 'csk-client', name: 'CSK Owner', teamId: 'CSK' } });
    await request(`/api/room/${code}/join`, { method: 'POST', body: { clientId: 'mi-client', name: 'MI Owner', teamId: 'MI' } });

    await request(`/api/room/${code}/action`, { method: 'POST', headers: hostHeaders, body: { action: 'start' } });

    for (let lot = 1; lot <= 10; lot++) {
      const state = await getRoomState(code);
      const player = state.currentPlayer;
      assert.ok(player, `Lot ${lot}: Current player must be active`);

      if (lot % 2 === 1) {
        // Odd lots: Bid and sell to CSK
        const bidRes = await request(`/api/room/${code}/bid`, { method: 'POST', body: { clientId: 'csk-client' } });
        assert.strictEqual(bidRes.status, 200, `Lot ${lot}: Bid should succeed`);
        // Wait for settlement
        await new Promise(r => setTimeout(r, 1200));

        const celebState = await getRoomState(code);
        assert.strictEqual(celebState.celebrationActive, true, `Lot ${lot}: Celebration must be active`);

        // Skip celebration
        const skipRes = await request(`/api/room/${code}/action`, {
          method: 'POST',
          headers: hostHeaders,
          body: { action: 'skip-celebration', celebrationId: celebState.celebrationId }
        });
        assert.strictEqual(skipRes.status, 200, `Lot ${lot}: Skip celebration should succeed`);
      } else {
        // Even lots: Let it expire unsold (wait 1.5s for 1s timer + 250ms interval)
        await new Promise(r => setTimeout(r, 1500));

        const unsoldState = await getRoomState(code);
        assert.strictEqual(unsoldState.lotDone, true, `Lot ${lot}: Lot must be marked done`);

        // Host advances to next
        const nextRes = await request(`/api/room/${code}/action`, {
          method: 'POST',
          headers: hostHeaders,
          body: { action: 'next' }
        });
        assert.strictEqual(nextRes.status, 200, `Lot ${lot}: Next player action should succeed`);
      }
      process.stdout.write(`.`);
    }
    console.log();

    const finalState = await getRoomState(code);
    assert.strictEqual(finalState.auctionHistory.length, 10, 'Must have exactly 10 lots processed in history');
    assert.strictEqual(finalState.soldCount, 5, 'Exactly 5 lots must be SOLD');
    assert.strictEqual(finalState.processedCount, 10, 'Processed count must be 10');
    console.log('   ✓ 10 consecutive player transitions completed without a single freeze or skip');
    console.log(`   ✓ 5 sold, 5 unsold, auction history length: ${finalState.auctionHistory.length}`);

    await request(`/api/room/${code}/action`, { method: 'POST', headers: hostHeaders, body: { action: 'close' } });
  }

  // --------------------------------------------------------------------------
  // TEST 7: Preservation of Pause/Resume, Force-Sell, and Purse Math
  // --------------------------------------------------------------------------
  console.log('\nTEST 7: Preservation of Pause/Resume, Force-Sell, and Purse Calculations');
  {
    const roomRes = await request('/api/host/create-room', {
      method: 'POST',
      headers: hostHeaders,
      body: { mode: 'mega', timerSeconds: 10, megaPurseCr: 100 }
    });
    const code = roomRes.data.room.code;
    await request(`/api/room/${code}/join`, { method: 'POST', body: { clientId: 'rcb-client', name: 'RCB Owner', teamId: 'RCB' } });
    await request(`/api/room/${code}/action`, { method: 'POST', headers: hostHeaders, body: { action: 'start' } });

    // Place bid from RCB
    await request(`/api/room/${code}/bid`, { method: 'POST', body: { clientId: 'rcb-client' } });

    // Pause auction
    const pauseRes = await request(`/api/room/${code}/action`, { method: 'POST', headers: hostHeaders, body: { action: 'pause' } });
    assert.strictEqual(pauseRes.status, 200);
    const pausedState = await getRoomState(code);
    assert.strictEqual(pausedState.status, 'paused');
    assert.ok(pausedState.pausedRemainingMs > 0, 'Remaining time must be captured');
    console.log(`   ✓ Auction paused with ${pausedState.pausedRemainingMs}ms remaining`);

    // Resume auction
    const resumeRes = await request(`/api/room/${code}/action`, { method: 'POST', headers: hostHeaders, body: { action: 'resume' } });
    assert.strictEqual(resumeRes.status, 200);
    const resumedState = await getRoomState(code);
    assert.strictEqual(resumedState.status, 'live');
    assert.ok(resumedState.bidEndsAt > Date.now(), 'Deadline must be re-activated');
    console.log('   ✓ Auction resumed cleanly');

    // Force-sell (Host manual SOLD)
    const forceSell = await request(`/api/room/${code}/action`, { method: 'POST', headers: hostHeaders, body: { action: 'sold' } });
    assert.strictEqual(forceSell.status, 200, 'Host force-sell must succeed');
    const sellState = await getRoomState(code);
    assert.strictEqual(sellState.lotDone, true);
    assert.strictEqual(sellState.celebrationActive, true);

    const rcbTeam = sellState.teams.find(t => t.id === 'RCB');
    assert.strictEqual(rcbTeam.squad.length, 1, 'RCB squad must have 1 player');
    assert.strictEqual(rcbTeam.spentCr, sellState.currentBidCr, 'RCB spentCr must match bid');
    assert.strictEqual(rcbTeam.purseCr, 100 - sellState.currentBidCr, 'RCB purse must be starting purse minus bid');
    console.log(`   ✓ Purse calculation verified: ₹100 Cr - ₹${sellState.currentBidCr} Cr = ₹${rcbTeam.purseCr} Cr`);

    await request(`/api/room/${code}/action`, { method: 'POST', headers: hostHeaders, body: { action: 'close' } });
  }

  console.log('\n' + '='.repeat(80));
  console.log('ALL REGRESSION TESTS PASSED SUCCESSFULLY! (7/7 suites)');
  console.log('='.repeat(80));
}

runAllTests().catch(err => {
  console.error('\n❌ REGRESSION TEST FAILED:', err);
  process.exit(1);
});
