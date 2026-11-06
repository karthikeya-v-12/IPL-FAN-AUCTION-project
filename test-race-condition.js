'use strict';
const BASE = 'http://127.0.0.1:3333';
const OWNER_CODE = 'ipl2027owner';

async function request(route, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  const response = await fetch(`${BASE}${route}`, { ...options, headers, body: options.body ? JSON.stringify(options.body) : undefined });
  let data = {}; try { data = await response.json(); } catch {}
  return { status: response.status, data };
}

(async () => {
  console.log('?? Testing deadline race condition fix...\n');
  
  // Login
  const login = await request('/api/host/login', { method: 'POST', body: { code: OWNER_CODE } });
  if (login.status !== 200) throw new Error('Login failed');
  const token = login.data.token;
  const headers = { 'x-host-token': token };
  
  // Create room with 2-second timer for easier testing
  const room = await request('/api/host/create-room', { method: 'POST', headers, body: { mode: 'mega', megaPurseCr: 120, timerSeconds: 2, maxSquadSize: 25, maxOverseas: 8 } });
  if (room.status !== 201) throw new Error('Room creation failed');
  const code = room.data.room.code;
  console.log(`? Created room ${code} with 2s timer`);
  
  // Join as CSK
  await request(`/api/room/${code}/join`, { method: 'POST', body: { clientId: 'test-csk', name: 'CSK Owner', teamId: 'CSK' } });
  await request(`/api/room/${code}/join`, { method: 'POST', body: { clientId: 'test-mi', name: 'MI Owner', teamId: 'MI' } });
  console.log('? Two teams joined');
  
  // Start auction
  await request(`/api/room/${code}/action`, { method: 'POST', headers, body: { action: 'start' } });
  console.log('? Auction started');
  
  // TEST 1: Valid bid at ~1s remaining
  console.log('\n?? TEST 1: Valid bid at 1s remaining');
  await new Promise(r => setTimeout(r, 1000)); // Wait 1 second
  const bid1 = await request(`/api/room/${code}/bid`, { method: 'POST', body: { clientId: 'test-csk' } });
  if (bid1.status === 200) {
    console.log('? Bid accepted at 1s');
    const state1 = await request(`/api/room/${code}/state`);
    if (state1.data.room.bidEndsAt) {
      console.log('? Deadline extended for valid bid');
    } else {
      console.log('? Deadline not extended!');
    }
  } else {
    console.log(`? Bid rejected: ${bid1.data.error}`);
  }
  
  // Let it settle
  await new Promise(r => setTimeout(r, 2500));
  const settled1 = await request(`/api/room/${code}/state`);
  if (settled1.data.room.auctionHistory.length === 1 && settled1.data.room.auctionHistory[0].type === 'sold') {
    console.log('? Player correctly SOLD');
  } else {
    console.log('? Settlement failed!');
  }
  
  // TEST 2: Invalid bid at low timer (insufficient purse)
  console.log('\n?? TEST 2: Invalid bid (purse too low)');
  // Drain CSK purse first
  for (let i = 0; i < 5; i++) {
    await request(`/api/room/${code}/bid`, { method: 'POST', body: { clientId: 'test-mi' } });
    await new Promise(r => setTimeout(r, 2500));
  }
  
  const stateBefore = await request(`/api/room/${code}/state`);
  const deadlineBefore = stateBefore.data.room.bidEndsAt;
  
  await new Promise(r => setTimeout(r, 1000));
  const invalidBid = await request(`/api/room/${code}/bid`, { method: 'POST', body: { clientId: 'test-csk' } });
  
  const stateAfter = await request(`/api/room/${code}/state`);
  const deadlineAfter = stateAfter.data.room.bidEndsAt;
  
  if (invalidBid.status === 409) {
    console.log('? Invalid bid rejected');
    if (deadlineBefore === deadlineAfter) {
      console.log('? Deadline NOT extended for invalid bid');
    } else {
      console.log('? FAIL: Invalid bid extended deadline!');
    }
  } else {
    console.log('? Invalid bid was accepted!');
  }
  
  // Close room
  await request(`/api/room/${code}/action`, { method: 'POST', headers, body: { action: 'close' } });
  
  console.log('\n? Race condition tests complete');
})().catch(err => { console.error(`\n? TEST FAILED: ${err.message}`); process.exit(1); });
