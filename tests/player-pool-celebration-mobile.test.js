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

async function runTests() {
  console.log('--- STARTING PLAYER POOL, CELEBRATION & MOBILE SUITE ---');

  // Test 1: Bootstrap returns 182 candidates
  console.log('1. Checking /api/bootstrap...');
  const boot = await request('/api/bootstrap');
  assert.strictEqual(boot.status, 200);
  assert.strictEqual(Array.isArray(boot.json.candidates), true);
  assert.strictEqual(boot.json.candidates.length, 182, 'Expected baseline 182 candidates');
  console.log('✓ Bootstrap returned exactly 182 candidates.');

  // Test 1b: Unauthenticated request to /api/admin/players is rejected
  console.log('1b. Verifying unauthenticated access to /api/admin/players returns 401...');
  const unauthRes = await request('/api/admin/players');
  assert.strictEqual(unauthRes.status, 401);
  console.log('✓ Unauthenticated access safely rejected with HTTP 401.');

  // Login as host
  console.log('Logging in as host...');
  const authRes = await request('/api/host/login', {
    method: 'POST',
    body: { code: 'ipl2027owner' }
  });
  assert.strictEqual(authRes.status, 200);
  const ownerToken = authRes.json.token;
  const hostHeaders = { 'x-host-token': ownerToken, 'x-owner-token': ownerToken };

  // Test 2: Admin list candidates
  console.log('2. Checking GET /api/admin/players (with host token)...');
  const list = await request('/api/admin/players', { headers: hostHeaders });
  assert.strictEqual(list.status, 200);
  assert.strictEqual(list.json.ok, true);
  assert.strictEqual(list.json.count, 182);
  console.log('✓ GET /api/admin/players verified (count: 182).');

  // Test 3: Upload player image
  console.log('3. Testing POST /api/admin/players/upload-image...');
  // 1x1 transparent PNG base64
  const testPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const uploadRes = await request('/api/admin/players/upload-image', {
    method: 'POST',
    headers: hostHeaders,
    body: { filename: 'test-star.png', base64: testPng }
  });
  assert.strictEqual(uploadRes.status, 200);
  assert.strictEqual(uploadRes.json.ok, true);
  assert(uploadRes.json.imageUrl.startsWith('/player-images/'));
  console.log('✓ Player image upload verified:', uploadRes.json.imageUrl);

  // Test 4: Create new candidate
  console.log('4. Testing POST /api/admin/players (Create)...');
  const createRes = await request('/api/admin/players', {
    method: 'POST',
    headers: hostHeaders,
    body: {
      name: 'Sahith Super Striker',
      role: 'Fast-Bowling All-Rounder',
      roleBucket: 'All-rounder',
      origin: 'Domestic',
      cappedStatus: 'Capped',
      basePriceCr: 2.00,
      auctionSet: 'AL1',
      image: uploadRes.json.imageUrl,
      includeInMini: true,
      includeInMega: true
    }
  });
  assert.strictEqual(createRes.status, 201);
  assert.strictEqual(createRes.json.ok, true);
  const createdPlayer = createRes.json.player;
  assert.strictEqual(createdPlayer.name, 'Sahith Super Striker');
  assert.strictEqual(createdPlayer.basePriceCr, 2.00);
  console.log('✓ Candidate created with ID:', createdPlayer.id);

  // Verify count incremented to 183
  const countAfterAdd = await request('/api/admin/players', { headers: hostHeaders });
  assert.strictEqual(countAfterAdd.json.count, 183);
  console.log('✓ Candidate pool count dynamically updated to 183.');

  // Test 5: Edit candidate
  console.log('5. Testing PUT /api/admin/players/:id (Edit)...');
  const editRes = await request(`/api/admin/players/${encodeURIComponent(createdPlayer.id)}`, {
    method: 'PUT',
    headers: hostHeaders,
    body: {
      basePriceCr: 1.50,
      role: 'Top-order Batter',
      roleBucket: 'Batter'
    }
  });
  assert.strictEqual(editRes.status, 200);
  assert.strictEqual(editRes.json.player.basePriceCr, 1.50);
  assert.strictEqual(editRes.json.player.roleBucket, 'Batter');
  console.log('✓ Candidate edit verified.');

  // Test 6: Toggle exclusion
  console.log('6. Testing POST /api/admin/players/:id/toggle-exclusion...');
  const exclRes = await request(`/api/admin/players/${encodeURIComponent(createdPlayer.id)}/toggle-exclusion`, {
    method: 'POST',
    headers: hostHeaders
  });
  assert.strictEqual(exclRes.status, 200);
  assert.strictEqual(exclRes.json.player.excluded, true);
  console.log('✓ Candidate exclusion toggled to TRUE.');

  // Test 7: Pool eligibility
  console.log('7. Testing POST /api/admin/players/:id/pool-eligibility...');
  const eligRes = await request(`/api/admin/players/${encodeURIComponent(createdPlayer.id)}/pool-eligibility`, {
    method: 'POST',
    headers: hostHeaders,
    body: { includeInMini: false, includeInMega: true }
  });
  assert.strictEqual(eligRes.status, 200);
  assert.strictEqual(eligRes.json.player.includeInMini, false);
  assert.strictEqual(eligRes.json.player.includeInMega, true);
  console.log('✓ Candidate pool eligibility updated.');

  // Test 8: Export backup
  console.log('8. Testing GET /api/admin/players/export...');
  const exportRes = await request(`/api/admin/players/export?token=${ownerToken}`);
  assert.strictEqual(exportRes.status, 200);
  assert(exportRes.headers['content-disposition'].includes('candidates-backup'));
  assert(exportRes.data.includes('Sahith Super Striker'));
  console.log('✓ Candidate backup export verified.');

  // Test 9: Delete candidate (Restores candidate count invariant to 182)
  console.log('9. Testing DELETE /api/admin/players/:id...');
  const delRes = await request(`/api/admin/players/${encodeURIComponent(createdPlayer.id)}`, {
    method: 'DELETE',
    headers: hostHeaders
  });
  assert.strictEqual(delRes.status, 200);
  assert.strictEqual(delRes.json.ok, true);

  const countAfterDel = await request('/api/admin/players', { headers: hostHeaders });
  assert.strictEqual(countAfterDel.json.count, 182, 'Must restore count invariant to exactly 182');
  console.log('✓ Candidate deleted successfully. Count invariant restored to 182.');

  // Test 10: Celebration Audio & Host-Only Skip Lifecycle
  console.log('10. Testing Exact Celebration Timing & Host-Only Skip...');
  
  

  await request('/api/host/close-room', { method: 'POST', headers: hostHeaders });
  // Create room
  const createRoomRes = await request('/api/host/create-room', {
    method: 'POST',
    headers: hostHeaders,
    body: {
      mode: 'mini',
      timerSeconds: 10,
      maxSquadSize: 25,
      maxOverseas: 8,
      revisitUnsold: true,
      randomOrder: false
    }
  });
  assert(createRoomRes.status === 200 || createRoomRes.status === 201, `Expected 200 or 201, got ${createRoomRes.status}`);
  const roomCode = createRoomRes.json.room.code;
  console.log('  Room created:', roomCode);

  // Start auction
  const startRes = await request(`/api/room/${roomCode}/action`, {
    method: 'POST',
    headers: hostHeaders,
    body: { action: 'start' }
  });
  if (startRes.status !== 200) console.error('startRes returned error:', startRes.status, startRes.json);
  assert.strictEqual(startRes.status, 200);
  assert.strictEqual(startRes.json.room.status, 'live');

  // Join as CSK team owner
  const joinRes = await request(`/api/room/${roomCode}/join`, {
    method: 'POST',
    body: { clientId: 'test-csk-owner', name: 'Coach MS', teamId: 'CSK', role: 'teamOwner' }
  });
  assert.strictEqual(joinRes.status, 200);

  // Place a bid as CSK
  const bidRes = await request(`/api/room/${roomCode}/bid`, {
    method: 'POST',
    body: { clientId: 'test-csk-owner' }
  });
  assert.strictEqual(bidRes.status, 200);
  assert.strictEqual(bidRes.json.room.currentBidTeamId, 'CSK');

  // 10a. Verify audio watchdog duration (25s) when audio is present
  const beforeSoldAudio = Date.now();
  const soldAudioRes = await request(`/api/room/${roomCode}/action`, {
    method: 'POST',
    headers: hostHeaders,
    body: { action: 'sold' }
  });
  assert.strictEqual(soldAudioRes.status, 200);
  const soldAudioRoom = soldAudioRes.json.room;
  assert.strictEqual(soldAudioRoom.celebrationActive, true);
  const audioDiff = soldAudioRoom.autoAdvanceAt - beforeSoldAudio;
  console.log(`  Celebration with audio autoAdvanceAt delta: ${audioDiff}ms`);
  assert(audioDiff >= 24000 && audioDiff <= 26000, `Expected ~25000ms watchdog with audio, got ${audioDiff}ms`);
  console.log('✓ Watchdog duration with audio verified (~25s).');

  // Skip celebration
  const skipRes1 = await request(`/api/room/${roomCode}/action`, {
    method: 'POST',
    headers: hostHeaders,
    body: { action: 'skip-celebration', celebrationId: soldAudioRoom.celebrationId }
  });
  assert.strictEqual(skipRes1.status, 200);

  // 10b. Test exact 3.0s fallback duration with celebration audio disabled
  console.log('  Testing exact 3.0s celebration fallback duration...');
  await request(`/api/room/${roomCode}/action`, {
    method: 'POST',
    headers: hostHeaders,
    body: { action: 'set-audio-enabled', enabled: false }
  });

  // Join as GT owner
  await request(`/api/room/${roomCode}/join`, {
    method: 'POST',
    body: { clientId: 'test-gt-owner', name: 'Coach Nehra', teamId: 'GT', role: 'teamOwner' }
  });

  // Bid as GT on the new lot
  await request(`/api/room/${roomCode}/bid`, {
    method: 'POST',
    body: { clientId: 'test-gt-owner' }
  });

  // Settle lot for GT (no audio)
  const beforeSoldNoAudio = Date.now();
  const soldNoAudioRes = await request(`/api/room/${roomCode}/action`, {
    method: 'POST',
    headers: hostHeaders,
    body: { action: 'sold' }
  });
  assert.strictEqual(soldNoAudioRes.status, 200);
  const soldNoAudioRoom = soldNoAudioRes.json.room;
  assert.strictEqual(soldNoAudioRoom.celebrationActive, true);
  const noAudioDiff = soldNoAudioRoom.autoAdvanceAt - beforeSoldNoAudio;
  console.log(`  Celebration without audio autoAdvanceAt delta: ${noAudioDiff}ms`);
  assert(noAudioDiff >= 2700 && noAudioDiff <= 3500, `Expected ~3000ms duration without audio, got ${noAudioDiff}ms`);
  console.log('✓ Exact ~3.0s no-audio duration verified.');

  const celebrationId = soldNoAudioRoom.celebrationId;

  // Restore celebration audio enabled
  await request(`/api/room/${roomCode}/action`, {
    method: 'POST',
    headers: hostHeaders,
    body: { action: 'set-audio-enabled', enabled: true }
  });

  // Test participant cannot skip celebration
  console.log('  Testing participant cannot skip celebration...');
  const fakeParticipantRes = await request(`/api/room/${roomCode}/action`, {
    method: 'POST',
    body: { action: 'skip-celebration', celebrationId }
  });
  // Without host token, should be 403 or 401
  assert(fakeParticipantRes.status === 401 || fakeParticipantRes.status === 403, `Expected 401 or 403, got ${fakeParticipantRes.status}`);
  console.log('✓ Unauthorized participant skip attempt rejected (HTTP 401/403).');

  // Test Host skip-celebration
  console.log('  Testing Host skip-celebration...');
  const hostSkipRes = await request(`/api/room/${roomCode}/action`, {
    method: 'POST',
    headers: hostHeaders,
    body: { action: 'skip-celebration', celebrationId }
  });
  assert.strictEqual(hostSkipRes.status, 200);
  const skippedRoom = hostSkipRes.json.room;
  assert.strictEqual(skippedRoom.celebrationActive, false);
  assert.strictEqual(skippedRoom.celebrationId, null);
  console.log('✓ Host skip celebration successfully cleared celebration and advanced room.');

  // Close room cleanly
  const closeRes = await request(`/api/room/${roomCode}/action`, {
    method: 'POST',
    headers: hostHeaders,
    body: { action: 'close' }
  });
  assert.strictEqual(closeRes.status, 200);
  console.log('✓ Auction room closed cleanly.');

  // Test 11: Static Assets Verification
  console.log('11. Verifying Static Assets (CSS, JS, HTML)...');
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
  assert(css.includes('.host-mobile-actions'), 'Missing .host-mobile-actions in style.css');
  assert(css.includes('.host-action-trio'), 'Missing .host-action-trio in style.css');
  assert(css.includes('.btn-sold'), 'Missing .btn-sold in style.css');
  assert(css.includes('.celebration-confetti-canvas'), 'Missing .celebration-confetti-canvas in style.css');
  assert(css.includes('.stat-icon'), 'Missing .stat-icon alignment in style.css');
  assert(css.includes('.pool-table'), 'Missing .pool-table in style.css');
  console.log('✓ public/style.css verified.');

  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert(app.includes('startCelebrationConfetti'), 'Missing startCelebrationConfetti in app.js');
  assert(app.includes('stopCelebrationConfetti'), 'Missing stopCelebrationConfetti in app.js');
  assert(app.includes('renderPlayerPoolManager'), 'Missing renderPlayerPoolManager in app.js');
  assert(app.includes('renderHostSubnav'), 'Missing renderHostSubnav in app.js');
  assert(app.includes('host-mobile-actions'), 'Missing host-mobile-actions markup in app.js');
  console.log('✓ public/app.js verified.');

  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert(/style\.css\?v=(2[0-9])/.test(html), 'Missing style.css cache buster in index.html');
  assert(/app\.js\?v=(2[0-9])/.test(html), 'Missing app.js cache buster in index.html');
  console.log('✓ public/index.html cache busters verified.');

  console.log('\n========================================');
  console.log('ALL TESTS PASSED SUCCESSFULLY! (11/11)');
  console.log('========================================');
}

runTests().catch(err => {
  console.error('\n❌ TEST FAILED:', err);
  process.exit(1);
});
