'use strict';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3333';
const OWNER_CODE = process.env.HOST_ACCESS_CODE || 'ipl2027owner';
async function request(route, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  const response = await fetch(`${BASE}${route}`, { ...options, headers, body: options.body ? JSON.stringify(options.body) : undefined });
  let data = {}; try { data = await response.json(); } catch {}
  return { status: response.status, data };
}
function assert(condition, message) { if (!condition) throw new Error(message); }

(async () => {
  const boot = await request('/api/bootstrap');
  assert(boot.status === 200, 'bootstrap must load');
  assert(boot.data.candidates.length === 182, 'candidate pool must contain 182 players');
  assert(new Set(boot.data.candidates.map(p => p.id)).size === 182, 'candidate IDs must be unique');
  assert(boot.data.candidates.some(p => p.name === 'Umran Malik' && p.image === '/player-images/umran-malik.webp'), 'Umran must use the supplied local image');
  assert(!boot.data.candidates.some(p => p.name === 'Abhishek Sharma' || p.name === 'Jitesh Sharma'), 'squad-only players must not be auction candidates');

  const login = await request('/api/host/login', { method: 'POST', body: { code: OWNER_CODE } });
  assert(login.status === 200, `owner login failed: ${login.data.error || login.status}`);
  const token = login.data.token;
  const headers = { 'x-host-token': token };

  const created = await request('/api/host/create-room', { method: 'POST', headers, body: { mode: 'mini', timerSeconds: 10, maxSquadSize: 25, maxOverseas: 8, miniPurseAddOnCr: 5, revisitUnsold: true } });
  assert(created.status === 201, `mini room create failed: ${created.data.error || created.status}`);
  const room = created.data.room;
  assert(room.teams.length === 10, 'room must contain all 10 franchises');
  assert(Math.abs(room.teams.find(t => t.id === 'CSK').purseCr - 23.5) < 0.001, 'CSK fan purse baseline should be ₹23.50 Cr');
  const guard = await request('/api/host/create-room', { method: 'POST', headers, body: { mode: 'mega' } });
  assert(guard.status === 409, 'second active room must be rejected');

  const candidateBase = room.currentPlayer.basePriceCr;
  const changed = await request(`/api/room/${room.code}/action`, { method: 'POST', headers, body: { action: 'set-base-price', priceCr: 0.5 } });
  assert(changed.status === 200 && Math.abs(changed.data.room.currentPlayer.basePriceCr - 0.5) < 0.001, 'host base-price override should work before the auction starts');
  const joined = await request(`/api/room/${room.code}/join`, { method: 'POST', body: { clientId: 'smoke-test-csk', name: 'Smoke Test', teamId: 'CSK' } });
  assert(joined.status === 200, 'franchise seat should be claimable');
  const collision = await request(`/api/room/${room.code}/join`, { method: 'POST', body: { clientId: 'smoke-test-csk-2', name: 'Collision Test', teamId: 'CSK' } });
  assert(collision.status === 409, 'one franchise should not be claimed by two participants');
  const start = await request(`/api/room/${room.code}/action`, { method: 'POST', headers, body: { action: 'start' } });
  assert(start.status === 200 && start.data.room.status === 'live', 'auction should start');
  const bid = await request(`/api/room/${room.code}/bid`, { method: 'POST', body: { clientId: 'smoke-test-csk', amountCr: 0.5 } });
  assert(bid.status === 200 && Math.abs(bid.data.room.currentBidCr - 0.5) < 0.001, 'valid bid should be accepted');
  const sold = await request(`/api/room/${room.code}/action`, { method: 'POST', headers, body: { action: 'sold' } });
  assert(sold.status === 200 && sold.data.room.lastEvent.type === 'sale', 'host should sell a bid player');
  const csk = sold.data.room.teams.find(t => t.id === 'CSK');
  assert(Math.abs(csk.spentCr - 0.5) < 0.001 && Math.abs(csk.purseCr - 23.0) < 0.001, 'sale should update purse spent and remaining');
  assert(csk.squad.some(p => p.candidateId === room.currentPlayer.id), 'sold player should be added to the winning squad');
  const next = await request(`/api/room/${room.code}/action`, { method: 'POST', headers, body: { action: 'next' } });
  assert(next.status === 200 && next.data.room.currentPlayer, 'next candidate should be shown');
  const unsold = await request(`/api/room/${room.code}/action`, { method: 'POST', headers, body: { action: 'unsold' } });
  assert(unsold.status === 200 && unsold.data.room.lastEvent.type === 'unsold', 'host should be able to mark a player unsold');
  const close = await request(`/api/room/${room.code}/action`, { method: 'POST', headers, body: { action: 'close' } });
  assert(close.status === 200 && close.data.closed, 'host should be able to close the room');

  const mega = await request('/api/host/create-room', { method: 'POST', headers, body: { mode: 'mega', megaPurseCr: 120, timerSeconds: 10, maxSquadSize: 25, maxOverseas: 8 } });
  assert(mega.status === 201, 'mega room should be creatable after closing mini room');
  assert(mega.data.room.teams.every(t => Math.abs(t.purseCr - 120) < 0.001 && t.squad.length === 0), 'mega mode should start empty squads with configured purse');
  await request(`/api/room/${mega.data.room.code}/action`, { method: 'POST', headers, body: { action: 'close' } });

  const automatic = await request('/api/host/create-room', { method: 'POST', headers, body: { mode: 'mega', megaPurseCr: 120, timerSeconds: 5, maxSquadSize: 25, maxOverseas: 8 } });
  assert(automatic.status === 201, 'automatic-settlement room should be creatable');
  const autoRoom = automatic.data.room;
  const autoJoin = await request(`/api/room/${autoRoom.code}/join`, { method: 'POST', body: { clientId: 'smoke-auto-csk', name: 'Auto Test', teamId: 'CSK' } });
  assert(autoJoin.status === 200, 'automatic-settlement bidder should be able to join');
  await request(`/api/room/${autoRoom.code}/action`, { method: 'POST', headers, body: { action: 'start' } });
  await request(`/api/room/${autoRoom.code}/action`, { method: 'POST', headers, body: { action: 'pause' } });
  await new Promise(resolve => setTimeout(resolve, 5300));
  const paused = await request(`/api/room/${autoRoom.code}/state`);
  assert(paused.data.room.status === 'paused' && paused.data.room.auctionHistory.length === 0, 'host pause must stop timer-based settlement');
  await request(`/api/room/${autoRoom.code}/action`, { method: 'POST', headers, body: { action: 'resume' } });
  await new Promise(resolve => setTimeout(resolve, 5300));
  const automaticUnsold = await request(`/api/room/${autoRoom.code}/state`);
  assert(automaticUnsold.data.room.lastEvent.type === 'unsold' && automaticUnsold.data.room.auctionHistory[0].type === 'unsold', 'timer expiry with no bids must automatically mark the lot unsold');
  // In host-governed auctions, host advances to the next player after an unsold lot
  await request(`/api/room/${autoRoom.code}/action`, { method: 'POST', headers, body: { action: 'next' } });
  const afterUnsold = await request(`/api/room/${autoRoom.code}/state`);
  assert(afterUnsold.data.room.index === 1 && !afterUnsold.data.room.lotDone, 'next lot must be active after advancing');
  const autoBid = await request(`/api/room/${autoRoom.code}/bid`, { method: 'POST', body: { clientId: 'smoke-auto-csk' } });
  assert(autoBid.status === 200, 'a valid bid should be accepted on the next automatic lot');
  await new Promise(resolve => setTimeout(resolve, 5300));
  const automaticSale = await request(`/api/room/${autoRoom.code}/state`);
  assert(automaticSale.data.room.lastEvent.type === 'sale' && automaticSale.data.room.auctionHistory[1].type === 'sold', 'timer expiry after a bid must automatically sell the player');
  assert(automaticSale.data.room.teams.find(t => t.id === 'CSK').purchases.length === 1, 'automatic sale must update the winning squad and purse');
  await request(`/api/room/${autoRoom.code}/action`, { method: 'POST', headers, body: { action: 'close' } });
  console.log('PASS: existing auction flows plus automatic no-bid unsold, bid-to-sale, automatic next lot, and host pause/resume.');
})().catch(err => { console.error(`FAIL: ${err.message}`); process.exit(1); });
