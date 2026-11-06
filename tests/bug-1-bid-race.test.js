'use strict';

/**
 * Bug 1: Last-Second Bid Race Condition Test
 * 
 * This test REPRODUCES the race condition where processAuctionClock() executes
 * during the async gap in the bid handler, creating inconsistent room state.
 * 
 * **Expected Behavior on UNFIXED Code**: This test SHOULD FAIL, demonstrating:
 * - Room state corruption: lotDone=true AND currentBidCr is set
 * - Invariant violation: lotDone=true but bidEndsAt is not null
 * - Freeze condition: bid accepted but lot marked as done
 * 
 * **Expected Behavior on FIXED Code**: This test should PASS, demonstrating:
 * - Operations are serialized through operation queue
 * - No concurrent mutation of room state
 * - Consistent state: lotDone XOR (currentBidCr != null)
 */

const BASE = 'http://127.0.0.1:3333';
const OWNER_CODE = 'ipl2027owner';

// Helper to make API requests
async function request(route, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  const response = await fetch(`${BASE}${route}`, { 
    ...options, 
    headers, 
    body: options.body ? JSON.stringify(options.body) : undefined 
  });
  let data = {};
  try { 
    data = await response.json(); 
  } catch {}
  return { status: response.status, data };
}

// Helper to get current room state
async function getRoomState(code) {
  const res = await request(`/api/room/${code}/state`);
  return res.data.room;
}

// Helper to poll room state until condition is met or timeout
async function waitForCondition(code, condition, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const room = await getRoomState(code);
    if (condition(room)) {
      return room;
    }
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error('Timeout waiting for condition');
}

/**
 * Main test function that reproduces the race condition
 */
