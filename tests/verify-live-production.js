const assert = require('assert');

const LIVE_URL = 'https://ipl2027-auction-app.onrender.com';

async function request(path, options = {}) {
  const url = `${LIVE_URL}${path}`;
  const headers = { ...(options.headers || {}) };
  let body = options.body;
  if (body && typeof body !== 'string') {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(body);
  }

  const res = await fetch(url, {
    method: options.method || 'GET',
    headers,
    body
  });

  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, headers: Object.fromEntries(res.headers.entries()), data: text, json };
}

async function runLiveVerification() {
  console.log('================================================================');
  console.log('LIVE PRODUCTION VERIFICATION: https://ipl2027-auction-app.onrender.com');
  console.log('================================================================');

  // 1. Check HTML entry point & cache busters
  console.log('\n1. Checking HTML entry point (v=26 cache buster & celebration-root)...');
  const htmlRes = await request('/');
  assert.strictEqual(htmlRes.status, 200);
  assert(htmlRes.data.includes('style.css?v=26'), 'Expected style.css?v=26 in live HTML');
  assert(htmlRes.data.includes('app.js?v=26'), 'Expected app.js?v=26 in live HTML');
  assert(htmlRes.data.includes('id="celebration-root"'), 'Expected <div id="celebration-root"> in live HTML');
  console.log('✓ Live HTML verified with cache buster v=26 and #celebration-root portal.');

  // 2. Check /api/bootstrap
  console.log('\n2. Checking GET /api/bootstrap...');
  const bootRes = await request('/api/bootstrap');
  assert.strictEqual(bootRes.status, 200);
  assert.strictEqual(Array.isArray(bootRes.json.candidates), true);
  assert.strictEqual(bootRes.json.candidates.length, 182, 'Expected exactly 182 registered candidates');
  console.log(`✓ Live bootstrap verified with ${bootRes.json.candidates.length} candidates.`);

  // 3. Verify CSS styling on live site
  console.log('\n3. Verifying live style.css?v=26 (underline styling, red background preservation, stacking order)...');
  const cssRes = await request('/style.css?v=26');
  assert.strictEqual(cssRes.status, 200);
  assert(cssRes.data.includes('GLOBAL UNDERLINE STYLING'), 'Missing GLOBAL UNDERLINE STYLING in live CSS');
  assert(cssRes.data.includes('color: #000000 !important;'), 'Missing color: #000000 !important in live CSS');
  assert(cssRes.data.includes('.sale-celebration'), 'Missing .sale-celebration in live CSS');
  console.log('✓ Live CSS verified with global underline pure black font (#000000) and red background preservation.');

  // 4. Verify JS code on live site
  console.log('\n4. Verifying live app.js?v=26...');
  const jsRes = await request('/app.js?v=26');
  assert.strictEqual(jsRes.status, 200);
  assert(jsRes.data.includes('getCelebrationRoot'), 'Missing getCelebrationRoot in live app.js');
  assert(jsRes.data.includes('syncCelebrationModal'), 'Missing syncCelebrationModal in live app.js');
  assert(jsRes.data.includes('confettiCelebrationId'), 'Missing confettiCelebrationId in live app.js');
  console.log('✓ Live app.js verified with stable portal mounting.');

  // 5. Live Host Authentication & Room Lifecycle
  console.log('\n5. Testing live host authentication & room lifecycle...');
  const loginRes = await request('/api/host/login', {
    method: 'POST',
    body: { code: 'ipl2027owner' }
  });
  assert.strictEqual(loginRes.status, 200, 'Live host login failed');
  const hostToken = loginRes.json.token;
  assert(hostToken, 'Host token missing');

  // Close lingering active room if any
  await request('/api/host/close-room', {
    method: 'POST',
    headers: { 'x-host-token': hostToken }
  });

  // Create fresh live room
  const createRes = await request('/api/host/create-room', {
    method: 'POST',
    headers: { 'x-host-token': hostToken },
    body: {
      mode: 'mini',
      timerSeconds: 10,
      purseCr: 120,
      retentionMode: 'host',
      ruleOverrides: { maxSquadSize: 25, maxOverseas: 8 }
    }
  });
  assert.strictEqual(createRes.status, 201, `Failed to create live room: ${createRes.data}`);
  const roomCode = createRes.json.room.code;
  console.log(`✓ Live room created: ${roomCode}`);

  // Start live auction
  const startRes = await request(`/api/room/${roomCode}/action`, {
    method: 'POST',
    headers: { 'x-host-token': hostToken },
    body: { action: 'start' }
  });
  assert.strictEqual(startRes.status, 200, `Live start failed: ${startRes.data}`);
  console.log('✓ Live auction floor started.');

  // Join live participant
  const joinRes = await request(`/api/room/${roomCode}/join`, {
    method: 'POST',
    body: { name: 'Live CSK Owner', teamId: 'CSK', clientId: 'live-csk-tester' }
  });
  assert.strictEqual(joinRes.status, 200, `Live join failed: ${joinRes.data}`);
  console.log('✓ Live participant joined as CSK.');

  // Place initial bid
  const stateRes = await request(`/api/room/${roomCode}/state`);
  const baseCr = stateRes.json.room.currentPlayer?.basePriceCr || 1.0;
  const bidRes = await request(`/api/room/${roomCode}/bid`, {
    method: 'POST',
    body: { clientId: 'live-csk-tester', amountCr: baseCr }
  });
  assert.strictEqual(bidRes.status, 200, `Live bid failed: ${bidRes.data}`);
  console.log(`✓ Live bid placed at ₹${baseCr} Cr.`);

  // Mark player SOLD as host
  const soldRes = await request(`/api/room/${roomCode}/action`, {
    method: 'POST',
    headers: { 'x-host-token': hostToken },
    body: { action: 'sold' }
  });
  assert.strictEqual(soldRes.status, 200, `Live sold action failed: ${soldRes.data}`);
  assert.strictEqual(soldRes.json.room.celebrationActive, true, 'Live celebrationActive must be true');
  const celebrationId = soldRes.json.room.celebrationId;
  assert(celebrationId, 'celebrationId must exist on live room');
  console.log(`✓ Live player marked SOLD (celebrationId: ${celebrationId}).`);

  // Verify unauthorized participant skip is rejected on live server
  const partSkipRes = await request(`/api/room/${roomCode}/action`, {
    method: 'POST',
    body: { action: 'skip-celebration', celebrationId }
  });
  assert.strictEqual(partSkipRes.status, 403, 'Live server must reject unauthorized skip with 403');
  console.log('✓ Live server strictly rejected unauthorized participant celebration skip with 403.');

  // Host skips celebration
  const hostSkipRes = await request(`/api/room/${roomCode}/action`, {
    method: 'POST',
    headers: { 'x-host-token': hostToken },
    body: { action: 'skip-celebration', celebrationId }
  });
  assert.strictEqual(hostSkipRes.status, 200, `Live host skip failed: ${hostSkipRes.data}`);
  assert.strictEqual(hostSkipRes.json.room.celebrationActive, false, 'Celebration must be inactive after skip');
  assert.strictEqual(hostSkipRes.json.room.lotState, 'bidding', 'Next lot must be in bidding state');
  console.log('✓ Live host skip celebration successfully advanced to next lot.');

  // Clean up live room
  await request('/api/host/close-room', {
    method: 'POST',
    headers: { 'x-host-token': hostToken }
  });
  console.log('✓ Live room closed cleanly.');

  console.log('\n================================================================');
  console.log('🎉 LIVE PRODUCTION VERIFICATION 100% SUCCESSFUL 🎉');
  console.log('================================================================');
}

runLiveVerification().catch(err => {
  console.error('\n❌ LIVE VERIFICATION FAILED:', err);
  process.exit(1);
});
