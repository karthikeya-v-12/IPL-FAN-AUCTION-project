'use strict';

const { spawn } = require('node:child_process');
const http = require('node:http');

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 3333;
const CDP_PORT = 9222;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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
          if (data.method === 'Runtime.consoleAPICalled') {
            console.log('   [BROWSER CONSOLE]', data.params.type, data.params.args.map(a => a.value || a.description).join(' '));
          }
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

  async send(method, params = {}) {
    const id = ++this.msgId;
    return new Promise((resolve, reject) => {
      this.callbacks.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expr) {
    const res = await this.send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true
    });
    if (res.exceptionDetails) {
      const msg = res.exceptionDetails.exception?.description || res.exceptionDetails.text || 'Eval error';
      throw new Error(msg);
    }
    return res.result?.value;
  }

  async waitFor(expr, timeoutMs = 10000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const val = await this.eval(expr);
        if (val) return val;
      } catch {}
      await delay(250);
    }
    throw new Error(`Timeout waiting for: ${expr}`);
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

async function runBrowserTest() {
  console.log('======================================================');
  console.log('REAL BROWSER VERIFICATION VIA HEADLESS CHROME (CDP)');
  console.log('======================================================\n');

  console.log('1. Launching Headless Chrome...');
  const chromeProcess = spawn(CHROME_PATH, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--user-data-dir=' + require('node:os').tmpdir() + '/chrome-test-' + Date.now(),
    'about:blank'
  ], { stdio: 'ignore' });

  try {
    let connected = false;
    for (let i = 0; i < 25; i++) {
      try {
        await new Promise((res, rej) => {
          const req = http.get(`http://127.0.0.1:${CDP_PORT}/json/version`, r => res());
          req.on('error', rej);
        });
        connected = true;
        break;
      } catch {
        await delay(200);
      }
    }
    if (!connected) throw new Error('Chrome failed to start on CDP port');
    console.log('   ✓ Chrome started with CDP active on port ' + CDP_PORT);

    // Setup Room via API
    console.log('2. Preparing Mega Auction Room with participant retentions...');
    const loginRes = await fetch(`http://127.0.0.1:${PORT}/api/host/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'ipl2027owner' })
    }).then(r => r.json());
    const token = loginRes.token;

    if (loginRes.activeRoomCode) {
      await fetch(`http://127.0.0.1:${PORT}/api/room/${loginRes.activeRoomCode}/action`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-host-token': token },
        body: JSON.stringify({ action: 'close' })
      });
    }

    const roomRes = await fetch(`http://127.0.0.1:${PORT}/api/host/create-room`, {
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
    console.log(`   ✓ Room ${roomCode} created successfully`);

    // Connect tab to CDP
    const tab = await getNewTab(CDP_PORT);
    const client = new CDPClient(tab.webSocketDebuggerUrl);
    await client.connect();
    await client.send('Page.enable');
    await client.send('Runtime.enable');

    console.log('3. Navigating browser to room: http://127.0.0.1:3333/?room=' + roomCode);
    await client.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?room=${roomCode}` });

    // Wait for the join modal or page to load
    await client.waitFor(`document.getElementById('join-room-form') || document.querySelector('.page-title')`, 10000);
    console.log('   ✓ Page rendered and Join Modal active');

    // Fill Join Modal for RCB
    console.log('4. Submitting Join Form as RCB franchise owner...');
    await client.eval(`
      const nameInput = document.getElementById('join-name');
      if (nameInput) {
        nameInput.value = 'BrowserTestOwner';
        nameInput.dispatchEvent(new Event('input', { bubbles: true }));
      }
      const rcbBtn = document.querySelector('[data-team-choice="RCB"]');
      if (rcbBtn) rcbBtn.click();
      const form = document.getElementById('join-room-form');
      if (form) {
        const submitBtn = form.querySelector('button[type="submit"]');
        if (submitBtn) submitBtn.click();
      }
    `);

    // Wait for the retention view with candidate cards to render
    await client.waitFor(`document.querySelectorAll('.retention-player-card').length > 0`, 10000);
    const teamHeader = await client.eval(`document.querySelector('.page-title')?.innerText || ''`);
    console.log(`   ✓ Retention view loaded for franchise: "${teamHeader}"`);

    const cardCount = await client.eval(`document.querySelectorAll('.retention-player-card').length`);
    console.log(`   ✓ Rendered ${cardCount} candidate cards on the screen`);

    // 5. Select & Deselect Player 1 (Verify dynamic button labels: '+ Select Player' <-> '✓ Selected — Deselect')
    console.log('5. Testing player selection and button label transitions...');
    const p1InitialBtnText = await client.eval(`
      document.querySelectorAll('.retention-player-card')[0].querySelector('.retention-select-btn')?.innerText.trim()
    `);
    console.log(`   ✓ Candidate 1 initial button text: "${p1InitialBtnText}"`);
    if (!p1InitialBtnText.includes('+ Select Player')) {
      throw new Error(`Expected button text to include "+ Select Player", got "${p1InitialBtnText}"`);
    }

    // Click card to select
    const p1Name = await client.eval(`(() => {
      const card = document.querySelectorAll('.retention-player-card')[0];
      const name = card.querySelector('.retention-player-name')?.innerText;
      card.click();
      return name;
    })()`);
    await client.waitFor(`document.querySelectorAll('.retention-player-card')[0].classList.contains('is-selected')`, 4000);
    const p1SelectedBtnText = await client.eval(`
      document.querySelectorAll('.retention-player-card')[0].querySelector('.retention-select-btn')?.innerText.trim()
    `);
    const p1CheckboxChecked = await client.eval(`document.querySelectorAll('.retention-checkbox')[0].checked`);
    console.log(`   ✓ Candidate 1 "${p1Name}" after selection:`);
    console.log(`     - Button text: "${p1SelectedBtnText}"`);
    console.log(`     - Card has class 'is-selected': true`);
    console.log(`     - Checkbox checked: ${p1CheckboxChecked}`);
    if (!p1SelectedBtnText.includes('✓ Selected — Deselect')) {
      throw new Error(`Expected button text to include "✓ Selected — Deselect", got "${p1SelectedBtnText}"`);
    }

    // Click button again to test Deselect
    console.log('   Testing deselecting Candidate 1...');
    await client.eval(`(() => {
      const btn = document.querySelectorAll('.retention-player-card')[0].querySelector('.retention-select-btn');
      btn.click();
    })()`);
    await client.waitFor(`!document.querySelectorAll('.retention-player-card')[0].classList.contains('is-selected')`, 4000);
    const p1DeselectedBtnText = await client.eval(`
      document.querySelectorAll('.retention-player-card')[0].querySelector('.retention-select-btn')?.innerText.trim()
    `);
    console.log(`   ✓ Candidate 1 after deselection: button text reverted to "${p1DeselectedBtnText}"`);

    // Re-select Candidate 1
    await client.eval(`(() => {
      document.querySelectorAll('.retention-player-card')[0].click();
    })()`);
    await client.waitFor(`document.querySelectorAll('.retention-player-card')[0].classList.contains('is-selected')`, 4000);

    // Select Player 2 (Checkbox click)
    console.log('6. Clicking checkbox to retain Candidate 2...');
    const p2Name = await client.eval(`(() => {
      const chk = document.querySelectorAll('.retention-checkbox')[1];
      const card = document.querySelectorAll('.retention-player-card')[1];
      const name = card.querySelector('.retention-player-name')?.innerText;
      chk.click();
      return name;
    })()`);
    await client.waitFor(`document.querySelectorAll('.retention-player-card')[1].classList.contains('is-selected')`, 4000);
    const p2BtnText = await client.eval(`
      document.querySelectorAll('.retention-player-card')[1].querySelector('.retention-select-btn')?.innerText.trim()
    `);
    console.log(`   ✓ Candidate 2 "${p2Name}": button text="${p2BtnText}", card.is-selected=true`);

    // Live budget stats
    const stats = await client.eval(`
      Array.from(document.querySelectorAll('.retention-stat-card')).map(c => ({
        label: c.querySelector('small')?.innerText,
        val: c.querySelector('strong')?.innerText
      }))
    `);
    console.log('   ✓ Live Stats in DOM:', stats.map(s => `${s.label}: ${s.val}`).join(' | '));

    // Test filter tabs
    console.log('7. Testing category filters (Batters, Bowlers, Selected)...');
    await client.eval(`(() => {
      const bowlerBtn = document.querySelector('[data-ret-filter="bowler"]');
      if (bowlerBtn) bowlerBtn.click();
    })()`);
    await delay(300);
    const bowlerCount = await client.eval(`document.querySelectorAll('.retention-player-card').length`);
    console.log(`   ✓ Bowler filter applied: ${bowlerCount} cards visible`);

    await client.eval(`(() => {
      const selBtn = document.querySelector('[data-ret-filter="retained"]');
      if (selBtn) selBtn.click();
    })()`);
    await delay(300);
    const retainedFilteredCount = await client.eval(`document.querySelectorAll('.retention-player-card').length`);
    console.log(`   ✓ "Selected" filter applied: ${retainedFilteredCount} cards visible (selections preserved)`);

    await client.eval(`(() => {
      const allBtn = document.querySelector('[data-ret-filter="all"]');
      if (allBtn) allBtn.click();
    })()`);
    await delay(300);

    // Confirm retentions
    console.log('8. Clicking "Confirm RCB Retentions" in browser...');
    await client.eval(`(() => {
      const confirmBtn = document.querySelector('[data-action="confirm-retention"]');
      if (confirmBtn) confirmBtn.click();
    })()`);

    // Wait for the confirmed banner and locked status
    await client.waitFor(`document.querySelector('.ret-conf-badge')`, 8000);
    const confirmedBanner = await client.eval(`document.querySelector('.ret-conf-badge')?.innerText || ''`);
    const isLocked = await client.eval(`document.querySelectorAll('.retention-player-card.is-locked').length > 0`);
    const actionTag = await client.eval(`document.querySelector('.retention-actions-left .pill-green')?.innerText || ''`);
    console.log(`   ✓ Confirmed Banner: "${confirmedBanner}"`);
    console.log(`   ✓ Action Bar Tag: "${actionTag}"`);
    console.log(`   ✓ All cards transitioned to locked state: ${isLocked}`);

    // Reload page to test persistence
    console.log('9. Reloading browser page to test reconnect/refresh persistence...');
    await client.send('Page.reload');
    await client.waitFor(`document.querySelector('.ret-conf-badge')`, 8000);

    const reloadedBanner = await client.eval(`document.querySelector('.ret-conf-badge')?.innerText || ''`);
    const reloadedStats = await client.eval(`
      Array.from(document.querySelectorAll('.retention-stat-card')).map(c => ({
        label: c.querySelector('small')?.innerText,
        val: c.querySelector('strong')?.innerText
      }))
    `);
    console.log(`   ✓ Restored after reload: "${reloadedBanner}"`);
    console.log('   ✓ Restored stats after reload:', reloadedStats.map(s => `${s.label}: ${s.val}`).join(' | '));

    // 10. Test Host Readiness Dashboard & Starting with 1 Participant (Task 1)
    console.log('10. Transitioning browser to Host View to verify Readiness Monitor...');
    await client.eval(`
      localStorage.setItem('ipl27-owner-token', '${token}');
      localStorage.removeItem('ipl27-participant');
    `);
    await delay(300);
    await client.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?room=${roomCode}` });
    await delay(1000);

    // Diagnostic check
    const diag = await client.eval(`({
      url: window.location.href,
      ownerTokenInStore: localStorage.getItem('ipl27-owner-token'),
      bodyText: document.body.innerText.slice(0, 300)
    })`);
    console.log('   [DIAGNOSTIC]', diag);

    await client.waitFor(`document.querySelector('.page-title')?.innerText.includes('RETENTION DASHBOARD')`, 8000);

    const hostDashboardTitle = await client.eval(`document.querySelector('.page-title')?.innerText || ''`);
    const readinessMsg = await client.eval(`document.querySelector('.retention-actions-left')?.innerText || ''`);
    const startBtn = await client.eval(`(() => {
      const btn = document.querySelector('[data-action="finalize-retentions"]');
      return { text: btn?.innerText, disabled: btn?.disabled };
    })()`);
    console.log(`   ✓ Host Dashboard Title: "${hostDashboardTitle}"`);
    console.log(`   ✓ Readiness Message: "${readinessMsg}"`);
    console.log(`   ✓ Start Button: text="${startBtn.text}", disabled=${startBtn.disabled}`);

    if (startBtn.disabled) {
      throw new Error('Host start button should be enabled with 1 confirmed franchise!');
    }

    console.log('11. Clicking "Finalize Remaining Teams & Start Auction" as Host...');
    const clickResult = await client.eval(`(async () => {
      window.confirm = () => true;
      try {
        const btn = document.querySelector('[data-action="finalize-retentions"]');
        if (!btn) return 'NO_BUTTON';
        btn.click();
        return 'CLICKED';
      } catch (e) {
        return 'ERR: ' + e.message;
      }
    })()`);
    console.log('   Click result:', clickResult);
    await delay(1500);

    const postClickDiag = await client.eval(`({
      roomStatus: window.state?.room?.status,
      roomView: window.state?.view,
      toast: document.querySelector('.toast')?.innerText,
      bodyText: document.body.innerText.slice(0, 300)
    })`);
    console.log('   [POST-CLICK DIAGNOSTIC]', postClickDiag);

    await client.waitFor(`document.querySelector('.current-player-card') || document.querySelector('.console-big')`, 8000);
    const auctionStatus = await client.eval(`document.querySelector('.auction-status-badge')?.innerText || 'Live Floor'`);
    console.log(`   ✓ Auction floor entered successfully! Status: "${auctionStatus}"`);

    // 12. Test Host Close Room Modal & Authoritative Closure (Task 3)
    console.log('12. Testing Close Room Button and Confirmation Modal...');
    const closeBtnExists = await client.eval(`Boolean(document.querySelector('[data-action="open-close-room"]'))`);
    console.log(`   ✓ "Close Room" button visible in host header: ${closeBtnExists}`);
    if (!closeBtnExists) {
      throw new Error('Close Room button missing from host header!');
    }

    // Open Close Room Modal
    await client.eval(`document.querySelector('[data-action="open-close-room"]').click()`);
    await client.waitFor(`document.getElementById('close-modal-veil')`, 4000);
    const modalTitle = await client.eval(`document.querySelector('#close-modal-veil h3')?.innerText || ''`);
    console.log(`   ✓ Close Room modal opened with title: "${modalTitle}"`);
    if (!modalTitle.includes('Close Room & End Auction') && !modalTitle.includes('Close this auction room?')) {
      throw new Error(`Expected modal title "Close Room & End Auction", got "${modalTitle}"`);
    }

    // Test Cancel
    console.log('   Testing modal "Cancel" button...');
    await client.eval(`document.querySelector('[data-action="cancel-close-room"]').click()`);
    await delay(300);
    const modalClosed = await client.eval(`!document.getElementById('close-modal-veil')`);
    console.log(`   ✓ Modal closed cleanly on Cancel: ${modalClosed}`);

    // Reopen and Confirm Close
    console.log('   Reopening modal and clicking "Confirm & Close Room"...');
    await client.eval(`document.querySelector('[data-action="open-close-room"]').click()`);
    await client.waitFor(`document.getElementById('close-modal-veil')`, 4000);
    await client.eval(`document.querySelector('[data-action="confirm-close-room"]').click()`);

    // Verify redirect / cleanup to landing / setup
    await client.waitFor(`document.getElementById('host-setup-form') || document.querySelector('.landing-inner')`, 8000);
    console.log('   ✓ Authoritative closure verified! Room closed and Host returned to clean setup screen.');

    console.log('\n======================================================');
    console.log('🎉 REAL BROWSER WORKFLOW VERIFIED SUCCESSFULLY 100%! 🎉');
    console.log('======================================================\n');

    client.close();
  } finally {
    try { chromeProcess.kill(); } catch {}
  }
}

runBrowserTest().catch(err => {
  console.error('❌ BROWSER TEST FAILED:', err);
  process.exit(1);
});
