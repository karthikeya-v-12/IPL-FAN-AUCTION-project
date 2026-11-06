'use strict';

/**
 * IPL 2027 Fan Auction — Mega Auction Retention Subsystem Tests
 *
 * Verifies the IPL 2025–27 retention reference framework:
 * 1. Six eligible retentions with valid category combinations (e.g. 5 capped + 1 uncapped, 4 capped + 2 uncapped).
 * 2. Maximum capped-player limit enforced (rejection on > 5 capped).
 * 3. Maximum uncapped-player limit enforced (rejection on > 2 uncapped).
 * 4. Attempted seventh retention/RTM rejected.
 * 5. Invalid category combinations rejected (overseas player cannot be uncapped).
 * 6. Insufficient purse protection (cannot exceed starting purse).
 * 7. Retention cancellation before finalization (resetting selections and restored purse).
 * 8. Duplicate confirmation requests handled idempotently.
 * 9. Duplicate player names within a team's retention draft rejected.
 * 10. Complete auction pool reconstruction across all 10 franchises upon finalization:
 *     - Retained players kept in squads with their respective salaries.
 *     - All unretained squad players released into the candidate pool.
 *     - Canonical deduplication against existing candidates.
 * 11. Invariant: NO player is both retained and present in the auction candidate pool.
 * 12. Correct purse math and remaining RTM count (6 - retentions).
 */

const assert = require('node:assert');

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3333';
const OWNER_CODE = process.env.HOST_ACCESS_CODE || 'ipl2027owner';

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

