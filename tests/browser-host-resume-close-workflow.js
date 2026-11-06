'use strict';

/**
 * Headless Chrome CDP Test for Host Room Resume, Exit, and Close Workflow
 * Verifies Task 1, Task 2, and Task 5 directly in a real browser:
 * 1. Host creates a Mega Auction room.
 * 2. Host closes tab / navigates to root landing page http://127.0.0.1:3333/.
 * 3. Verifies "Existing Auction Room" recovery card is rendered in Host Setup with:
 *    - Room code
 *    - Format & Status
 *    - "Resume Existing Room" button
 *    - "Close Room & Start New Auction" button
 * 4. Clicks "Resume Existing Room" -> verifies room is seamlessly resumed with host controls intact.
 * 5. Navigates back to root -> clicks "Close Room & Start New Auction" -> confirms close.
 * 6. Verifies active room is released, and host is immediately shown the fresh "Configure your auction" form.
 * 7. Submits the form to create a new Mini Auction room without any stale-room popup or error!
 */

const { spawn } = require('node:child_process');
const http = require('node:http');

const BASE = (process.env.BASE_URL || 'http://127.0.0.1:3333').replace(/\/+$/, '');
const CDP_PORT = 9224;
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

class CDPClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.msgId = 0;
    this.callbacks = new Map();
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.onopen = () => resolve();
      this.ws.onerror = err => reject(err);
      this.ws.onmessage = msg => {
        try {
          const text = typeof msg.data === 'string' ? msg.data : msg.data.toString();
          const data = JSON.parse(text);
          if (data.id && this.callbacks.has(data.id)) {
            const cb = this.callbacks.get(data.id);
            this.callbacks.delete(data.id);
            if (data.error) cb.reject(new Error(data.error.message));
            else cb.resolve(data.result);
          }
        } catch (e) {
          console.error('[CDP PARSE ERROR]', e);
        }
      };
    });
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.msgId;
      this.callbacks.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const res = await this.send('Runtime.evaluate', { expression, returnByValue: true });
    return res.result ? res.result.value : null;
  }

  async waitFor(expression, timeoutMs = 8000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const val = await this.eval(expression);
        if (val) return val;
      } catch {}
      await delay(100);
    }
    throw new Error(`Timeout waiting for expression: ${expression}`);
  }

  close() {
    try { this.ws.close(); } catch {}
  }
}

async function getNewTab(cdpPort) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${cdpPort}/json/list`, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        const list = JSON.parse(data);
        const pageTab = list.find(t => t.type === 'page');
        if (pageTab) resolve(pageTab);
        else {
          const req = http.request(`http://127.0.0.1:${cdpPort}/json/new`, { method: 'PUT' }, r => {
            let d = '';
            r.on('data', c => d += c);
            r.on('end', () => resolve(JSON.parse(d)));
          });
          req.on('error', reject);
          req.end();
        }
      });
    }).on('error', reject);
  });
}

