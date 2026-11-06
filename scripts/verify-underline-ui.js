'use strict';

const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 3333;
const CDP_PORT = 9334;
const SCREENSHOT_DIR = path.join(__dirname, '..', 'screenshots', 'underline-verification');
if (!fs.existsSync(SCREENSHOT_DIR)) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

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

  async screenshot(filePath) {
    const res = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(filePath, Buffer.from(res.data, 'base64'));
    console.log('   📸 Saved screenshot: ' + path.basename(filePath));
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

async function main() {
  console.log('================================================================');
  console.log('UNDERLINE STYLING & RED BACKGROUND PRESERVATION VERIFICATION');
  console.log('================================================================');

  // Start local server if not running
  const isRunning = await new Promise(res => {
    const r = http.get(`http://127.0.0.1:${PORT}/api/health`, rep => res(rep.statusCode === 200));
    r.on('error', () => res(false));
  });

  let serverProc = null;
  if (!isRunning) {
    console.log('[1/4] Starting auction test server...');
    serverProc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      cwd: path.join(__dirname, '..'),
      stdio: 'pipe',
      env: { ...process.env, PORT: String(PORT) }
    });
    await delay(2000);
  }

  console.log('[2/4] Launching Headless Chrome with CDP...');
  const tmpDir = path.join(require('node:os').tmpdir(), 'chrome-underline-' + Date.now());
  const chromeProcess = spawn(CHROME_PATH, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    '--disable-gpu',
    '--no-first-run',
    `--user-data-dir=${tmpDir}`,
    'about:blank'
  ], { stdio: 'ignore' });

  let client = null;
  try {
    let connected = false;
    for (let i = 0; i < 30; i++) {
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
    client = new CDPClient(tab.webSocketDebuggerUrl);
    await client.connect();
    await client.send('Page.enable');
    await client.send('DOM.enable');
    await client.send('CSS.enable');
    await client.send('Runtime.enable');

    const consoleErrors = [];
    client.ws.addEventListener('message', msg => {
      try {
        const d = JSON.parse(msg.data.toString());
        if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') {
          consoleErrors.push(d.params.args.map(a => a.value || a.description).join(' '));
        }
      } catch {}
    });

    console.log('[3/4] Navigating to http://127.0.0.1:' + PORT + '...');
    await client.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
    await delay(1500);

    // Inject verification test panel into DOM
    console.log('[4/4] Injecting underline test matrix into DOM and measuring computed styles...');
    const injectResult = await client.eval(`
      (() => {
        const testPanel = document.createElement('div');
        testPanel.id = 'underline-test-matrix';
        testPanel.style.cssText = 'position:relative; z-index:9999; margin:20px; padding:24px; background:#101d2b; border:2px solid #a9bed240; border-radius:14px; display:grid; gap:16px; font-family:"DM Sans", sans-serif;';
        testPanel.innerHTML = \`
          <h2 style="margin:0 0 10px; color:#f3f6f8;">Underline Verification Matrix</h2>
          
          <!-- Test 1: Plain <u> element -->
          <div id="test1-wrap" style="padding:10px; background:#142436; border-radius:8px;">
            <u id="test1-el">Test 1: Standard White Underlined Text Becomes Black</u>
          </div>

          <!-- Test 2: Red background button with <u> -->
          <div id="test2-wrap" style="padding:10px; background:#142436; border-radius:8px;">
            <button id="test2-btn" class="btn btn-primary">
              <u id="test2-el">Test 2: Bid Button with Red Background & Underline</u>
            </button>
          </div>

          <!-- Test 3: Red background element with .underline class -->
          <div id="test3-wrap" style="padding:10px; background:#142436; border-radius:8px;">
            <div id="test3-box" class="underline" style="background: rgb(215, 25, 32); padding: 10px 14px; border-radius: 6px; display:inline-block;">
              <span id="test3-el">Test 3: Box with Red Background & .underline class</span>
            </div>
          </div>

          <!-- Test 4: Bold underlined text -->
          <div id="test4-wrap" style="padding:10px; background:#142436; border-radius:8px;">
            <u id="test4-u1"><strong>Test 4A: u > strong bold text</strong></u> &nbsp;
            <strong><u id="test4-u2">Test 4B: strong > u bold text</u></strong> &nbsp;
            <span class="underline"><b id="test4-b">Test 4C: .underline > b bold text</b></span>
          </div>

          <!-- Test 5: Underlined text without a background (transparent/inherit) -->
          <div id="test5-wrap" style="padding:10px; background:#142436; border-radius:8px;">
            <u id="test5-el" style="padding:4px;">Test 5: Underline without background retains navy parent</u>
          </div>

          <!-- Test 6: Ordinary non-underlined white text remains white -->
          <div id="test6-wrap" style="padding:10px; background:#142436; border-radius:8px;">
            <span id="test6-el">Test 6: Ordinary non-underlined text remains white</span>
          </div>

          <!-- Test 7: Nested elements with icons/SVGs -->
          <div id="test7-wrap" style="padding:10px; background:#142436; border-radius:8px; display:flex; gap:16px; align-items:center;">
            <u id="test7-u-svg">
              <svg id="test7-svg" width="20" height="20" viewBox="0 0 24 24" style="vertical-align:middle;">
                <circle id="test7-svg-circle" cx="12" cy="12" r="10" fill="#D71920" />
              </svg>
              <span id="test7-svg-text">Test 7A: SVG inside underline retains red circle</span>
            </u>

            <u id="test7-u-icon">
              <span id="test7-rule-icon" class="rule-icon">⚡</span>
              <span id="test7-rule-text">Test 7B: App icon inside underline</span>
            </u>

            <u id="test7-u-rupee">
              <span id="test7-rupee-icon" class="bid-btn-rupee">₹</span>
              <span id="test7-rupee-text">14.00 Cr</span>
            </u>
          </div>

          <!-- Test 8: Ticket ribbon with red background and underline -->
          <div id="test8-wrap" style="padding:10px; background:#142436; border-radius:8px;">
            <div class="ticket-ribbon">
              <b id="test8-ribbon-b"><u>Test 8: Ticket ribbon red badge with underline</u></b>
            </div>
          </div>
        \`;
        document.body.prepend(testPanel);
        return true;
      })()
    `);

    assert.strictEqual(injectResult, true, 'Test matrix should inject successfully');

    // Run computed style verifications
    const results = await client.eval(`
      (() => {
        function getRGB(el) {
          const s = window.getComputedStyle(el);
          return {
            color: s.color,
            bgColor: s.backgroundColor,
            textDecoration: s.textDecorationLine || s.textDecoration,
            textFillColor: s.webkitTextFillColor
          };
        }

        return {
          test1: getRGB(document.getElementById('test1-el')),
          test2Btn: getRGB(document.getElementById('test2-btn')),
          test2El: getRGB(document.getElementById('test2-el')),
          test3Box: getRGB(document.getElementById('test3-box')),
          test3El: getRGB(document.getElementById('test3-el')),
          test4A: getRGB(document.getElementById('test4-u1').querySelector('strong')),
          test4B: getRGB(document.getElementById('test4-u2')),
          test4C: getRGB(document.getElementById('test4-b')),
          test5: getRGB(document.getElementById('test5-el')),
          test6: getRGB(document.getElementById('test6-el')),
          test7SvgText: getRGB(document.getElementById('test7-svg-text')),
          test7SvgCircleFill: window.getComputedStyle(document.getElementById('test7-svg-circle')).fill,
          test7RuleIcon: getRGB(document.getElementById('test7-rule-icon')),
          test7RuleText: getRGB(document.getElementById('test7-rule-text')),
          test7RupeeText: getRGB(document.getElementById('test7-rupee-text')),
          test8RibbonB: getRGB(document.getElementById('test8-ribbon-b')),
          test8RibbonU: getRGB(document.getElementById('test8-ribbon-b').querySelector('u'))
        };
      })()
    `);

    console.log('\n--- COMPUTED STYLE AUDIT RESULTS ---');
    console.log('Test 1 (Plain <u> text):', results.test1.color, '(text-decoration:', results.test1.textDecoration, ')');
    assert.strictEqual(results.test1.color, 'rgb(0, 0, 0)', 'Test 1: <u> text must be pure black rgb(0,0,0)');
    assert(results.test1.textDecoration.includes('underline'), 'Test 1: text-decoration must include underline');

    console.log('Test 2 (Red button with <u>): button bg =', results.test2Btn.bgColor, ', text color =', results.test2El.color);
    assert.strictEqual(results.test2El.color, 'rgb(0, 0, 0)', 'Test 2: Underlined text in button must be pure black rgb(0,0,0)');
    assert.strictEqual(results.test2Btn.bgColor, 'rgb(215, 25, 32)', 'Test 2: Button background must remain RCB red rgb(215, 25, 32)');

    console.log('Test 3 (.underline box with red bg): box bg =', results.test3Box.bgColor, ', text color =', results.test3El.color);
    assert.strictEqual(results.test3El.color, 'rgb(0, 0, 0)', 'Test 3: Inner span text in .underline box must be pure black rgb(0,0,0)');
    assert.strictEqual(results.test3Box.bgColor, 'rgb(215, 25, 32)', 'Test 3: Box background must remain exact red rgb(215, 25, 32)');

    console.log('Test 4 (Bold underlined text):');
    console.log('   4A (u > strong):', results.test4A.color);
    console.log('   4B (strong > u):', results.test4B.color);
    console.log('   4C (.underline > b):', results.test4C.color);
    assert.strictEqual(results.test4A.color, 'rgb(0, 0, 0)', 'Test 4A: u > strong must be black');
    assert.strictEqual(results.test4B.color, 'rgb(0, 0, 0)', 'Test 4B: strong > u must be black');
    assert.strictEqual(results.test4C.color, 'rgb(0, 0, 0)', 'Test 4C: .underline > b must be black');

    console.log('Test 5 (Underline without background):', results.test5.color, ', bg =', results.test5.bgColor);
    assert.strictEqual(results.test5.color, 'rgb(0, 0, 0)', 'Test 5: Underlined text must be black');
    assert(results.test5.bgColor === 'rgba(0, 0, 0, 0)' || results.test5.bgColor === 'transparent', 'Test 5: Background should not be artificially added');

    console.log('Test 6 (Ordinary non-underlined text):', results.test6.color);
    assert.notStrictEqual(results.test6.color, 'rgb(0, 0, 0)', 'Test 6: Non-underlined text must NOT become black');

    console.log('Test 7 (SVGs and icons):');
    console.log('   7A SVG circle fill:', results.test7SvgCircleFill);
    console.log('   7B Rule icon color:', results.test7RuleIcon.color, ', text color:', results.test7RuleText.color);
    assert.strictEqual(results.test7SvgText.color, 'rgb(0, 0, 0)', 'Test 7A: Text with SVG must be black');
    assert.strictEqual(results.test7SvgCircleFill, 'rgb(215, 25, 32)', 'Test 7A: SVG red circle fill must be preserved');
    assert.strictEqual(results.test7RuleIcon.color, 'rgb(215, 25, 32)', 'Test 7B: Rule icon must remain RCB red');
    assert.strictEqual(results.test7RuleText.color, 'rgb(0, 0, 0)', 'Test 7B: Text beside rule icon must be black');
    assert.strictEqual(results.test7RupeeText.color, 'rgb(0, 0, 0)', 'Test 7C: Rupee text must be black');

    console.log('Test 8 (Ticket ribbon b with red bg): ribbon b bg =', results.test8RibbonB.bgColor, ', text =', results.test8RibbonU.color);
    assert.strictEqual(results.test8RibbonB.bgColor, 'rgb(215, 25, 32)', 'Test 8: Ticket ribbon b background must remain RCB red');
    assert.strictEqual(results.test8RibbonU.color, 'rgb(0, 0, 0)', 'Test 8: Ticket ribbon underlined text must be black');

    console.log('\n✅ ALL 8 DOM TEST MATRIX ASSERTIONS PASSED WITH 100% ACCURACY!');

    // Capture screenshots across Viewports
    const viewports = [
      { name: 'desktop-1440', width: 1440, height: 900 },
      { name: 'laptop-1024', width: 1024, height: 768 },
      { name: 'tablet-768', width: 768, height: 1024 },
      { name: 'mobile-430', width: 430, height: 932 },
      { name: 'mobile-375', width: 375, height: 667 }
    ];

    console.log('\nCapturing multi-viewport screenshots...');
    for (const vp of viewports) {
      await client.send('Emulation.setDeviceMetricsOverride', {
        width: vp.width,
        height: vp.height,
        deviceScaleFactor: 1,
        mobile: vp.width <= 768
      });
      await delay(300);
      const filePath = path.join(SCREENSHOT_DIR, `underline-verification-${vp.name}.png`);
      await client.screenshot(filePath);
    }

    console.log('\n--- BROWSER CONSOLE AUDIT ---');
    console.log('Console errors recorded:', consoleErrors.length);
    assert.strictEqual(consoleErrors.length, 0, 'Browser console should have zero errors');

    console.log('\n✅ ALL MULTI-VIEWPORT SCREENSHOTS CAPTURED SUCCESSFULLY!');
  } finally {
    if (client) client.close();
    try { chromeProcess.kill(); } catch {}
    if (serverProc) {
      try { serverProc.kill(); } catch {}
    }
  }
}

main().catch(err => {
  console.error('\n❌ VERIFICATION TEST FAILED:', err);
  process.exit(1);
});