async function testLastSecondBidRace() {
  console.log('=' .repeat(80));
  console.log('BUG 1: Last-Second Bid Race Condition Test');
  console.log('=' .repeat(80));
  console.log();
  console.log('This test attempts to reproduce the race condition where:');
  console.log('1. A bid arrives at T-800ms (800ms before deadline)');
  console.log('2. Bid handler validates successfully and starts async processing');
  console.log('3. processAuctionClock() fires at T-650ms during the async gap');
  console.log('4. processAuctionClock sees expired deadline and settles the lot');
  console.log('5. Bid handler resumes and commits the bid');
  console.log('6. RESULT: Room has lotDone=true AND currentBidCr set (FREEZE)');
  console.log();
  
  // Step 1: Login as host
  console.log('Step 1: Logging in as host...');
  const login = await request('/api/host/login', { 
    method: 'POST', 
    body: { code: OWNER_CODE } 
  });
  if (login.status !== 200) {
    throw new Error('Login failed: ' + JSON.stringify(login.data));
  }
  const token = login.data.token;
  const headers = { 'x-host-token': token };
  console.log('✓ Host logged in');
  console.log();
  
  // Step 1.5: Close any existing room
  console.log('Step 1.5: Closing any existing rooms...');
  try {
    // Try to get the persisted room state
    const stateCheck = await request('/api/host/room-state', { method: 'GET', headers });
    if (stateCheck.status === 200 && stateCheck.data.room) {
      const code = stateCheck.data.room.code;
      console.log(`  Found existing room: ${code}`);
      await request(`/api/room/${code}/action`, { 
        method: 'POST', 
        headers, 
        body: { action: 'close' } 
      });
      console.log('✓ Closed existing room');
    } else {
      console.log('✓ No existing room found');
    }
  } catch (err) {
    console.log('✓ No existing room (or error checking)');
  }
  console.log();
  
  // Step 2: Create room with 2-second timer
  console.log('Step 2: Creating auction room with 2-second timer...');
  const room = await request('/api/host/create-room', { 
    method: 'POST', 
    headers, 
    body: { 
      mode: 'mega', 
      megaPurseCr: 120, 
      timerSeconds: 2,  // Short timer to make race easier to trigger
      maxSquadSize: 25, 
      maxOverseas: 8 
    } 
  });
  if (room.status !== 201) {
    throw new Error('Room creation failed: ' + JSON.stringify(room.data));
  }
  const code = room.data.room.code;
  console.log(`✓ Room created: ${code} (timer: 2s)`);
  console.log();
  
  // Step 3: Join two teams
  console.log('Step 3: Joining teams...');
  await request(`/api/room/${code}/join`, { 
    method: 'POST', 
    body: { clientId: 'test-csk', name: 'CSK Owner', teamId: 'CSK' } 
  });
  await request(`/api/room/${code}/join`, { 
    method: 'POST', 
    body: { clientId: 'test-mi', name: 'MI Owner', teamId: 'MI' } 
  });
  console.log('✓ CSK and MI joined');
  console.log();
  
  // Step 4: Start auction
  console.log('Step 4: Starting auction...');
  await request(`/api/room/${code}/action`, { 
    method: 'POST', 
    headers, 
    body: { action: 'start' } 
  });
  const stateAfterStart = await getRoomState(code);
  console.log(`✓ Auction started (timer: ${stateAfterStart.timerSeconds}s)`);
  console.log();
  
  // Step 5: Wait until ~800ms before deadline to place bid
  console.log('Step 5: Racing condition setup...');
  console.log('Waiting for ideal moment to trigger race condition...');
  
  // Get the current deadline
  let currentState = await getRoomState(code);
  if (!currentState.bidEndsAt) {
    throw new Error('No bidEndsAt set - auction may not have started properly');
  }
  
  // Calculate when to send the bid (T-800ms)
  const deadline = new Date(currentState.bidEndsAt).getTime();
  const now = Date.now();
  const timeUntilDeadline = deadline - now;
  const bidSendTime = Math.max(0, timeUntilDeadline - 800);  // Send at T-800ms
  
  console.log(`  Current time: ${new Date(now).toISOString()}`);
  console.log(`  Deadline: ${currentState.bidEndsAt}`);
  console.log(`  Time until deadline: ${timeUntilDeadline}ms`);
  console.log(`  Will send bid in: ${bidSendTime}ms (targeting T-800ms)`);
  console.log();
  
  // Wait until T-800ms
  if (bidSendTime > 0) {
    await new Promise(r => setTimeout(r, bidSendTime));
  }
  
  // Step 6: Place the bid
  console.log('Step 6: Placing bid at last second...');
  const bidStartTime = Date.now();
  console.log(`  Bid sent at: ${new Date(bidStartTime).toISOString()}`);
  
  // Send the bid request
  const bidPromise = request(`/api/room/${code}/bid`, { 
    method: 'POST', 
    body: { clientId: 'test-csk' } 
  });
  
  // Step 7: Let processAuctionClock have a chance to fire during the async gap
  // The server's processAuctionClock runs every 250ms, so we wait for it to fire
  console.log('  Waiting for processAuctionClock to potentially fire...');
  await new Promise(r => setTimeout(r, 300));  // Give time for race to occur
  
  const bidResponse = await bidPromise;
  const bidEndTime = Date.now();
  console.log(`  Bid response received at: ${new Date(bidEndTime).toISOString()}`);
  console.log(`  Bid took: ${bidEndTime - bidStartTime}ms`);
  console.log(`  Bid status: ${bidResponse.status}`);
  if (bidResponse.data.error) {
    console.log(`  Bid error: ${bidResponse.data.error}`);
  }
  console.log();
  
  // Step 8: Check room state for inconsistencies
  console.log('Step 7: Checking for race condition artifacts...');
  await new Promise(r => setTimeout(r, 500));  // Wait a bit for state to stabilize
  
  const finalState = await getRoomState(code);
  
  console.log('  Final room state:');
  console.log(`    lotDone: ${finalState.lotDone}`);
  console.log(`    currentBidCr: ${finalState.currentBidCr}`);
  console.log(`    bidEndsAt: ${finalState.bidEndsAt}`);
  console.log(`    currentBidTeamId: ${finalState.currentBidTeamId}`);
  console.log(`    auctionHistory length: ${finalState.auctionHistory.length}`);
  console.log();
  
  // Step 9: Validate invariants
  console.log('Step 8: Validating state invariants...');
  const failures = [];
  
  // Invariant 1: lotDone XOR (currentBidCr != null)
  // Either lot is done (no active bid) OR there's an active bid (lot not done)
  // NEVER both at the same time
  const hasBid = finalState.currentBidCr != null;
  const isDone = finalState.lotDone === true;
  
  if (isDone && hasBid) {
    failures.push('INVARIANT VIOLATION: lotDone=true AND currentBidCr is set (impossible state)');
    console.log('  ✗ FAIL: Lot marked done but has active bid');
  } else {
    console.log('  ✓ PASS: Lot state is consistent (done XOR has bid)');
  }
  
  // Invariant 2: If lotDone=true, then bidEndsAt should be null
  if (isDone && finalState.bidEndsAt != null) {
    failures.push('INVARIANT VIOLATION: lotDone=true but bidEndsAt is still set');
    console.log('  ✗ FAIL: Lot marked done but bidEndsAt not cleared');
  } else {
    console.log('  ✓ PASS: bidEndsAt consistent with lotDone');
  }
  
  // Invariant 3: If bid was accepted, it should appear in history OR be current
  if (bidResponse.status === 200) {
    const bidInHistory = finalState.currentBidHistory.some(b => b.teamId === 'CSK');
    const bidIsCurrent = finalState.currentBidTeamId === 'CSK';
    
    if (!bidInHistory && !bidIsCurrent) {
      failures.push('DATA LOSS: Bid accepted but not found in history or current state');
      console.log('  ✗ FAIL: Accepted bid disappeared');
    } else {
      console.log('  ✓ PASS: Accepted bid appears in state');
    }
  }
  
  // Invariant 4: Room should not be frozen (next operations should work)
  // Try to get state again - should succeed
  try {
    await getRoomState(code);
    console.log('  ✓ PASS: Room state can still be queried (not frozen)');
  } catch (err) {
    failures.push('FREEZE DETECTED: Cannot query room state after race');
    console.log('  ✗ FAIL: Room appears frozen');
  }
  
  console.log();
  
  // Step 10: Document the counterexample
  if (failures.length > 0) {
    console.log('RACE CONDITION DETECTED!');
    console.log('=' .repeat(80));
    console.log('Counterexample found - Bug successfully reproduced:');
    console.log();
    failures.forEach((f, i) => {
      console.log(`  ${i + 1}. ${f}`);
    });
    console.log();
    console.log('This confirms the bug exists in the unfixed code.');
    console.log('The room entered an impossible state where:');
    console.log(`  - lotDone = ${finalState.lotDone}`);
    console.log(`  - currentBidCr = ${finalState.currentBidCr}`);
    console.log(`  - bidEndsAt = ${finalState.bidEndsAt}`);
    console.log();
    console.log('Root Cause: processAuctionClock() executed during async gap in bid handler,');
    console.log('settling the lot before the bid could be committed.');
    console.log('=' .repeat(80));
  } else {
    console.log('NO RACE CONDITION DETECTED');
    console.log('=' .repeat(80));
    console.log('All invariants passed. Either:');
    console.log('  1. The bug has been fixed (operation queue prevents race)');
    console.log('  2. The race condition did not occur this time (timing-dependent)');
    console.log('  3. The test setup needs adjustment to reliably trigger the race');
    console.log('=' .repeat(80));
  }
  console.log();
  
  // Cleanup: Close the room
  console.log('Cleanup: Closing auction room...');
  await request(`/api/room/${code}/action`, { 
    method: 'POST', 
    headers, 
    body: { action: 'close' } 
  });
  console.log('✓ Room closed');
  console.log();
  
  // Return test result
  return {
    passed: failures.length === 0,
    failures,
    counterexample: failures.length > 0 ? {
      lotDone: finalState.lotDone,
      currentBidCr: finalState.currentBidCr,
      bidEndsAt: finalState.bidEndsAt,
      currentBidTeamId: finalState.currentBidTeamId,
      bidStatus: bidResponse.status,
      bidError: bidResponse.data.error
    } : null
  };
}