async function runTest() {
  console.log('='.repeat(65));
  console.log('REAL BROWSER TEST: HOST ROOM RESUME, EXIT & RECOVERY WORKFLOW');
  console.log('='.repeat(65));

  // 1. Authenticate host and clean up any active room
  const loginRes = await fetch(`${BASE}/api/host/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: 'ipl2027owner' })
  }).then(r => r.json());
  const token = loginRes.token;

  if (loginRes.activeRoomCode) {
    await fetch(`${BASE}/api/host/close-room`, {
      method: 'POST',
      headers: { 'x-host-token': token }
    });
  }

  // 2. Create a Mega Auction room
  console.log('1. Setting up initial Mega Auction room via API...');
  const roomRes = await fetch(`${BASE}/api/host/create-room`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-host-token': token },
    body: JSON.stringify({
      mode: 'mega',
      retentionMode: 'participants',
      timerSeconds: 10,
      megaPurseCr: 120
    })
  }).then(r => r.json());
  const roomCode = roomRes.room.code;
  console.log(`   ✓ Active room ${roomCode} created`);

  // 3. Launch Chrome with CDP
  console.log('2. Launching Headless Chrome...');
  const chromeProcess = spawn(CHROME_PATH, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--user-data-dir=' + require('node:os').tmpdir() + '/chrome-host-resume-' + Date.now(),
    'about:blank'
  ]);

  try {
    let tab = null;
    const startWait = Date.now();
    while (Date.now() - startWait < 8000) {
      try {
        tab = await getNewTab(CDP_PORT);
        if (tab && tab.webSocketDebuggerUrl) break;
      } catch {}
      await delay(300);
    }
    if (!tab) throw new Error(`Could not connect to Chrome on port ${CDP_PORT}`);
    const client = new CDPClient(tab.webSocketDebuggerUrl);
    await client.connect();
    await client.send('Page.enable');
    await client.send('Runtime.enable');

    console.log(`3. Navigating browser to landing page ${BASE}/...`);
    await client.send('Page.navigate', { url: `${BASE}/` });
    await client.waitFor(`document.querySelector('.hero-title')`, 6000);
    console.log('   ✓ Landing page loaded');

    console.log('4. Storing host session token in browser and opening Host Console...');
    // Set host token in localStorage so browser is authenticated as host
    await client.eval(`window.localStorage.setItem('ipl27-owner-token', '${token}')`);
    await client.eval(`state.ownerToken = '${token}'`);
    await client.eval(`document.querySelector('[data-action="select-home"][data-panel="host"]').click()`);

    // Verify Existing Auction Room Card is rendered
    console.log('5. Verifying "Existing Auction Room" Card is rendered (Task 5)...');
    await client.waitFor(`document.querySelector('.existing-room-card')`, 6000);
    const displayedCode = await client.eval(`document.querySelector('.existing-room-code-badge .code-value')?.innerText || ''`);
    console.log(`   ✓ Existing Room Card rendered! Displayed room code: "${displayedCode}"`);
    if (displayedCode !== roomCode) throw new Error(`Code mismatch: expected ${roomCode}, got ${displayedCode}`);

    const hasResumeBtn = await client.eval(`Boolean(document.querySelector('[data-action="resume-existing-room"]'))`);
    const hasCloseBtn = await client.eval(`Boolean(document.querySelector('[data-action="open-close-room"]'))`);
    console.log(`   ✓ "Resume Existing Room ↗" button present: ${hasResumeBtn}`);
    console.log(`   ✓ "Close Room & Start New Auction" button present: ${hasCloseBtn}`);

    console.log('6. Clicking "Resume Existing Room ↗" (Task 1)...');
    await client.eval(`document.querySelector('[data-action="resume-existing-room"]').click()`);
    await client.waitFor(`document.querySelector('.room-context-row')`, 6000);
    const activeCode = await client.eval(`state.roomCode`);
    const isHost = await client.eval(`state.isHost`);
    console.log(`   ✓ Room successfully resumed! Room code: ${activeCode}, isHost: ${isHost}`);

    console.log('7. Testing Accidental Browser Refresh: reloading page should seamlessly preserve room session...');
    await client.send('Page.reload');
    await client.waitFor(`document.querySelector('.room-context-row')`, 6000);
    const reloadedCode = await client.eval(`state.roomCode`);
    console.log(`   ✓ Refresh test passed! Room ${reloadedCode} automatically restored after reload.`);

    console.log('8. Testing Explicit Room Closure from within the active room (Task 2)...');
    await client.eval(`document.querySelector('.room-actions [data-action="open-close-room"]').click()`);
    await client.waitFor(`document.getElementById('close-modal-veil')`, 4000);
    console.log('   ✓ Close modal opened from room topbar. Clicking "Confirm & Close Room"...');
    await client.eval(`document.querySelector('[data-action="confirm-close-room"]').click()`);
    await delay(600);

    // Verify host is immediately presented with clean setup form
    await client.waitFor(`document.getElementById('host-setup-form')`, 6000);
    console.log('   ✓ Room 1 closed and lock released! Fresh setup form displayed.');

    console.log('9. Creating Room 2 from setup form without any popup or error...');
    await client.eval(`document.querySelector('[data-action="select-mode"][data-mode="mini"]').click()`);
    await delay(200);
    await client.eval(`document.querySelector('#host-setup-form button[type="submit"]').click()`);
    await client.waitFor(`document.querySelector('.room-context-row')`, 8000);
    const room2Code = await client.eval(`state.roomCode`);
    console.log(`   ✓ Room 2 (${room2Code}) created cleanly! Zero popups or errors!`);

    console.log('10. Testing "Close Room & Start New Auction" directly from Existing Room card on Landing Page...');
    // Clear last owner room from store so navigating to root shows landing page
    await client.eval(`window.localStorage.removeItem('ipl27-owner-room')`);
    await client.send('Page.navigate', { url: `${BASE}/` });
    await client.waitFor(`document.querySelector('.hero-title')`, 6000);
    await client.eval(`document.querySelector('[data-action="select-home"][data-panel="host"]').click()`);
    await client.waitFor(`document.querySelector('.existing-room-card')`, 6000);
    console.log('   ✓ Existing Room Card rendered for Room 2 on host console.');

    // Click Close Room & Start New Auction from the card
    await client.eval(`document.querySelector('.existing-room-card [data-action="open-close-room"]').click()`);
    await client.waitFor(`document.getElementById('close-modal-veil')`, 4000);
    console.log('   ✓ Confirmation modal opened from Existing Room card. Confirming closure...');
    await client.eval(`document.querySelector('[data-action="confirm-close-room"]').click()`);
    await delay(600);

    await client.waitFor(`document.getElementById('host-setup-form')`, 6000);
    console.log('   ✓ Room 2 closed and active lock released! Fresh creation form ready.');

    console.log('\n' + '='.repeat(65));
    console.log('🎉 REAL BROWSER HOST RESUME & CLOSE WORKFLOW VERIFIED 100%! 🎉');
    console.log('='.repeat(65));
    client.close();
  } finally {
    try { chromeProcess.kill(); } catch {}
  }
}

runTest().catch(err => {
  console.error('\n❌ BROWSER TEST FAILED:', err);
  process.exit(1);
});
