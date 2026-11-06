'use strict';

const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 3333;
const CDP_PORT = 9333;
const SCREENSHOT_DIR = path.join(__dirname, '..', 'screenshots');

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

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
          const data = JSON.parse(msg.data.toString());
          if (data.id && this.callbacks.has(data.id)) {
            const cb = this.callbacks.get(data.id);
            this.callbacks.delete(data.id);
            if (data.error) cb.reject(new Error(data.error.message));
            else cb.resolve(data.result);
          }
        } catch {}
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
    const res = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return res.result?.value;
  }

  async waitFor(expr, timeoutMs = 10000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const val = await this.eval(expr);
        if (val) return val;
      } catch {}
      await delay(200);
    }
    throw new Error('Timeout waiting for: ' + expr);
  }

  async screenshot(filePath, clip = null) {
    const params = { format: 'png' };
    if (clip) params.clip = clip;
    const res = await this.send('Page.captureScreenshot', params);
    fs.writeFileSync(filePath, Buffer.from(res.data, 'base64'));
    console.log('   Saved screenshot: ' + path.basename(filePath));
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

async function captureBaselines() {
  console.log('=== CAPTURING BASELINE SCREENSHOTS (BEFORE CHANGES) ===');
  const chromeProcess = spawn(CHROME_PATH, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    '--disable-gpu',
    '--no-first-run',
    '--user-data-dir=' + require('node:os').tmpdir() + '/chrome-baseline-' + Date.now(),
    'about:blank'
  ], { stdio: 'ignore' });

  try {
    let connected = false;
    for (let i = 0; i < 25; i++) {
      try {
        await new Promise((res, rej) => {
          http.get(`http://127.0.0.1:${CDP_PORT}/json/version`, r => res()).on('error', rej);
        });
        connected = true;
        break;
      } catch { await delay(200); }
    }
    if (!connected) throw new Error('Chrome failed to start');

    const tab = await getNewTab(CDP_PORT);
    const client = new CDPClient(tab.webSocketDebuggerUrl);
    await client.connect();
    await client.send('Page.enable');
    await client.send('Runtime.enable');

    // 1. Desktop Host Setup (1440x900)
    console.log('\n1. Desktop Host Setup Baseline (1440x900)...');
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false
    });

    // Make sure no active room is hanging
    const loginRes = await fetch(`http://127.0.0.1:${PORT}/api/host/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'ipl2027owner' })
    }).then(r => r.json());
    if (loginRes.activeRoomCode) {
      await fetch(`http://127.0.0.1:${PORT}/api/room/${loginRes.activeRoomCode}/action`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-host-token': loginRes.token },
        body: JSON.stringify({ action: 'close' })
      });
    }

    await client.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
    await client.waitFor(`document.querySelector('.btn')`, 8000);

    // Click "Host an auction" button
    await client.eval(`
      const hostBtn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('Host an auction'));
      if (hostBtn) hostBtn.click();
    `);
    await delay(300);

    // Fill owner code and unlock
    await client.eval(`
      const codeInput = document.getElementById('owner-code');
      if (codeInput) {
        codeInput.value = 'ipl2027owner';
        codeInput.dispatchEvent(new Event('input', { bubbles: true }));
      }
      const form = document.getElementById('owner-login-form');
      if (form) {
        const btn = form.querySelector('button[type=\"submit\"]');
        if (btn) btn.click();
      }
    `);
    await client.waitFor(`document.getElementById('host-setup-form')`, 8000);
    await delay(500);

    // Capture Desktop Host Setup (Mini Mode)
    await client.screenshot(path.join(SCREENSHOT_DIR, 'before-desktop-host-setup-mini.png'));

    // Switch to Mega Mode
    await client.eval(`
      const megaBtn = document.querySelector('[data-mode=\"mega\"]');
      if (megaBtn) megaBtn.click();
    `);
    await delay(500);
    await client.screenshot(path.join(SCREENSHOT_DIR, 'before-desktop-host-setup-mega.png'));

    // 2. Mobile Host Setup (390x844)
    console.log('\n2. Mobile Host Setup Baseline (390x844)...');
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      mobile: true
    });
    await delay(500);
    await client.screenshot(path.join(SCREENSHOT_DIR, 'before-mobile-host-setup-mega.png'));

    // Switch back to mini on mobile
    await client.eval(`
      const miniBtn = document.querySelector('[data-mode=\"mini\"]');
      if (miniBtn) miniBtn.click();
    `);
    await delay(500);
    await client.screenshot(path.join(SCREENSHOT_DIR, 'before-mobile-host-setup-mini.png'));

    // 3. Create a room and start live auction for Auction Floor Baselines
    console.log('\n3. Creating Room & Starting Auction for Floor Baselines...');
    await client.eval(`
      const setupForm = document.getElementById('host-setup-form');
      if (setupForm) {
        const submit = setupForm.querySelector('button[type=\"submit\"]');
        if (submit) submit.click();
      }
    `);
    await client.waitFor(`document.querySelector('.room-context-row')`, 8000);

    // Start auction
    console.log('   Clicking start-auction button...');
    await client.eval(`
      const startBtn = document.querySelector('[data-action="start-auction"]');
      if (startBtn) startBtn.click();
    `);
    await client.waitFor(`document.querySelector('.player-focus')`, 8000);
    await delay(600);

    // Desktop Auction Floor (1440x900)
    console.log('\n4. Desktop Auction Floor Baseline (1440x900)...');
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false
    });
    await delay(500);
    await client.screenshot(path.join(SCREENSHOT_DIR, 'before-desktop-auction-floor.png'));

    // Mobile Auction Floor (390x844)
    console.log('\n5. Mobile Auction Floor Baseline (390x844)...');
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      mobile: true
    });
    await delay(500);
    await client.screenshot(path.join(SCREENSHOT_DIR, 'before-mobile-auction-floor.png'));

    // Clean up room
    const currentCode = await client.eval(`window.state?.roomCode || ''`);
    if (currentCode) {
      await fetch(`http://127.0.0.1:${PORT}/api/room/${currentCode}/action`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-host-token': loginRes.token },
        body: JSON.stringify({ action: 'close' })
      });
    }

    client.close();
    console.log('\n✓ ALL BASELINE SCREENSHOTS CAPTURED SUCCESSFULLY!');
  } finally {
    try { chromeProcess.kill(); } catch {}
  }
}

captureBaselines().catch(err => {
  console.error('Failed to capture baselines:', err);
  process.exit(1);
});
