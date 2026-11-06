const fs = require('fs');
const vm = require('vm');
const http = require('http');

const path = require('path');
const appJs = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');

function get(path, headers={}) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: 'localhost', port: 3333, path, headers }, res => {
      let d = '';
      res.on('data', chunk => d += chunk);
      res.on('end', () => resolve(JSON.parse(d)));
    }).on('error', reject);
  });
}

function post(path, body, headers={}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: 'localhost',
      port: 3333,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        ...headers
      }
    }, res => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => resolve(JSON.parse(buf)));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function run() {
  const bootstrap = await get('/api/bootstrap');
  const login = await post('/api/host/login', { code: 'ipl2027owner' });
  const token = login.token;
  await post('/api/host/close-room', {}, { 'x-host-token': token });

  // 1. Create Mega room with participant retentions
  const megaRoomRes = await post('/api/host/create-room', {
    mode: 'mega',
    retentionMode: 'participants',
    timerSeconds: 10,
    maxSquadSize: 25,
    maxOverseas: 8,
    megaPurseCr: 120,
    revisitUnsold: true,
    randomOrder: false
  }, { 'x-host-token': token });

  console.log('Created Mega Room:', megaRoomRes.room.code);

  const dom = {
    elements: {},
    app: { innerHTML: '', querySelectorAll: () => [] },
    toastRoot: { appendChild: () => {} },
    localStorage: {
      data: { 'ipl27-owner-token': token, 'ipl27-owner-room': megaRoomRes.room.code },
      getItem(k) { return this.data[k] || null; },
      setItem(k, v) { this.data[k] = v; },
      removeItem(k) { delete this.data[k]; }
    }
  };

  const sandbox = {
    document: {
      getElementById: (id) => {
        if (id === 'app') return dom.app;
        if (id === 'toast-root') return dom.toastRoot;
        return null;
      },
      querySelectorAll: () => [],
      querySelector: () => null,
      addEventListener: () => {}
    },
    window: {
      localStorage: dom.localStorage,
      location: { href: 'http://localhost:3333/', search: '' },
      history: { replaceState: () => {} },
      matchMedia: () => ({ matches: false }),
      addEventListener: () => {}
    },
    crypto: { randomUUID: () => '1234-uuid' },
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
    console: console,
    setTimeout: () => {},
    clearTimeout: () => {},
    setInterval: () => {},
    clearInterval: () => {}
  };

  vm.createContext(sandbox);
  vm.runInContext(appJs, sandbox);

  sandbox.__injectedBootstrap = bootstrap;
  sandbox.__injectedRoom = megaRoomRes.room;
  sandbox.__injectedCode = megaRoomRes.room.code;

  vm.runInContext(`
    state.bootstrap = __injectedBootstrap;
    state.room = __injectedRoom;
    state.roomCode = __injectedCode;
    state.isHost = true;
    state.view = 'retention';
    try {
      renderRoom();
      console.log('renderRoom for Mega succeeded! Output length:', app.innerHTML.length);
    } catch (e) {
      console.error('renderRoom for Mega threw error:', e);
    }
  `, sandbox);

  // Test Mega room with HOST retention mode (retentionMode: 'host')
  sandbox.__injectedHostMegaRoom = {
    code: 'MEGAHOST',
    mode: 'mega',
    retentionMode: 'host',
    status: 'retention',
    lotState: 'retention',
    teams: [{ id: 'CSK', name: 'Chennai Super Kings', startingPurseCr: 120, purseCr: 120, retentions: [], retentionConfirmed: false }],
    auctionOrder: [],
    participants: []
  };

  vm.runInContext(`
    state.room = __injectedHostMegaRoom;
    state.roomCode = 'MEGAHOST';
    state.isHost = true;
    state.view = 'retention';
    try {
      renderRoom();
      console.log('renderRoom for Mega Host Retention succeeded! Output length:', app.innerHTML.length);
    } catch (e) {
      console.error('renderRoom for Mega Host Retention threw error:', e);
    }
  `, sandbox);

  // Test Mini room
  await post('/api/host/close-room', {}, { 'x-host-token': token });
  const miniRoomRes = await post('/api/host/create-room', {
    mode: 'mini',
    timerSeconds: 10,
    maxSquadSize: 25,
    maxOverseas: 8,
    miniPurseAddOnCr: 5,
    revisitUnsold: true,
    randomOrder: false
  }, { 'x-host-token': token });

  sandbox.__injectedMiniRoom = miniRoomRes.room;
  sandbox.__injectedMiniCode = miniRoomRes.room.code;

  vm.runInContext(`
    state.room = __injectedMiniRoom;
    state.roomCode = __injectedMiniCode;
    state.isHost = true;
    state.view = 'floor';
    try {
      renderRoom();
      console.log('renderRoom for Mini succeeded! Output length:', app.innerHTML.length);
    } catch (e) {
      console.error('renderRoom for Mini threw error:', e);
    }
  `, sandbox);
}

run().catch(console.error);
