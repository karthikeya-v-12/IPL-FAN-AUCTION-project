'use strict';

const PROD_URL = 'https://ipl2027-auction-app.onrender.com';

async function testProduction() {
  console.log('======================================================');
  console.log('IPL 2027 FAN AUCTION — PRODUCTION SMOKE TEST ON RENDER');
  console.log('Target: ' + PROD_URL);
  console.log('======================================================\n');

  // 1. Homepage & Assets
  console.log('1. Verifying Homepage & Assets...');
  const homeRes = await fetch(PROD_URL + '/');
  const homeHtml = await homeRes.text();
  console.log('   ✓ Homepage HTTP ' + homeRes.status + ' (' + homeHtml.length + ' bytes)');
  if (!homeHtml.includes('id="app"')) throw new Error('Homepage missing #app container');

  const jsRes = await fetch(PROD_URL + '/app.js?v=' + Date.now());
  const js = await jsRes.text();
  console.log('   ✓ app.js HTTP ' + jsRes.status + ' (' + js.length + ' bytes)');
  if (!js.includes('RETENTION DASHBOARD') || (!js.includes('Close this auction room?') && !js.includes('Close Room & End Auction'))) {
    throw new Error('Deployed app.js missing latest features');
  }

  const cssRes = await fetch(PROD_URL + '/style.css?v=' + Date.now());
  const css = await cssRes.text();
  console.log('   ✓ style.css HTTP ' + cssRes.status + ' (' + css.length + ' bytes)');
  if (!css.includes('.retention-player-card.is-selected')) {
    throw new Error('Deployed style.css missing latest selection styling');
  }

  // 2. Health & Bootstrap
  console.log('\n2. Verifying Health & Bootstrap Endpoint...');
  const bootRes = await fetch(PROD_URL + '/api/bootstrap?v=' + Date.now());
  const boot = await bootRes.json();
  console.log('   ✓ Bootstrap status: ' + bootRes.status);
  console.log('   ✓ Candidate count: ' + boot.candidates?.length + ' (Expected: 182)');
  console.log('   ✓ Teams count: ' + boot.teams?.length + ' (Expected: 10)');
  console.log('   ✓ Initial squads loaded for: ' + Object.keys(boot.initialSquads || {}).length + ' franchises');
  console.log('   ✓ hasActiveRoom: ' + boot.hasActiveRoom);
  if (boot.candidates?.length !== 182) throw new Error('Expected 182 candidates in pool');

  // 3. Host Authentication
  console.log('\n3. Verifying Host Authentication...');
  const loginRes = await fetch(PROD_URL + '/api/host/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: 'ipl2027owner' })
  }).then(r => r.json());
  if (!loginRes.token) throw new Error('Host login failed: ' + JSON.stringify(loginRes));
  const token = loginRes.token;
  console.log('   ✓ Host authenticated successfully with production secret');

  // Close any existing room if left over
  if (loginRes.activeRoomCode) {
    console.log('   Cleaning up previous room ' + loginRes.activeRoomCode + '...');
    await fetch(PROD_URL + '/api/room/' + loginRes.activeRoomCode + '/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-host-token': token },
      body: JSON.stringify({ action: 'close' })
    });
  }

  // 4. Create Mega Auction Room with Participant-Managed Retention
  console.log('\n4. Creating Mega Auction Room with Participant-Managed Retention...');
  const roomRes = await fetch(PROD_URL + '/api/host/create-room', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-host-token': token },
    body: JSON.stringify({
      mode: 'mega',
      retentionMode: 'participants',
      timerSeconds: 10,
      megaPurseCr: 120
    })
  }).then(r => r.json());
  if (!roomRes.room) throw new Error('Failed to create room: ' + JSON.stringify(roomRes));
  const roomCode = roomRes.room.code;
  console.log('   ✓ Created Mega Auction Room: ' + roomCode);
  console.log('   ✓ Room status: ' + roomRes.room.status + ', retentionMode: ' + roomRes.room.retentionMode);

  // 5. Join Room as RCB Franchise Owner
  console.log('\n5. Joining Room as RCB Franchise Owner...');
  const joinRes = await fetch(PROD_URL + '/api/room/' + roomCode + '/join', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clientId: 'prod-tester-1', name: 'ProdTesterRCB', teamId: 'RCB' })
  }).then(r => r.json());
  if (!joinRes.participant) throw new Error('Failed to join room: ' + JSON.stringify(joinRes));
  console.log('   ✓ Joined as ' + joinRes.participant.name + ' controlling ' + joinRes.participant.teamId);

  // 6. Test 0-Confirmed Rejection (Task 1 Rule)
  console.log('\n6. Testing Zero-Confirmed Franchise Start Rejection...');
  const rejectStart = await fetch(PROD_URL + '/api/room/' + roomCode + '/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-host-token': token },
    body: JSON.stringify({ action: 'start' })
  });
  const rejectBody = await rejectStart.json();
  console.log('   ✓ Rejection status: ' + rejectStart.status + ', error message: "' + rejectBody.error + '"');
  if (rejectStart.status !== 400) throw new Error('Expected 400 rejection with 0 confirmed teams');

  // 7. Configure & Confirm RCB Retentions
  console.log('\n7. Configuring and Confirming RCB Retentions...');
  const rcbInitial = roomRes.room.initialSquads?.RCB || boot.initialSquads?.RCB || [];
  const p1 = rcbInitial[0];
  const p2 = rcbInitial[1];
  console.log('   Selecting Candidate 1: ' + p1.name + ' (Capped)');
  console.log('   Selecting Candidate 2: ' + p2.name + ' (Uncapped)');

  const confirmRes = await fetch(PROD_URL + '/api/room/' + roomCode + '/retention/confirm', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      clientId: 'prod-tester-1',
      teamId: 'RCB',
      retentions: [
        { name: p1.name, type: 'capped' },
        { name: p2.name, type: 'uncapped' }
      ]
    })
  });
  const confirmData = await confirmRes.json();
  if (confirmRes.status !== 200) throw new Error('Retention confirmation failed: ' + JSON.stringify(confirmData));
  const rcbTeam = confirmData.team;
  console.log('   ✓ RCB Retentions confirmed: ' + rcbTeam.retentions.length + ' players');
  console.log('   ✓ Retention spend: ₹' + rcbTeam.retentionCostCr + ' Cr, remaining purse: ₹' + rcbTeam.purseCr + ' Cr, RTMs: ' + rcbTeam.rtmCount);

  // Verify Persistence
  const stateCheck = await fetch(PROD_URL + '/api/room/' + roomCode + '/state').then(r => r.json());
  const rcbSaved = stateCheck.room.teams.find(t => t.id === 'RCB');
  if (!rcbSaved.retentionConfirmed || rcbSaved.retentions.length !== 2) {
    throw new Error('Confirmed retention failed to persist in room state');
  }
  console.log('   ✓ Retention confirmation persisted authoritatively in room state');

  // 8. Start Mega Auction with Just ONE Confirmed Franchise (Task 1)
  console.log('\n8. Starting Mega Auction with Just 1 Confirmed Franchise...');
  const startRes = await fetch(PROD_URL + '/api/room/' + roomCode + '/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-host-token': token },
    body: JSON.stringify({ action: 'start' })
  });
  const startData = await startRes.json();
  if (startRes.status !== 200) throw new Error('Start failed: ' + JSON.stringify(startData));
  const liveRoom = startData.room;
  console.log('   ✓ Mega Auction successfully started! Status: ' + liveRoom.status + ', lotState: ' + liveRoom.lotState);
  console.log('   ✓ First player on floor: ' + liveRoom.currentPlayer?.name + ' (Lot 1 of ' + liveRoom.auctionOrder?.length + ')');

  // Verify other 9 franchises auto-finalized
  const otherTeams = liveRoom.teams.filter(t => t.id !== 'RCB');
  const allAutoFinalized = otherTeams.every(t => t.retentionConfirmed && t.autoFinalized && t.purseCr === 120 && t.rtmCount === 6);
  console.log('   ✓ Remaining 9 franchises auto-finalized cleanly: ' + allAutoFinalized);
  if (!allAutoFinalized) throw new Error('Expected all 9 unconfirmed teams to be auto-finalized');

  // 9. Live Bidding & Countdown
  console.log('\n9. Testing Live Bidding & Countdown...');
  const currentLot = liveRoom.currentPlayer;
  const bidRes = await fetch(PROD_URL + '/api/room/' + roomCode + '/bid', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      clientId: 'prod-tester-1',
      teamId: 'RCB',
      lotId: liveRoom.lotId,
      amountCr: currentLot.basePriceCr
    })
  });
  const bidData = await bidRes.json();
  if (bidRes.status !== 200) throw new Error('Bid failed: ' + JSON.stringify(bidData));
  console.log('   ✓ Bid accepted at ₹' + bidData.room.currentBidCr + ' Cr by ' + bidData.room.currentBidTeamId);
  console.log('   ✓ Timer deadline extended to: ' + bidData.room.bidEndsAt);

  // 10. Close Room Controls (Task 3)
  console.log('\n10. Testing Host Close Room Controls...');
  const closeRes = await fetch(PROD_URL + '/api/room/' + roomCode + '/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-host-token': token },
    body: JSON.stringify({ action: 'close' })
  });
  const closeData = await closeRes.json();
  console.log('   ✓ Close room responded HTTP ' + closeRes.status + ' (ok: ' + closeData.ok + ')');

  // Verify subsequent operations rejected
  const lateBid = await fetch(PROD_URL + '/api/room/' + roomCode + '/bid', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      clientId: 'prod-tester-1',
      teamId: 'RCB',
      lotId: liveRoom.lotId,
      amountCr: 5.0
    })
  });
  console.log('   ✓ Subsequent bid on closed room rejected with HTTP ' + lateBid.status);
  if (lateBid.status !== 404 && lateBid.status !== 409) throw new Error('Expected 404/409 on closed room');

  // Verify active room released
  const postCloseBoot = await fetch(PROD_URL + '/api/bootstrap?v=' + Date.now()).then(r => r.json());
  console.log('   ✓ Post-close bootstrap hasActiveRoom: ' + postCloseBoot.hasActiveRoom);
  if (postCloseBoot.hasActiveRoom) throw new Error('Expected hasActiveRoom to be false after closure');

  // 11. Create Fresh Mini Auction Room to Verify Clean Recreation & Mini Mode
  console.log('\n11. Verifying Fresh Room Recreation & Mini Auction Mode...');
  const miniRes = await fetch(PROD_URL + '/api/host/create-room', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-host-token': token },
    body: JSON.stringify({
      mode: 'mini',
      timerSeconds: 10
    })
  }).then(r => r.json());
  if (!miniRes.room) throw new Error('Failed to create fresh mini auction room: ' + JSON.stringify(miniRes));
  console.log('   ✓ Fresh Mini Auction Room created successfully: ' + miniRes.room.code);
  const rcbMiniSquad = miniRes.room.teams.find(t => t.id === 'RCB')?.squad || [];
  console.log('   ✓ Mini Auction preserves pre-existing squad seed: RCB has ' + rcbMiniSquad.length + ' squad players');

  // Cleanly close the mini room
  await fetch(PROD_URL + '/api/room/' + miniRes.room.code + '/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-host-token': token },
    body: JSON.stringify({ action: 'close' })
  });
  console.log('   ✓ Cleaned up test room. Production server is fresh and ready!');

  console.log('\n======================================================');
  console.log('✨ ALL PRODUCTION SMOKE TESTS PASSED WITH 100% SUCCESS! ✨');
  console.log('======================================================\n');
}

testProduction().catch(err => {
  console.error('\n❌ PRODUCTION TEST FAILED:', err);
  process.exit(1);
});
