'use strict';

const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');

const PORT = 3333;
const ROOT = path.resolve(__dirname, '..');

async function isServerRunning() {
  return new Promise(resolve => {
    const req = http.get(`http://127.0.0.1:${PORT}/api/health`, res => {
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForServer(timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isServerRunning()) return true;
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}

async function main() {
  const stateFile = path.join(ROOT, 'data', 'active-room-state.json');
  const audioFile = path.join(ROOT, 'data', 'team-audio.json');
  try {
    const fs = require('node:fs');
    if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile);
    const defaultAudio = {
      CSK: '/audio/csk-hook.mp3',
      DC: '/audio/dc-hook.mp3',
      GT: '/audio/gt-hook.mp3',
      KKR: '/audio/kkr-hook.mp3',
      LSG: '/audio/lsg-hook.mp3',
      MI: '/audio/mi-hook.mp3',
      PBKS: '/audio/pbks-hook.mp3',
      RCB: '/audio/rcb-hook.mp3',
      RR: '/audio/rr-hook.mp3',
      SRH: '/audio/srh-hook.mp3'
    };
    fs.writeFileSync(audioFile, JSON.stringify(defaultAudio, null, 2));
  } catch {}

  let serverProcess = null;
  const runningInitially = await isServerRunning();

  if (!runningInitially) {
    console.log(`[TEST RUNNER] Starting auction server on port ${PORT}...`);
    serverProcess = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      cwd: ROOT,
      stdio: 'pipe',
      env: { ...process.env, PORT: String(PORT) }
    });

    serverProcess.stderr.on('data', d => {
      const msg = d.toString();
      if (!msg.includes('ExperimentalWarning')) process.stderr.write(msg);
    });

    const ready = await waitForServer(12000);
    if (!ready) {
      if (serverProcess) serverProcess.kill();
      console.error('[TEST RUNNER] Server failed to start within 12 seconds.');
      process.exit(1);
    }
    console.log(`[TEST RUNNER] Server is ready on http://127.0.0.1:${PORT}\n`);
  } else {
    console.log(`[TEST RUNNER] Reusing existing server at http://127.0.0.1:${PORT}\n`);
  }

  const testFiles = [
    'audio-celebration-popper-suite.test.js',
    'regression-suite.test.js',
    'comprehensive-fix-verification.test.js',
    'mega-auction-retention.test.js',
    'tasks-1-2-3-verification.test.js',
    'participant-retention-flow.test.js',
    'mega-single-start-and-close-flow.test.js',
    'player-pool-celebration-mobile.test.js',
    'critical-bidding-audio-responsive.test.js',
    'underline-styling.test.js'
  ];

  let anyFailed = false;

  try {
    for (const file of testFiles) {
      console.log(`\n>>> EXECUTING SUITE: ${file} <<<\n`);
      const exitCode = await new Promise(resolve => {
        const p = spawn(process.execPath, [path.join(__dirname, file)], {
          cwd: ROOT,
          stdio: 'inherit',
          env: { ...process.env, BASE_URL: `http://127.0.0.1:${PORT}` }
        });
        p.on('close', code => resolve(code));
      });

      if (exitCode !== 0) {
        console.error(`\n❌ Suite ${file} failed with exit code ${exitCode}`);
        anyFailed = true;
        break;
      }
    }
  } finally {
    if (serverProcess) {
      console.log('\n[TEST RUNNER] Stopping background test server...');
      serverProcess.kill('SIGTERM');
      // On Windows, kill process tree if still active
      try {
        if (!serverProcess.killed) serverProcess.kill('SIGKILL');
      } catch {}
    }
  }

  if (anyFailed) {
    process.exit(1);
  } else {
    console.log('\n✨ ALL TEST SUITES COMPLETED WITH 100% SUCCESS!\n');
    process.exit(0);
  }
}

main().catch(err => {
  console.error('[TEST RUNNER FATAL]', err);
  process.exit(1);
});
