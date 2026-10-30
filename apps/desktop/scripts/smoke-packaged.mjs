import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const release = resolve('apps/desktop/release');
const output = resolve('apps/desktop/smoke-results');
await mkdir(output, { recursive: true });
let executable = process.argv[2];
const platformArgs = [];
if (process.platform === 'linux') {
  const images = (await readdir(release)).filter(name => name.endsWith('.AppImage'));
  assert.equal(images.length, 1, 'Expected exactly one packaged AppImage');
  executable = join(release, images[0]);
  // Xvfb has no hardware GPU; use software rendering for the startup screenshot.
  platformArgs.push('--appimage-extract-and-run', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu');
}
if (process.platform === 'darwin') {
  // A temporary HOME has no login keychain; startup tests must not prompt or touch the real one.
  platformArgs.push('--use-mock-keychain');
}
if (process.platform === 'win32') {
  // Hosted Windows runners have no GPU.
  platformArgs.push('--disable-gpu');
}
assert.ok(executable, 'Pass the installed app executable');
const server = createServer();
await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
const port = server.address().port;
await new Promise(resolveClose => server.close(resolveClose));
const home = await mkdtemp(join(tmpdir(), 'desktop-smoke-'));
let logs = '';
let socket;
const child = spawn(executable, [
  ...platformArgs,
  '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`,
  `--user-data-dir=${join(home, 'profile')}`,
], {
  detached: true,
  env: {
    ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, 'config'),
    XDG_CACHE_HOME: join(home, 'cache'), XDG_DATA_HOME: join(home, 'data'),
    ...(process.platform === 'win32' && {
      APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local'), USERPROFILE: home,
    }),
    ELECTRON_RENDERER_URL: '', ELECTRON_RUN_AS_NODE: '',
  },
});
child.stdout.on('data', chunk => { logs += chunk; });
child.stderr.on('data', chunk => { logs += chunk; });
let launchError;
child.on('error', error => { launchError = error; });

try {
  const deadline = Date.now() + 90_000;
  let target;
  while (Date.now() < deadline) {
    if (launchError) throw launchError;
    assert.equal(child.exitCode, null, `Packaged app exited: ${logs}`);
    try {
      const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json());
      target = pages.find(page => page.type === 'page' && page.url.startsWith('file://'));
      if (target) break;
    } catch { /* The debugger starts after Electron initializes. */ }
    await delay(500);
  }
  assert.ok(target, `Packaged renderer did not start: ${logs}`);
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolveOpen, reject) => {
    socket.addEventListener('open', resolveOpen, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let id = 0;
  const pending = new Map();
  const exceptions = [];
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params);
    if (pending.has(message.id)) {
      const { resolveResult, reject, timer } = pending.get(message.id);
      clearTimeout(timer);
      pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolveResult(message.result);
    }
  });
  const call = (method, params = {}) => new Promise((resolveResult, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(`Debugger timed out: ${method}`));
    }, 10_000);
    pending.set(requestId, { resolveResult, reject, timer });
    socket.send(JSON.stringify({ id: requestId, method, params }));
  });
  await call('Runtime.enable');
  let state;
  while (Date.now() < deadline) {
    const result = await call('Runtime.evaluate', {
      expression: `(async () => {
        // The picker is open only when no server resolves; otherwise the card shows a summary line.
        const card = '[data-testid="environment-active-text"], [data-testid="signin-server-text"]';
        if (!window.b4m || !document.querySelector(card)) return null;
        return { info: await window.b4m.getAppInfo(), auth: (await window.b4m.auth.getState()).status,
          update: (await window.b4m.update.getState()).status,
          heading: document.body.innerText.includes('Bike4Mind Desktop') };
      })()`,
      awaitPromise: true, returnByValue: true,
    });
    assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
    state = result.result.value;
    if (state && ['signed-out', 'unconfigured'].includes(state.auth)) break;
    await delay(500);
  }
  const screenshot = await call('Page.captureScreenshot');
  await writeFile(join(output, `${process.platform}-startup.png`), Buffer.from(screenshot.data, 'base64'));
  assert.ok(state?.heading, 'Packaged sign-in screen did not render');
  assert.ok(['signed-out', 'unconfigured'].includes(state.auth), 'Auth initialization did not finish');
  assert.equal(state.info.appVersion, process.env.DESKTOP_VERSION);
  if (process.env.EXPECT_UPDATES_DISABLED === 'true') {
    assert.equal(state.update, 'unsupported', 'Manual-install builds must not enable in-app updates');
  }
  if (process.env.EXPECT_UPDATES_ENABLED === 'true') {
    assert.notEqual(state.update, 'unsupported', 'Feed-enabled builds must enable in-app updates');
  }
  assert.equal(exceptions.length, 0, JSON.stringify(exceptions));
  assert.equal(child.exitCode, null, 'App exited during startup verification');
  await writeFile(join(output, 'result.json'), JSON.stringify(state, null, 2));
  console.log('Packaged app rendered its auth screen and passed main/preload IPC checks.');
} finally {
  socket?.close();
  if (child.pid && process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
  } else if (child.pid) {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Already exited. */ }
    await delay(1000);
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ }
  }
  await writeFile(join(output, 'app.log'), logs);
  // Windows can hold handles in the profile briefly after taskkill returns.
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
