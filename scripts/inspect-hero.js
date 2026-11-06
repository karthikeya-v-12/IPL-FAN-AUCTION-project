'use strict';

const { spawn } = require('child_process');
const http = require('http');

async function waitForChrome(port, maxRetries = 20) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await new Promise((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${port}/json/version`, resolve);
        req.on('error', reject);
      });
      if (res.statusCode === 200) return true;
    } catch (e) {
      await new Promise(r => setTimeout(r, 200));
    }
  }
  throw new Error('Chrome remote debugging did not respond');
}

async function checkLayout() {
  const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const proc = spawn(CHROME_PATH, ['--headless=new', '--remote-debugging-port=9444', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
  await waitForChrome(9444);

  http.get('http://127.0.0.1:9444/json/list', res => {
    let d = ''; res.on('data', c => d += c); res.on('end', async () => {
      const tab = JSON.parse(d)[0];
      const ws = new WebSocket(tab.webSocketDebuggerUrl);
      ws.onopen = async () => {
        let id = 0;
        const send = (method, params = {}) => new Promise((resolve) => {
          const reqId = ++id;
          const handler = (m) => {
            const data = JSON.parse(m.data);
            if (data.id === reqId) { ws.removeEventListener('message', handler); resolve(data.result); }
          };
          ws.addEventListener('message', handler);
          ws.send(JSON.stringify({ id: reqId, method, params }));
        });

        await send('Page.enable');
        await send('Runtime.enable');
        await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
        await send('Page.navigate', { url: 'http://127.0.0.1:3333/' });
        await new Promise(r => setTimeout(r, 1000));

        // Unlock host
        await send('Runtime.evaluate', { expression: "document.querySelector('[data-panel=\"host\"]').click();" });
        await new Promise(r => setTimeout(r, 400));
        await send('Runtime.evaluate', { expression: "document.getElementById('owner-code').value = 'ipl2027owner'; document.getElementById('owner-login-form').querySelector('button[type=\"submit\"]').click();" });
        await new Promise(r => setTimeout(r, 1000));

        // Inspect layout
        const layoutInfo = await send('Runtime.evaluate', { expression: `(() => {
          const heroGrid = document.querySelector('.hero-grid');
          const leftCol = heroGrid ? heroGrid.children[0] : null;
          const rightCol = heroGrid ? heroGrid.children[1] : null;
          const rect = el => {
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height), width: Math.round(r.width) };
          };
          return {
            heroGridRect: rect(heroGrid),
            leftColRect: rect(leftCol),
            rightColRect: rect(rightCol),
            leftChildren: leftCol ? Array.from(leftCol.children).map(c => ({ tag: c.tagName, cls: c.className, rect: rect(c) })) : []
          };
        })()`, returnByValue: true });

        console.log('LAYOUT INFO:', JSON.stringify(layoutInfo.result.value, null, 2));

        // Now test mobile layout (390x844)
        await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
        await new Promise(r => setTimeout(r, 500));
        const mobileLayout = await send('Runtime.evaluate', { expression: `(() => {
          const heroGrid = document.querySelector('.hero-grid');
          const leftCol = heroGrid ? heroGrid.children[0] : null;
          const rightCol = heroGrid ? heroGrid.children[1] : null;
          const rect = el => {
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height), width: Math.round(r.width) };
          };
          return {
            heroGridRect: rect(heroGrid),
            leftColRect: rect(leftCol),
            rightColRect: rect(rightCol)
          };
        })()`, returnByValue: true });

        console.log('MOBILE LAYOUT INFO:', JSON.stringify(mobileLayout.result.value, null, 2));

        ws.close();
        proc.kill();
      };
    });
  });
}
checkLayout().catch(e => console.error(e));