// Run the tests
(async () => {
  console.log();
  console.log('Starting Bug 1 Race Condition Tests...');
  console.log('Make sure the server is running on http://127.0.0.1:3333');
  console.log();
  
  const results = [];
  
  try {
    // Test 1.1: Last-Second Bid Race
    console.log('Running Test 1.1: Last-Second Bid Race...');
    console.log();
    const result1 = await testLastSecondBidRace();
    results.push({ test: 'Test 1.1: Last-Second Bid Race', ...result1 });
    
    // Wait a bit between tests
    await new Promise(r => setTimeout(r, 1000));
    
    // Test 1.2: Concurrent Settlement Race
    console.log('Running Test 1.2: Concurrent Settlement Race...');
    console.log();
    const result2 = await testConcurrentSettlementRace();
    results.push({ test: 'Test 1.2: Concurrent Settlement Race', ...result2 });
    
    // Summary
    console.log();
    console.log('=' .repeat(80));
    console.log('TEST SUITE SUMMARY');
    console.log('=' .repeat(80));
    console.log();
    
    const allPassed = results.every(r => r.passed);
    let failureCount = 0;
    
    results.forEach(r => {
      if (r.passed) {
        console.log(`✓ ${r.test}: PASSED`);
      } else {
        console.log(`✗ ${r.test}: FAILED`);
        failureCount++;
        if (r.counterexample) {
          console.log('  Counterexample:');
          console.log('  ' + JSON.stringify(r.counterexample, null, 2).split('\n').join('\n  '));
        }
      }
    });
    
    console.log();
    console.log(`Total: ${results.length} tests, ${results.length - failureCount} passed, ${failureCount} failed`);
    console.log('=' .repeat(80));
    console.log();
    
    if (allPassed) {
      console.log('ALL TESTS PASSED ✓');
      console.log('No race conditions detected - either bugs are fixed or conditions not met');
      process.exit(0);
    } else {
      console.log('TESTS FAILED ✗');
      console.log('Race conditions detected - bugs confirmed on unfixed code');
      process.exit(1);
    }
  } catch (err) {
    console.error('TEST SUITE ERROR:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
})();


/**
 * Bug 1.2: Concurrent Settlement Race Test
 * 
 * This test REPRODUCES the race condition where two concurrent settleSold calls
 * can execute simultaneously without synchronization, causing duplicate settlements.
 * 
 * **Expected Behavior on UNFIXED Code**: This test SHOULD FAIL, demonstrating:
 * - Duplicate entries in room.auctionHistory
 * - processedCount incremented twice
 * - Possible crash or inconsistent state
 * 
 * **Expected Behavior on FIXED Code**: This test should PASS, demonstrating:
 * - Settlement operations are serialized through operation queue
 * - No duplicate history entries
 * - processedCount incremented exactly once
 */
async function testConcurrentSettlementRace() {
  console.log('=' .repeat(80));
  console.log('BUG 1.2: Concurrent Settlement Race Condition Test');
  console.log('=' .repeat(80));
  console.log();
  console.log('This test attempts to reproduce the race condition where:');
  console.log('1. Timer expires with an active bid (currentBidCr=2.0)');
  console.log('2. processAuctionClock fires and calls settleSold');
  console.log('3. Host simultaneously clicks "Mark as Sold" button');
  console.log('4. Both settleSold calls execute without synchronization');
  console.log('5. RESULT: Duplicate entries in auctionHistory, incorrect processedCount');
  console.log();
  
  // Step 1: Login as host
  console.log('Step 1: Logging in as host...');
  const login = await request('/api/host/login', { 
    method: 'POST', 
    body: { code: OWNER_CODE } 
  });
  if (login.status !== 200) {
    throw new Error('Login failed: ' + JSON.stringify(login.data));
  }
  const token = login.data.token;
  const headers = { 'x-host-token': token };
  console.log('✓ Host logged in');
  console.log();
  
  // Step 2: Close any existing room
  console.log('Step 2: Closing any existing rooms...');
  try {
    const stateCheck = await request('/api/host/room-state', { method: 'GET', headers });
    if (stateCheck.status === 200 && stateCheck.data.room) {
      const code = stateCheck.data.room.code;
      await request(`/api/room/${code}/action`, { 
        method: 'POST', 
        headers, 
        body: { action: 'close' } 
      });
      console.log('✓ Closed existing room');
    } else {
      console.log('✓ No existing room found');
    }
  } catch (err) {
    console.log('✓ No existing room');
  }
  console.log();
  
  // Step 3: Create room with short timer
  console.log('Step 3: Creating auction room...');
  const room = await request('/api/host/create-room', { 
    method: 'POST', 
    headers, 
    body: { 
      mode: 'mega', 
      megaPurseCr: 120, 
      timerSeconds: 2,
      maxSquadSize: 25, 
      maxOverseas: 8 
    } 
  });
  if (room.status !== 201) {
    throw new Error('Room creation failed: ' + JSON.stringify(room.data));
  }
  const code = room.data.room.code;
  console.log(`✓ Room created: ${code}`);
  console.log();
  
  // Step 4: Join a team
  console.log('Step 4: Joining team...');
  await request(`/api/room/${code}/join`, { 
    method: 'POST', 
    body: { clientId: 'test-csk', name: 'CSK Owner', teamId: 'CSK' } 
  });
  console.log('✓ CSK joined');
  console.log();
  
  // Step 5: Start auction
  console.log('Step 5: Starting auction...');
  await request(`/api/room/${code}/action`, { 
    method: 'POST', 
    headers, 
    body: { action: 'start' } 
  });
  console.log('✓ Auction started');
  console.log();
  
  // Step 6: Place a bid to create active bid state
  console.log('Step 6: Placing bid...');
  const bidRes = await request(`/api/room/${code}/bid`, { 
    method: 'POST', 
    body: { clientId: 'test-csk' } 
  });
  if (bidRes.status !== 200) {
    throw new Error('Bid failed: ' + JSON.stringify(bidRes.data));
  }
  console.log('✓ Bid placed (currentBidCr should be 2.0)');
  console.log();
  
  // Step 7: Get initial state before race
  const stateBefore = await getRoomState(code);
  console.log('Step 7: State before concurrent settlements:');
  console.log(`  currentBidCr: ${stateBefore.currentBidCr}`);
  console.log(`  processedCount: ${stateBefore.processedCount}`);
  console.log(`  auctionHistory length: ${stateBefore.auctionHistory.length}`);
  console.log(`  currentIndex: ${stateBefore.currentIndex}`);
  console.log();
  
  // Step 8: Wait for timer to expire (let it get very close)
  console.log('Step 8: Waiting for timer to expire...');
  if (stateBefore.bidEndsAt) {
    const deadline = new Date(stateBefore.bidEndsAt).getTime();
    const now = Date.now();
    const waitTime = Math.max(0, deadline - now + 100);  // Wait until after deadline
    console.log(`  Waiting ${waitTime}ms for timer to expire...`);
    await new Promise(r => setTimeout(r, waitTime));
  }
  console.log('✓ Timer should be expired now');
  console.log();
  
  // Step 9: Trigger concurrent settlements
  console.log('Step 9: Triggering concurrent settlements...');
  console.log('  Sending two simultaneous "mark as sold" requests...');
  
  // Send both requests simultaneously
  const [settle1, settle2] = await Promise.all([
    request(`/api/room/${code}/action`, { 
      method: 'POST', 
      headers, 
      body: { action: 'sold' } 
    }),
    request(`/api/room/${code}/action`, { 
      method: 'POST', 
      headers, 
      body: { action: 'sold' } 
    })
  ]);
  
  console.log(`  Settlement 1 status: ${settle1.status}`);
  console.log(`  Settlement 2 status: ${settle2.status}`);
  console.log();
  
  // Step 10: Wait for state to stabilize and check for race artifacts
  console.log('Step 10: Checking for race condition artifacts...');
  await new Promise(r => setTimeout(r, 500));
  
  const stateAfter = await getRoomState(code);
  
  console.log('  Final room state:');
  console.log(`    processedCount: ${stateAfter.processedCount}`);
  console.log(`    auctionHistory length: ${stateAfter.auctionHistory.length}`);
  console.log(`    currentIndex: ${stateAfter.currentIndex}`);
  console.log();
  
  // Step 11: Validate for duplicate settlements
  console.log('Step 11: Validating for duplicate settlements...');
  const failures = [];
  
  // Calculate expected values
  const expectedProcessedCount = stateBefore.processedCount + 1;  // Should increment once
  const expectedHistoryLength = stateBefore.auctionHistory.length + 1;  // Should add one entry
  
  // Check processedCount - this is the key indicator of duplicate settlements
  const processedDelta = stateAfter.processedCount - stateBefore.processedCount;
  if (processedDelta !== 1) {
    failures.push(
      `processedCount mismatch: expected increment of 1, got increment of ${processedDelta} ` +
      `(${stateBefore.processedCount} → ${stateAfter.processedCount})`
    );
    console.log(`  ✗ FAIL: processedCount incremented ${processedDelta} times instead of 1`);
  } else {
    console.log('  ✓ PASS: processedCount incremented exactly once');
  }
  
  // Check auction history length - should match processedCount
  const historyDelta = stateAfter.auctionHistory.length - stateBefore.auctionHistory.length;
  if (historyDelta !== 1) {
    failures.push(
      `auctionHistory length mismatch: expected 1 new entry, got ${historyDelta} new entries ` +
      `(${stateBefore.auctionHistory.length} → ${stateAfter.auctionHistory.length})`
    );
    console.log(`  ✗ FAIL: auctionHistory added ${historyDelta} entries instead of 1`);
  } else {
    console.log('  ✓ PASS: auctionHistory has exactly one new entry');
  }
  
  // Check for duplicate entries (same playerId settled multiple times)
  const newEntries = stateAfter.auctionHistory.slice(stateBefore.auctionHistory.length);
  const playerIds = newEntries.map(e => e.playerId);
  const uniquePlayerIds = [...new Set(playerIds)];
  
  if (playerIds.length !== uniquePlayerIds.length) {
    failures.push(
      `Duplicate settlements detected: ${playerIds.length} entries for ${uniquePlayerIds.length} unique players`
    );
    console.log('  ✗ FAIL: Same player settled multiple times');
  } else {
    console.log('  ✓ PASS: No duplicate player settlements');
  }
  
  console.log();
  
  // Step 12: Document the counterexample
  if (failures.length > 0) {
    console.log('CONCURRENT SETTLEMENT RACE DETECTED!');
    console.log('=' .repeat(80));
    console.log('Counterexample found - Bug successfully reproduced:');
    console.log();
    failures.forEach((f, i) => {
      console.log(`  ${i + 1}. ${f}`);
    });
    console.log();
    console.log('This confirms the bug exists in the unfixed code.');
    console.log('Multiple concurrent settlement calls executed without synchronization:');
    console.log(`  - processedCount: ${stateBefore.processedCount} → ${stateAfter.processedCount}`);
    console.log(`  - auctionHistory: ${stateBefore.auctionHistory.length} → ${stateAfter.auctionHistory.length} entries`);
    console.log(`  - currentIndex: ${stateBefore.currentIndex} → ${stateAfter.currentIndex}`);
    console.log();
    console.log('Root Cause: No synchronization between concurrent settleSold calls.');
    console.log('=' .repeat(80));
  } else {
    console.log('NO RACE CONDITION DETECTED');
    console.log('=' .repeat(80));
    console.log('All invariants passed. Either:');
    console.log('  1. The bug has been fixed (operation queue serializes settlements)');
    console.log('  2. The race condition did not occur this time (timing-dependent)');
    console.log('  3. The server already has protection against concurrent settlements');
    console.log('=' .repeat(80));
  }
  console.log();
  
  // Cleanup
  console.log('Cleanup: Closing auction room...');
  await request(`/api/room/${code}/action`, { 
    method: 'POST', 
    headers, 
    body: { action: 'close' } 
  });
  console.log('✓ Room closed');
  console.log();
  
  return {
    passed: failures.length === 0,
    failures,
    counterexample: failures.length > 0 ? {
      processedCountBefore: stateBefore.processedCount,
      processedCountAfter: stateAfter.processedCount,
      processedCountDelta: stateAfter.processedCount - stateBefore.processedCount,
      historyLengthBefore: stateBefore.auctionHistory.length,
      historyLengthAfter: stateAfter.auctionHistory.length,
      historyLengthDelta: stateAfter.auctionHistory.length - stateBefore.auctionHistory.length,
      newEntries
    } : null
  };
}

/**
 * TEST DOCUMENTATION
 * ==================
 * 
 * **Purpose**: These tests attempt to reproduce Bug 1 - Last-Second Bid Race Conditions
 * 
 * **Test 1.1 - Last-Second Bid Race**:
 * When a bid arrives close to the deadline (within ~1 second), there's a race between:
 * - The bid handler processing the bid (which has async boundaries at readBody and persistAndTouch)
 * - The processAuctionClock setInterval (fires every 250ms) checking if the deadline expired
 * 
 * If processAuctionClock fires during the async gap in the bid handler, it can settle the lot
 * (mark lotDone=true) before the bid commits, resulting in corrupted state where:
 * - lotDone = true (lot finished)
 * - currentBidCr is set (active bid exists)
 * - bidEndsAt is set (timer running)
 * 
 * This is logically impossible and causes the auction to freeze.
 * 
 * **Test 1.2 - Concurrent Settlement Race**:
 * When the timer expires with an active bid, two settlement operations can execute concurrently:
 * - processAuctionClock calls settleSold (automatic settlement)
 * - Host clicks "Mark as Sold" button (manual settlement)
 * 
 * Without synchronization, both calls can execute simultaneously, resulting in:
 * - Duplicate entries in room.auctionHistory
 * - processedCount incremented twice instead of once
 * - currentIndex advanced twice, potentially skipping a player
 * 
 * **How to Reproduce Reliably**:
 * The race conditions are timing-dependent and may not trigger on every run. To increase
 * the probability of triggering them:
 * 
 * 1. **Add artificial delay**: Modify server.js to add delays in critical sections
 * 2. **Run under load**: Execute tests multiple times in parallel
 * 3. **Adjust timer**: Use shorter timers to make race windows larger
 * 
 * **Expected Results**:
 * 
 * ON UNFIXED CODE (without operation queue):
 * - Tests should FAIL with invariant violations
 * - Counterexamples showing corrupted state and duplicate operations
 * 
 * ON FIXED CODE (with operation queue):
 * - Tests should PASS with all invariants satisfied
 * - Operations are serialized, no concurrent mutations
 * - State remains consistent
 */
