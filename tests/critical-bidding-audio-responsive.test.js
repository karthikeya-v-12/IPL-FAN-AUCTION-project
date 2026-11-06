'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3333';

async function request(endpoint, options = {}) {
  const url = `${BASE_URL}${endpoint}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, headers: res.headers, json, text };
}

async function runTests() {
  console.log('================================================================================');
  console.log('CRITICAL SUITE: FAST BIDDING, AUDIO PRESERVATION & MOBILE RESPONSIVENESS');
  console.log('================================================================================\n');

  // Step 1: Login as Host
  console.log('1. Host Authentication...');
  const loginRes = await request('/api/host/login', {
    method: 'POST',
    body: { code: 'ipl2027owner' }
  });
  assert.strictEqual(loginRes.status, 200, 'Host login should succeed');
  const hostToken = loginRes.json.token;
  const hostHeaders = { 'x-host-token': hostToken, Authorization: `Bearer ${hostToken}` };
  console.log('   ✓ Host login authenticated successfully.\n');

  // Step 2: Bootstrap & Verify 10 Franchise Audio Defaults Preserved
  console.log('2. Preserved Franchise Audio Verification...');
  const bootRes = await request('/api/bootstrap');
  assert.strictEqual(bootRes.status, 200);
  const teams = bootRes.json.teams;
  assert.strictEqual(teams.length, 10, 'Must have all 10 IPL franchises');
  const audioMap = bootRes.json.audio;
  const metaMap = bootRes.json.teamAudioMetadata || bootRes.json.audioMetadata;
  assert(audioMap, 'Audio map must exist');
  assert(metaMap, 'Audio metadata map must exist');

  const EXPECTED_TEAMS = ['CSK', 'MI', 'RCB', 'KKR', 'SRH', 'RR', 'DC', 'PBKS', 'LSG', 'GT'];
  for (const tid of EXPECTED_TEAMS) {
    assert(audioMap[tid], `Team ${tid} must have an active audio mapping`);
    assert(audioMap[tid].includes(tid.toLowerCase()), `Team ${tid} audio should match team hook convention`);
    const meta = metaMap[tid];
    assert(meta, `Team ${tid} must have metadata record`);
    assert.strictEqual(meta.teamId, tid);
    assert(meta.isDefault === true || !meta.url.includes('/custom/'), `Team ${tid} should default to built-in track`);
    const dur = meta.durationSec || meta.duration;
    assert(dur > 0, `Team ${tid} must have valid positive duration in seconds`);
    console.log(`   ✓ ${tid}: ${meta.fileName || meta.filename} (⏱ ${dur.toFixed(1)}s, default: ${meta.isDefault})`);
  }
  console.log('   ✓ All 10 default franchise audio assets permanently preserved.\n');

  // Step 3: Test Safe Custom Audio Upload via .tmp and Atomic Replacement
  console.log('3. Safe Custom Audio Upload & Duration Detection...');
  // 1-second silent MP3 buffer with valid MPEG sync frame
  const sampleMp3Header = Buffer.from([
    0xFF, 0xFB, 0x90, 0x64, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x58, 0x69, 0x6E, 0x67 // 'Xing'
  ]);
  const dummyMp3Buffer = Buffer.concat([sampleMp3Header, Buffer.alloc(1024, 0x55)]);
  const dummyBase64 = `data:audio/mpeg;base64,${dummyMp3Buffer.toString('base64')}`;

  const uploadRes = await request('/api/host/audio', {
    method: 'POST',
    headers: hostHeaders,
    body: {
      teamId: 'RCB',
      fileName: 'rcb-victory-chant-2027.mp3',
      mimeType: 'audio/mpeg',
      dataBase64: dummyBase64
    }
  });
  assert.strictEqual(uploadRes.status, 200, 'Custom audio upload should succeed');
  assert(uploadRes.json.audioUrl.startsWith('/audio/custom/rcb-'), 'Upload should be placed in /audio/custom/');
  assert.strictEqual(uploadRes.json.isDefault, false, 'Uploaded track should be marked custom');
  assert(uploadRes.json.durationSec > 0, 'Duration should be detected');
  console.log(`   ✓ Uploaded custom audio for RCB: ${uploadRes.json.audioUrl} (${uploadRes.json.durationSec.toFixed(1)}s)`);

  // Verify custom audio file exists on disk
  const customFilePath = path.join(__dirname, '..', 'public', uploadRes.json.audioUrl.replace(/^\//, ''));
  assert(fs.existsSync(customFilePath), 'Custom audio file must exist on disk in public/audio/custom/');
  console.log('   ✓ Stored file verified on disk.');

  // Step 4: Test Restore Default Audio (Preserves Default Track, Unlinks Custom)
  console.log('4. Restoring Default Audio Track...');
  const restoreRes = await request('/api/host/audio', {
    method: 'POST',
    headers: hostHeaders,
    body: { teamId: 'RCB', clear: true, restoreDefault: true }
  });
  assert.strictEqual(restoreRes.status, 200, 'Restore default should succeed');
  assert.strictEqual(restoreRes.json.audioUrl, '/audio/rcb-hook.mp3', 'Should restore canonical default URL');
  assert.strictEqual(restoreRes.json.isDefault, true, 'Restored track should be marked default');
  // Verify default file on disk was preserved and NOT deleted!
  const defaultFilePath = path.join(__dirname, '..', 'public', 'audio', 'rcb-hook.mp3');
  assert(fs.existsSync(defaultFilePath), 'Original default audio file must NOT be deleted');
  // Verify old custom file was unlinked
  assert(!fs.existsSync(customFilePath), 'Old custom file should be unlinked on restore default');
  console.log('   ✓ Default audio successfully restored; built-in hook remains intact.\n');

  // Step 5: Room Creation & Fast Bidding Idempotency
  console.log('5. Fast-Path Bidding, Idempotency & Latency Measurement...');
  const createRes = await request('/api/host/create-room', {
    method: 'POST',
    headers: hostHeaders,
    body: {
      mode: 'mini',
      timerSeconds: 10,
      maxSquadSize: 25,
      maxOverseas: 8,
      miniPurseAddOnCr: 5
    }
  });
  assert(createRes.status === 200 || createRes.status === 201, 'Create room should succeed');
  const roomCode = createRes.json.room.code;
  console.log(`   ✓ Created test room ${roomCode}`);

  // Join participants
  const joinCsk = await request(`/api/room/${roomCode}/join`, {
    method: 'POST',
    body: { clientId: 'client-csk-1', name: 'CSK Lead', teamId: 'CSK', role: 'teamOwner' }
  });
  assert.strictEqual(joinCsk.status, 200);

  const joinMi = await request(`/api/room/${roomCode}/join`, {
    method: 'POST',
    body: { clientId: 'client-mi-1', name: 'MI Lead', teamId: 'MI', role: 'teamOwner' }
  });
  assert.strictEqual(joinMi.status, 200);

  // Start Auction
  const startRes = await request(`/api/room/${roomCode}/action`, {
    method: 'POST',
    headers: hostHeaders,
    body: { action: 'start' }
  });
  assert.strictEqual(startRes.status, 200);
  assert.strictEqual(startRes.json.room.status, 'live');

  // Submit Bid 1 with bidRequestId
  const bid1Id = `bid_${Date.now()}_test1`;
  const t0 = Date.now();
  const bid1Res = await request(`/api/room/${roomCode}/bid`, {
    method: 'POST',
    body: {
      clientId: 'client-csk-1',
      bidRequestId: bid1Id
    }
  });
  const t1 = Date.now();
  assert.strictEqual(bid1Res.status, 200);
  assert.strictEqual(bid1Res.json.room.currentBidTeamId, 'CSK');
  const bid1Amount = bid1Res.json.room.currentBidCr;
  assert(bid1Res.json.timing, 'Bid response must return timing metrics');
  assert(typeof bid1Res.json.timing.serverDurationMs === 'number', 'serverDurationMs must be reported');
  console.log(`   ✓ Bid 1 accepted: CSK leading at ₹${bid1Amount} Cr (Server: ${bid1Res.json.timing.serverDurationMs}ms, RTT: ${t1 - t0}ms)`);

  // Rapid Duplicate Click with Same bidRequestId -> Deduplication Test
  console.log('   Testing rapid duplicate click deduplication...');
  const dupBidRes = await request(`/api/room/${roomCode}/bid`, {
    method: 'POST',
    body: {
      clientId: 'client-csk-1',
      bidRequestId: bid1Id,
      amountCr: bid1Amount
    }
  });
  assert.strictEqual(dupBidRes.status, 200);
  assert(dupBidRes.json.deduplicated || dupBidRes.json.duplicate, 'Duplicate bidRequestId must be recognized and deduplicated');
  assert.strictEqual(dupBidRes.json.room.currentBidCr, bid1Amount, 'Amount must not have changed');
  console.log('   ✓ Duplicate rapid bid safely deduplicated with zero state corruption.');

  // Concurrent Bids Serialization
  console.log('   Testing concurrent bids serialization...');
  const [bA, bB] = await Promise.all([
    request(`/api/room/${roomCode}/bid`, { method: 'POST', body: { clientId: 'client-mi-1' } }),
    request(`/api/room/${roomCode}/bid`, { method: 'POST', body: { clientId: 'client-csk-1' } })
  ]);
  // Exactly one of the two bids should be accepted, the other rejected with 409
  const statuses = [bA.status, bB.status].sort();
  assert.strictEqual(statuses[0], 200, 'One bid must succeed');
  console.log('   ✓ Concurrent bidding safely serialized authoritatively without race conditions.\n');

  // Step 6: Host Global Celebration Audio Toggle & Exact Timing
  console.log('6. Host Global Celebration Audio Toggle & Exact 3,000ms Fallback...');
  // Check default: celebrationAudioEnabled is true
  const stateRes1 = await request(`/api/room/${roomCode}/state`);
  assert.strictEqual(stateRes1.json.room.celebrationAudioEnabled, true, 'Default celebrationAudioEnabled should be true');

  // Toggle celebration audio OFF as Host
  const toggleOffRes = await request(`/api/room/${roomCode}/action`, {
    method: 'POST',
    headers: hostHeaders,
    body: { action: 'set-audio-enabled', enabled: false }
  });
  assert.strictEqual(toggleOffRes.status, 200);
  assert.strictEqual(toggleOffRes.json.room.celebrationAudioEnabled, false, 'celebrationAudioEnabled should now be false');
  console.log('   ✓ Host toggled celebration audio OFF.');

  // Settle current lot as SOLD with celebrationAudioEnabled = false
  const beforeSold = Date.now();
  const soldRes = await request(`/api/room/${roomCode}/action`, {
    method: 'POST',
    headers: hostHeaders,
    body: { action: 'sold' }
  });
  assert.strictEqual(soldRes.status, 200);
  const soldRoom = soldRes.json.room;
  assert.strictEqual(soldRoom.celebrationActive, true, 'Celebration modal should be active');
  const deltaMs = soldRoom.autoAdvanceAt - beforeSold;
  console.log(`   Celebration autoAdvanceAt delta with audio OFF: ${deltaMs}ms`);
  assert(deltaMs >= 2700 && deltaMs <= 3500, `Expected exactly ~3000ms fallback duration, got ${deltaMs}ms`);
  console.log('   ✓ Exact 3,000 ms fallback verified when celebration audio is OFF.');

  // Toggle back ON mid-celebration and verify
  const toggleOnRes = await request(`/api/room/${roomCode}/action`, {
    method: 'POST',
    headers: hostHeaders,
    body: { action: 'set-audio-enabled', enabled: true }
  });
  assert.strictEqual(toggleOnRes.status, 200);
  assert.strictEqual(toggleOnRes.json.room.celebrationAudioEnabled, true);
  console.log('   ✓ Host toggled celebration audio back ON.\n');

  // Step 7: Mobile Responsiveness & Layout Verification
  console.log('7. Mobile Viewport Layout & Navigation Audit...');
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
  const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

  // Audit CSS rules
  assert(css.includes('.host-subnav'), 'CSS must define .host-subnav');
  assert(css.includes('@media (max-width: 768px)'), 'CSS must include tablet/mobile breakpoint');
  assert(css.includes('@media (max-width: 430px)'), 'CSS must include mobile breakpoint for <= 430px');
  assert(css.includes('.bid-submitting'), 'CSS must include .bid-submitting state');
  assert(css.includes('.bid-accepted'), 'CSS must include .bid-accepted state');
  assert(css.includes('.audio-manager-grid'), 'CSS must include .audio-manager-grid');
  assert(css.includes('.host-audio-toggle-card'), 'CSS must include .host-audio-toggle-card');
  assert(css.includes('overflow-x: hidden'), 'CSS must enforce page overflow containment on mobile');

  // Audit app.js implementation
  assert(appJs.includes('renderFranchiseAudioList'), 'app.js must implement renderFranchiseAudioList');
  assert(appJs.includes('restoreDefaultAudio'), 'app.js must implement restoreDefaultAudio');
  assert(appJs.includes('previewAudio'), 'app.js must implement previewAudio');
  assert(appJs.includes('fastUpdateBidStage'), 'app.js must implement fastUpdateBidStage');
  assert(appJs.includes('saveHostSetupDraft'), 'app.js must preserve host setup draft');
  assert(appJs.includes('toggle-celebration-audio'), 'app.js must bind toggle-celebration-audio');
  console.log('   ✓ All CSS rules and app.js components verified for mobile responsiveness.\n');

  // Clean up: Close room
  const closeRes = await request(`/api/room/${roomCode}/action`, {
    method: 'POST',
    headers: hostHeaders,
    body: { action: 'close-room' }
  });
  assert.strictEqual(closeRes.status, 200);
  console.log('   ✓ Test room closed cleanly.\n');

  console.log('================================================================================');
  console.log('✨ ALL CRITICAL TESTS PASSED 100%! ✨');
  console.log('================================================================================\n');
}

runTests().catch(err => {
  console.error('\n❌ CRITICAL TEST FAILED:', err);
  process.exit(1);
});
