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
  console.log('?? TEST A: Celebration and Back Button Stress Test\n');
  
  // Login and create room
  const login = await request('/api/host/login', { method: 'POST', body: { code: OWNER_CODE } });
  if (login.status !== 200) throw new Error('Login failed');
  const token = login.data.token;
  const headers = { 'x-host-token': token };
  
  const room = await request('/api/host/create-room', { 
    method: 'POST', 
    headers, 
    body: { mode: 'mega', megaPurseCr: 120, timerSeconds: 2, maxSquadSize: 25, maxOverseas: 8 } 
  });
  
  if (room.status !== 201) throw new Error(`Room creation failed: ${room.data.error}`);
  const code = room.data.room.code;
  console.log(`? Created room ${code}`);
  
  // Join as MI (to bid and buy players)
  await request(`/api/room/${code}/join`, { method: 'POST', body: { clientId: 'test-mi', name: 'MI Owner', teamId: 'MI' } });
  console.log('? MI joined\n');
  
  // Start auction
  await request(`/api/room/${code}/action`, { method: 'POST', headers, body: { action: 'start' } });
  
  // Test loop: 10 consecutive celebrations with Back button
  for (let i = 1; i <= 10; i++) {
    console.log(`?? Lot ${i}/10:`);
    
    // Wait a bit then place bid
    await new Promise(r => setTimeout(r, 500));
    const bid = await request(`/api/room/${code}/bid`, { method: 'POST', body: { clientId: 'test-mi' } });
    
    if (bid.status !== 200) {
      throw new Error(`Lot ${i}: Bid failed - ${bid.data.error}`);
    }
    console.log(`   ? Bid placed`);
    
    // Wait for settlement
    await new Promise(r => setTimeout(r, 2500));
    
    // Check that player was SOLD
    const state1 = await request(`/api/room/${code}/state`);
    if (!state1.data.room.celebrationActive) {
      throw new Error(`Lot ${i}: No celebration active after settlement!`);
    }
    console.log(`   ? Celebration active`);
    
    // Press "Back to Auction Floor" (skip celebration)
    const skip = await request(`/api/room/${code}/action`, { method: 'POST', headers, body: { action: 'skip-celebration' } });
    
    if (skip.status !== 200) {
      throw new Error(`Lot ${i}: Skip celebration failed`);
    }
    
    // Verify next player is ready
    const state2 = await request(`/api/room/${code}/state`);
    
    if (state2.data.room.celebrationActive) {
      throw new Error(`Lot ${i}: Celebration still active after skip!`);
    }
    
    if (state2.data.room.lotDone) {
      throw new Error(`Lot ${i}: Lot still marked done after skip!`);
    }
    
    if (!state2.data.room.currentPlayer) {
      throw new Error(`Lot ${i}: No current player after skip!`);
    }
    
    if (!state2.data.room.bidEndsAt) {
      throw new Error(`Lot ${i}: No bidding timer after skip!`);
    }
    
    console.log(`   ? Next player activated, timer started`);
    console.log(`   Player: ${state2.data.room.currentPlayer.name}\n`);
  }
  
  // Close room
  await request(`/api/room/${code}/action`, { method: 'POST', headers, body: { action: 'close' } });
  
  console.log('? TEST A PASSED: 10 consecutive celebrations with Back button');
  console.log('   No freeze detected, all lots settled correctly');
  
})().catch(err => { 
  console.error(`\n? TEST A FAILED: ${err.message}`); 
  process.exit(1); 
});
