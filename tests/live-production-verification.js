const assert = require('assert');
const vm = require('vm');

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

function testClientRenderFloor(appJsCode, room, isHost) {
  const domMock = { addEventListener: () => {}, querySelectorAll: () => [], getElementById: () => null, innerHTML: '', style: {} };
  const sandbox = {
    document: { getElementById: () => domMock, createElement: () => domMock, body: domMock, addEventListener: () => {} },
    window: { localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} }, location: { origin: LIVE_URL, href: LIVE_URL }, matchMedia: () => ({ matches: false }), addEventListener: () => {} },
    crypto: { randomUUID: () => '11111111-2222-3333-4444-555555555555' },
    setTimeout: () => {}, clearTimeout: () => {}, requestAnimationFrame: () => {}, cancelAnimationFrame: () => {},
    performance: { now: () => Date.now() }, console, fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
  };
  vm.createContext(sandbox);
  vm.runInContext(appJsCode, sandbox);
  sandbox._tempRoom = room;
  sandbox._tempIsHost = isHost;
  vm.runInContext('state.room = _tempRoom; state.isHost = _tempIsHost; state.roomCode = _tempRoom.code;', sandbox);
  const output = vm.runInContext('renderFloor()', sandbox);
  assert(typeof output === 'string' && output.includes(room.code));
  return output;
}

async function runLiveVerification() {
  console.log('================================================================');
  console.log('LIVE PRODUCTION VERIFICATION: https://ipl2027-auction-app.onrender.com');
  console.log('================================================================');

  // 1. Check HTML entry point & cache busters
  console.log('1. Checking HTML entry point...');
  const htmlRes = await request('/');
  assert.strictEqual(htmlRes.status, 200);
  assert(htmlRes.data.includes('style.css?v=20'), 'Expected style.css?v=20 in live HTML');
  assert(htmlRes.data.includes('app.js?v=20'), 'Expected app.js?v=20 in live HTML');
  console.log('✓ Live HTML verified with asset cache buster v=20.');

  // 2. Check /api/bootstrap
  console.log('2. Checking GET /api/bootstrap...');
  const bootRes = await request('/api/bootstrap');
  assert.strictEqual(bootRes.status, 200);
  assert.strictEqual(Array.isArray(bootRes.json.candidates), true);
  assert.strictEqual(bootRes.json.candidates.length, 182, 'Expected exactly 182 registered candidates');
  console.log(`✓ Live bootstrap verified with ${bootRes.json.candidates.length} candidates and hasActiveRoom=${bootRes.json.hasActiveRoom}.`);

  // 3. Verify CSS styling on live site
  console.log('3. Verifying live style.css?v=20...');
  const cssRes = await request('/style.css?v=20');
  assert.strictEqual(cssRes.status, 200);
  assert(cssRes.data.includes('.host-mobile-actions'), 'Missing .host-mobile-actions in live CSS');
  assert(cssRes.data.includes('.stat-icon') && cssRes.data.includes('font-size: 19px !important;'), 'Missing enlarged stat-icon font-size');
  assert(cssRes.data.includes('.float-icon') && cssRes.data.includes('font-size: 20px !important;'), 'Missing enlarged float-icon font-size');
  assert(cssRes.data.includes('.feature-icon') && cssRes.data.includes('font-size: 24px !important;'), 'Missing enlarged feature-icon font-size');
  assert(cssRes.data.includes('.rupee-symbol') && cssRes.data.includes('font-size: 1.12em !important;'), 'Missing enlarged rupee-symbol font-size');
  assert(cssRes.data.includes('.spark-symbol') && cssRes.data.includes('font-size: 1.25em !important;'), 'Missing enlarged spark-symbol font-size');
  console.log('✓ Live CSS verified with enlarged rupee and spark symbol sizes.');

  // 4. Verify JS code on live site
  console.log('4. Verifying live app.js?v=20...');
  const jsRes = await request('/app.js?v=20');
  assert.strictEqual(jsRes.status, 200);
  assert(jsRes.data.includes('const liveLot = Boolean(room.status === \'live\' && room.lotState === \'bidding\');'), 'Missing liveLot definition in renderFloor()');
  console.log('✓ Live JS verified with liveLot properly scoped in renderFloor().');

  // 5. Host login & Resume Room Workflow on live production
  console.log('5. Testing Host Login & Resume Existing Room Workflow on Live Production...');
  const loginRes = await request('/api/host/login', {
    method: 'POST',
    body: { code: 'ipl2027owner' }
  });
  assert.strictEqual(loginRes.status, 200);
  const token = loginRes.json.token;
  const headers = { 'x-host-token': token, 'x-owner-token': token };

  // Close any existing active room
  await request('/api/host/close-room', { method: 'POST', headers });

  // Create room on production
  const createRes = await request('/api/host/create-room', {
    method: 'POST',
    headers,
    body: { mode: 'mini', timerSeconds: 10 }
  });
  assert(createRes.status === 200 || createRes.status === 201);
  const room = createRes.json.room;
  console.log(`   Room created on production: ${room.code} (status: ${room.status})`);

  // Start live bidding
  const startRes = await request(`/api/room/${room.code}/action`, {
    method: 'POST',
    headers,
    body: { action: 'start' }
  });
  assert.strictEqual(startRes.status, 200);
  const liveRoom = startRes.json.room;
  console.log(`   Live room lot 1 on block: ${liveRoom.currentPlayer.name} (lotState: ${liveRoom.lotState})`);

  // Place a bid as CSK
  await request(`/api/room/${room.code}/join`, {
    method: 'POST',
    body: { clientId: 'prod-csk-owner', name: 'MS Dhoni', teamId: 'CSK', role: 'teamOwner' }
  });
  await request(`/api/room/${room.code}/bid`, {
    method: 'POST',
    body: { clientId: 'prod-csk-owner' }
  });

  // Query /api/host/current
  const currentRes = await request('/api/host/current', { headers });
  assert.strictEqual(currentRes.status, 200);
  assert.strictEqual(currentRes.json.room.code, room.code);

  // Execute client renderFloor with the production app.js and the live room state
  console.log('   Simulating Host "Resume Existing Room" with live production assets...');
  const renderedFloor = testClientRenderFloor(jsRes.data, currentRes.json.room, true);
  assert(renderedFloor.includes('✓ SOLD'), 'Must include SOLD button');
  assert(renderedFloor.includes('✕ UNSOLD'), 'Must include UNSOLD button');
  assert(renderedFloor.includes('Skip Player ⏭'), 'Must include Skip Player button');
  assert(renderedFloor.includes(liveRoom.currentPlayer.name), 'Must include current player name');
  console.log('   ✓ Resume Existing Room executed with ZERO runtime errors on live production.');

  // Clean room closure
  await request('/api/host/close-room', { method: 'POST', headers });
  const finalBoot = await request('/api/bootstrap');
  assert.strictEqual(finalBoot.json.hasActiveRoom, false);
  console.log('✓ Clean room closure verified on production (hasActiveRoom: false).');

  console.log('\n================================================================');
  console.log('ALL LIVE PRODUCTION CHECKS & RESUME WORKFLOW PASSED 100%!');
  console.log('================================================================');
}

runLiveVerification().catch(err => {
  console.error('\n❌ LIVE PRODUCTION VERIFICATION FAILED:', err);
  process.exit(1);
});