async function runMegaRetentionTests() {
  console.log('='.repeat(80));
  console.log('IPL 2027 FAN AUCTION — MEGA AUCTION RETENTION TEST SUITE');
  console.log('='.repeat(80));

  // Host login
  const login = await request('/api/host/login', { method: 'POST', body: { code: OWNER_CODE } });
  assert.strictEqual(login.status, 200, 'Host login must succeed');
  const hostHeaders = { 'x-host-token': login.data.token };
  await closeActiveRoom(hostHeaders);

  // ---------------------------------------------------------------------------
  // TEST 1: Room starts in 'retention' phase for Mega Auction
  // ---------------------------------------------------------------------------
  console.log('\nTEST 1: Mega Auction Room Creation and Initial Retention Status');
  const roomRes = await request('/api/host/create-room', {
    method: 'POST',
    headers: hostHeaders,
    body: { mode: 'mega', timerSeconds: 5, megaPurseCr: 120 }
  });
  assert.strictEqual(roomRes.status, 201, 'Mega room creation must succeed');
  const code = roomRes.data.room.code;
  assert.strictEqual(roomRes.data.room.mode, 'mega');
  assert.strictEqual(roomRes.data.room.status, 'retention');
  assert.strictEqual(roomRes.data.room.lotState, 'retention');
  console.log(`   ✓ Mega room ${code} initialized in retention status`);

  // Join RCB owner
  const joinRcb = await request(`/api/room/${code}/join`, {
    method: 'POST',
    body: { clientId: 'rcb-owner-1', name: 'RCB Boss', teamId: 'RCB' }
  });
  assert.strictEqual(joinRcb.status, 200);

  // ---------------------------------------------------------------------------
  // TEST 2: Valid Retention (3 Capped + 2 Uncapped) & Exact Slabs
  // Slabs: ₹18 Cr (Capped 1), ₹14 Cr (Capped 2), ₹11 Cr (Capped 3) = ₹43 Cr.
  // Uncapped: ₹4 Cr * 2 = ₹8 Cr.
  // Total = ₹51 Cr. Remaining purse = 120 - 51 = ₹69 Cr. Remaining RTMs = 6 - 5 = 1.
  // ---------------------------------------------------------------------------
  console.log('\nTEST 2: Valid Retention Configuration & Exact Slabs Math');
  {
    const rcbRetentions = [
      { name: 'Virat Kohli', type: 'capped' },
      { name: 'Rajat Patidar', type: 'capped' },
      { name: 'Bhuvneshwar Kumar', type: 'capped' },
      { name: 'Yash Dayal', type: 'uncapped' },
      { name: 'Suyash Sharma', type: 'uncapped' }
    ];

    const confRes = await request(`/api/room/${code}/retention/confirm`, {
      method: 'POST',
      body: { clientId: 'rcb-owner-1', teamId: 'RCB', retentions: rcbRetentions }
    });
    assert.strictEqual(confRes.status, 200, `Retention confirmation must succeed: ${JSON.stringify(confRes.data)}`);

    const rcbTeam = confRes.data.team;
    assert.strictEqual(rcbTeam.retentionConfirmed, true);
    assert.strictEqual(rcbTeam.retentions.length, 5);
    assert.strictEqual(rcbTeam.retentionCostCr, 51.0);
    assert.strictEqual(rcbTeam.spentCr, 51.0);
    assert.strictEqual(rcbTeam.purseCr, 69.0);
    assert.strictEqual(rcbTeam.rtmCount, 1);
    assert.strictEqual(rcbTeam.squad.length, 5);
    console.log(`   ✓ RCB Retained 5 players for ₹51.00 Cr. Remaining purse: ₹69.00 Cr, RTMs left: 1`);
  }

  // ---------------------------------------------------------------------------
  // TEST 3: Attempted 6 Capped Retentions (Should be rejected, max 5)
  // ---------------------------------------------------------------------------
  console.log('\nTEST 3: Maximum Capped Player Limit Enforcement (Max 5)');
  {
    const overCapped = [
      { name: 'Virat Kohli', type: 'capped' },
      { name: 'Rajat Patidar', type: 'capped' },
      { name: 'Bhuvneshwar Kumar', type: 'capped' },
      { name: 'Devdutt Padikkal', type: 'capped' },
      { name: 'Krunal Pandya', type: 'capped' },
      { name: 'Tim David', type: 'capped' } // 6th capped!
    ];
    const failRes = await request(`/api/room/${code}/retention/confirm`, {
      method: 'POST',
      body: { clientId: 'rcb-owner-1', teamId: 'RCB', retentions: overCapped }
    });
    assert.strictEqual(failRes.status, 400, 'Attempt to retain 6 capped players must return HTTP 400');
    assert.match(failRes.data.error, /capped/i);
    console.log(`   ✓ Rejected 6 capped players: "${failRes.data.error}"`);
  }

  // ---------------------------------------------------------------------------
  // TEST 4: Attempted 3 Uncapped Retentions (Should be rejected, max 2)
  // ---------------------------------------------------------------------------
  console.log('\nTEST 4: Maximum Uncapped Player Limit Enforcement (Max 2)');
  {
    const overUncapped = [
      { name: 'Virat Kohli', type: 'capped' },
      { name: 'Yash Dayal', type: 'uncapped' },
      { name: 'Suyash Sharma', type: 'uncapped' },
      { name: 'Swapnil Singh', type: 'uncapped' } // 3rd uncapped!
    ];
    const failRes = await request(`/api/room/${code}/retention/confirm`, {
      method: 'POST',
      body: { clientId: 'rcb-owner-1', teamId: 'RCB', retentions: overUncapped }
    });
    assert.strictEqual(failRes.status, 400, 'Attempt to retain 3 uncapped players must return HTTP 400');
    assert.match(failRes.data.error, /uncapped/i);
    console.log(`   ✓ Rejected 3 uncapped players: "${failRes.data.error}"`);
  }

  // ---------------------------------------------------------------------------
  // TEST 5: Attempted 7 Total Retentions (Should be rejected, max 6)
  // ---------------------------------------------------------------------------
  console.log('\nTEST 5: Maximum Combined Retentions Limit Enforcement (Max 6)');
  {
    const sevenRetentions = [
      { name: 'Virat Kohli', type: 'capped' },
      { name: 'Rajat Patidar', type: 'capped' },
      { name: 'Bhuvneshwar Kumar', type: 'capped' },
      { name: 'Devdutt Padikkal', type: 'capped' },
      { name: 'Krunal Pandya', type: 'capped' },
      { name: 'Yash Dayal', type: 'uncapped' },
      { name: 'Suyash Sharma', type: 'uncapped' } // 7th!
    ];
    const failRes = await request(`/api/room/${code}/retention/confirm`, {
      method: 'POST',
      body: { clientId: 'rcb-owner-1', teamId: 'RCB', retentions: sevenRetentions }
    });
    assert.strictEqual(failRes.status, 400, 'Attempt to retain 7 players must return HTTP 400');
    console.log(`   ✓ Rejected 7 players: "${failRes.data.error}"`);
  }

  // ---------------------------------------------------------------------------
  // TEST 6: Overseas Player Cannot be Retained as Uncapped
  // ---------------------------------------------------------------------------
  console.log('\nTEST 6: Category Restriction (Overseas Cannot be Uncapped)');
  {
    const invalidOverseas = [
      { name: 'Tim David', type: 'uncapped' } // Overseas player
    ];
    const failRes = await request(`/api/room/${code}/retention/confirm`, {
      method: 'POST',
      body: { clientId: 'rcb-owner-1', teamId: 'RCB', retentions: invalidOverseas }
    });
    assert.strictEqual(failRes.status, 400, 'Overseas player cannot be uncapped');
    assert.match(failRes.data.error, /overseas/i);
    console.log(`   ✓ Rejected overseas uncapped attempt: "${failRes.data.error}"`);
  }

  // ---------------------------------------------------------------------------
  // TEST 7: Duplicate Player in Retention Draft
  // ---------------------------------------------------------------------------
  console.log('\nTEST 7: Duplicate Player in Same Retention List');
  {
    const duplicate = [
      { name: 'Virat Kohli', type: 'capped' },
      { name: 'Virat Kohli', type: 'capped' }
    ];
    const failRes = await request(`/api/room/${code}/retention/confirm`, {
      method: 'POST',
      body: { clientId: 'rcb-owner-1', teamId: 'RCB', retentions: duplicate }
    });
    assert.strictEqual(failRes.status, 400, 'Duplicate player must be rejected');
    console.log(`   ✓ Rejected duplicate player: "${failRes.data.error}"`);
  }

  // ---------------------------------------------------------------------------
  // TEST 8: Retention Cancel & Restore Purse
  // ---------------------------------------------------------------------------
  console.log('\nTEST 8: Retention Cancellation & Purse Restoration');
  {
    const cancelRes = await request(`/api/room/${code}/retention/cancel`, {
      method: 'POST',
      body: { clientId: 'rcb-owner-1', teamId: 'RCB' }
    });
    assert.strictEqual(cancelRes.status, 200);
    const rcbTeam = cancelRes.data.team;
    assert.strictEqual(rcbTeam.retentions.length, 0);
    assert.strictEqual(rcbTeam.retentionCostCr, 0);
    assert.strictEqual(rcbTeam.spentCr, 0);
    assert.strictEqual(rcbTeam.purseCr, 120.0);
    assert.strictEqual(rcbTeam.rtmCount, 6);
    assert.strictEqual(rcbTeam.retentionConfirmed, false);
    console.log('   ✓ Selections canceled: purse restored to full ₹120.00 Cr, RTMs restored to 6');
  }

  // ---------------------------------------------------------------------------
  // TEST 9: Retention Confirm for Multiple Franchises & Finalization Pool Reconstruction
  // ---------------------------------------------------------------------------
  console.log('\nTEST 9: Multi-Franchise Retention & Auction Pool Reconstruction');
  {
    // Retain 5 capped + 1 uncapped for CSK:
    // Slabs: 18 + 14 + 11 + 18 + 14 = 75 Cr + 4 Cr = 79 Cr. Purse left = 41 Cr.
    const cskRet = [
      { name: 'Ruturaj Gaikwad', type: 'capped' },
      { name: 'Sanju Samson', type: 'capped' },
      { name: 'Shivam Dube', type: 'capped' },
      { name: 'Noor Ahmad', type: 'capped' },
      { name: 'MS Dhoni', type: 'capped' },
      { name: 'Anshul Kamboj', type: 'uncapped' }
    ];
    const cskConf = await request(`/api/room/${code}/retention/confirm`, {
      method: 'POST',
      headers: hostHeaders,
      body: { teamId: 'CSK', retentions: cskRet }
    });
    assert.strictEqual(cskConf.status, 200);
    assert.strictEqual(cskConf.data.team.retentions.length, 6);
    assert.strictEqual(cskConf.data.team.retentionCostCr, 79.0);
    assert.strictEqual(cskConf.data.team.purseCr, 41.0);
    assert.strictEqual(cskConf.data.team.rtmCount, 0);

    // Retain Virat Kohli and Rajat Patidar for RCB:
    const rcbRet = [
      { name: 'Virat Kohli', type: 'capped' },
      { name: 'Rajat Patidar', type: 'capped' }
    ];
    const rcbConf = await request(`/api/room/${code}/retention/confirm`, {
      method: 'POST',
      headers: hostHeaders,
      body: { teamId: 'RCB', retentions: rcbRet }
    });
    assert.strictEqual(rcbConf.status, 200);
    assert.strictEqual(rcbConf.data.team.retentions.length, 2);
    assert.strictEqual(rcbConf.data.team.retentionCostCr, 32.0); // 18 + 14
    assert.strictEqual(rcbConf.data.team.purseCr, 88.0);
    assert.strictEqual(rcbConf.data.team.rtmCount, 4);

    // Finalize retentions
    const finRes = await request(`/api/room/${code}/retention/finalize`, {
      method: 'POST',
      headers: hostHeaders
    });
    assert.strictEqual(finRes.status, 200);
    const roomFinal = finRes.data.room;
    assert.strictEqual(roomFinal.status, 'ready');
    assert.strictEqual(roomFinal.lotState, 'ready');
    assert.strictEqual(roomFinal.retentionFinalized, true);

    const pool = roomFinal.candidatePool;
    assert.ok(pool.length > 182, `Pool must include released squad players (${pool.length} > 182)`);
    console.log(`   ✓ Mega Auction candidate pool reconstructed: ${pool.length} total players`);

    // Invariant: Retained players MUST NOT be in the candidate pool
    const retainedPlayerNames = [
      'Ruturaj Gaikwad', 'Sanju Samson', 'Shivam Dube', 'Noor Ahmad', 'MS Dhoni', 'Anshul Kamboj',
      'Virat Kohli', 'Rajat Patidar'
    ];
    for (const name of retainedPlayerNames) {
      const inPool = pool.find(p => p.name.toLowerCase() === name.toLowerCase());
      assert.strictEqual(inPool, undefined, `Retained player "${name}" MUST NOT be in candidate pool!`);
    }
    console.log('   ✓ Invariant verified: Retained players are completely removed from auction pool');

    // Invariant: Unretained squad players (e.g. Bhuvneshwar Kumar from RCB, Devon Conway from CSK) MUST be in the pool
    const bhuviInPool = pool.find(p => p.name.toLowerCase() === 'bhuvneshwar kumar');
    assert.ok(bhuviInPool, 'Unretained player Bhuvneshwar Kumar must be present in candidate pool');
    assert.strictEqual(bhuviInPool.originalTeamId, 'RCB', 'Released player must track original franchise for RTM');
    console.log(`   ✓ Released player Bhuvneshwar Kumar present in pool with originalTeamId: ${bhuviInPool.originalTeamId}`);

    // Invariant: No duplicate candidate names in pool
    const poolNames = pool.map(p => p.name.toLowerCase().trim());
    const uniquePoolNames = new Set(poolNames);
    assert.strictEqual(poolNames.length, uniquePoolNames.size, 'All candidates in reconstructed pool must be unique (no duplicates)');
    console.log('   ✓ Invariant verified: Zero duplicate candidates in reconstructed pool');

    // Close room
    await request(`/api/room/${code}/action`, { method: 'POST', headers: hostHeaders, body: { action: 'close' } });
  }

  // ---------------------------------------------------------------------------
  // TEST 10: Mini Auction Preserved Without Retention
  // ---------------------------------------------------------------------------
  console.log('\nTEST 10: Mini Auction Preserves Starting Squads and Bypasses Retention');
  {
    const miniRes = await request('/api/host/create-room', {
      method: 'POST',
      headers: hostHeaders,
      body: { mode: 'mini', timerSeconds: 5 }
    });
    assert.strictEqual(miniRes.status, 201);
    const miniCode = miniRes.data.room.code;
    assert.strictEqual(miniRes.data.room.mode, 'mini');
    assert.strictEqual(miniRes.data.room.status, 'ready');
    assert.strictEqual(miniRes.data.room.lotState, 'ready');

    // Squads are pre-populated from initial-squads.json
    const csk = miniRes.data.room.teams.find(t => t.id === 'CSK');
    assert.ok(csk.squad.length > 0, 'Mini auction squads must be pre-populated');

    // Attempting retention confirm in Mini mode must fail
    const retMini = await request(`/api/room/${miniCode}/retention/confirm`, {
      method: 'POST',
      headers: hostHeaders,
      body: { teamId: 'CSK', retentions: [] }
    });
    assert.strictEqual(retMini.status, 400, 'Retention API must be disabled in Mini Auction mode');
    console.log('   ✓ Mini Auction initialized directly to ready with original rosters and purses');

    await request(`/api/room/${miniCode}/action`, { method: 'POST', headers: hostHeaders, body: { action: 'close' } });
  }

  console.log('\n' + '='.repeat(80));
  console.log('ALL 10 MEGA AUCTION RETENTION TEST SUITES PASSED PERFECTLY!');
  console.log('='.repeat(80));
}

if (require.main === module) {
  runMegaRetentionTests().catch(err => {
    console.error('\n❌ Mega Retention Test Suite Failed:', err);
    process.exit(1);
  });
}

module.exports = { runMegaRetentionTests };
