// Packages a test-identity build at two versions, signs both with one throwaway self-signed
// certificate, and updates the older to the newer through the app's own update path (electron-updater, then
// Squirrel.Mac) from a loopback feed. A newer build signed by a second throwaway certificate must
// be refused. Needs no secrets. Run from the repository root: node apps/desktop/scripts/smoke-mac-update.mjs
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, X509Certificate } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { createServer as createNetServer } from 'node:net';
import { tmpdir, userInfo } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { checkMacSignature, designatedRequirement } from './check-mac-signature.mjs';

assert.equal(process.platform, 'darwin', 'The Squirrel.Mac update check runs on macOS only');

// Every name Electron and macOS derive per-app state from (userData, the safeStorage keychain item,
// the ShipIt cache and launchd job) differs from the shipped app's.
const TEST_ID = 'com.bike4mind.desktop.updatetest';
const TEST_PRODUCT = 'B4MUpdateTest';
const TEST_NAME = 'b4m-update-test';
const OLD = '0.0.1';
const NEW = '0.0.2';
const SHIPIT_JOB = `${TEST_ID}.ShipIt`;

const desktop = resolve('apps/desktop');
const arch = process.arch;
const builder = createRequire(createRequire(join(desktop, 'package.json')).resolve('electron-builder/package.json'));
const asar = createRequire(builder.resolve('app-builder-lib/package.json'))('@electron/asar');
const realHome = userInfo().homedir;
const leftovers = [
  `Library/Caches/${SHIPIT_JOB}`,
  `Library/Caches/${TEST_ID}`,
  `Library/Caches/${TEST_NAME}-updater`,
  `Library/Application Support/${TEST_NAME}`,
  `Library/Logs/${TEST_NAME}`,
  `Library/Preferences/${TEST_ID}.plist`,
  `Library/Saved Application State/${TEST_ID}.savedState`,
  `Library/HTTPStorages/${TEST_ID}`,
].map(path => join(realHome, path));

const root = await realpath(await mkdtemp(join(tmpdir(), 'b4m-mac-update-')));
const keychain = join(root, 'signing.keychain-db');
const launched = new Set();
let server;
let searchListBefore = null;
let searchListChanged = false;

const run = (command, args, options = {}) =>
  execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });
const describe = target => spawnSync('codesign', ['-d', '--verbose=3', String(target)], { encoding: 'utf8' }).stderr;
const cdhash = target => /^CDHash=(\w+)$/m.exec(describe(target))?.[1];
const plist = (app, key) => run('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, join(app, 'Contents/Info.plist')]).trim();
const packageJson = app => JSON.parse(asar.extractFile(join(app, 'Contents/Resources/app.asar'), 'package.json'));
const searchList = () => run('security', ['list-keychains', '-d', 'user']);
const keychainPaths = listing => [...listing.matchAll(/"([^"\n]+)"/g)].map(match => match[1]);
const shipItJobLoaded = () => run('launchctl', ['list']).split('\n').some(line => line.endsWith(`\t${SHIPIT_JOB}`));

async function until(probe, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await delay(250);
  }
  throw new Error(message());
}

async function removeLeftovers() {
  const removed = [];
  if (shipItJobLoaded()) {
    spawnSync('launchctl', ['remove', SHIPIT_JOB]);
    removed.push(`launchd job ${SHIPIT_JOB}`);
  }
  for (const path of leftovers) {
    if (await stat(path).then(() => true, () => false)) removed.push(path);
    await rm(path, { recursive: true, force: true });
  }
  return removed;
}

async function makeCertificate(label) {
  const dir = join(root, `cert-${label}`);
  await mkdir(dir);
  const config = join(dir, 'openssl.cnf');
  await writeFile(config, ['[req]', 'distinguished_name = dn', 'x509_extensions = ext', 'prompt = no', '[dn]',
    `CN = Bike4Mind update test ${label}`, '[ext]', 'basicConstraints = critical,CA:FALSE',
    'keyUsage = critical,digitalSignature', 'extendedKeyUsage = critical,codeSigning', ''].join('\n'));
  const key = join(dir, 'key.pem');
  const pem = join(dir, 'cert.pem');
  const p12 = join(dir, 'cert.p12');
  run('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', '2', '-nodes', '-config', config,
    '-keyout', key, '-out', pem]);
  // 3DES and a SHA-1 MAC: the PKCS#12 profile `security import` reads on every supported macOS.
  run('/usr/bin/openssl', ['pkcs12', '-export', '-inkey', key, '-in', pem, '-out', p12, '-passout', 'pass:throwaway',
    '-keypbe', 'PBE-SHA1-3DES', '-certpbe', 'PBE-SHA1-3DES', '-macalg', 'sha1']);
  run('security', ['import', p12, '-k', keychain, '-f', 'pkcs12', '-P', 'throwaway', '-T', '/usr/bin/codesign']);
  await rm(key);
  const sha1 = new X509Certificate(await readFile(pem)).fingerprint.replaceAll(':', '').toLowerCase();
  return { label, sha1 };
}

// Some macOS versions let codesign use an identity from --keychain alone; others resolve it only
// through the user search list. The list is changed only where the probe says it has to be, and
// the finally block puts it back.
async function exposeSigningKeychain(sha1) {
  const probe = join(root, 'probe');
  await copyFile('/usr/bin/true', probe);
  const sign = () => spawnSync('codesign', ['--sign', sha1, '--force', '--keychain', keychain, probe], { encoding: 'utf8' });
  if (sign().status === 0) {
    assert.equal(searchList(), searchListBefore, 'The signing keychain must stay off the keychain search list');
    console.log('codesign resolves the identity from the keychain file; the search list is untouched.');
    return;
  }
  run('security', ['list-keychains', '-d', 'user', '-s', keychain, ...keychainPaths(searchListBefore)]);
  searchListChanged = true;
  const retry = sign();
  if (retry.status !== 0) {
    const identities = spawnSync('security', ['find-identity', '-p', 'codesigning', keychain], { encoding: 'utf8' });
    throw new Error(`codesign cannot use the throwaway identity:\n${retry.stderr}\n${identities.stdout}${identities.stderr}\n` +
      `${searchList()}\n${run('sw_vers', [])}`);
  }
  console.log('codesign needs the signing keychain on the user search list here; it is restored when the check ends.');
}

async function freePort() {
  const probe = createNetServer();
  await new Promise(resolveListen => probe.listen(0, '127.0.0.1', resolveListen));
  const { port } = probe.address();
  await new Promise(resolveClose => probe.close(resolveClose));
  return port;
}

function packageBuild(label, version, certificate, targets, feedUrl) {
  const output = join(root, `build-${label}`);
  const env = { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false', CSC_FOR_PULL_REQUEST: 'true',
    B4M_MAC_SIGN_KEYCHAIN: keychain, B4M_MAC_SIGN_IDENTITY: certificate.sha1 };
  for (const key of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'CSC_NAME', 'CSC_KEYCHAIN', 'APPLE_ID', 'APPLE_TEAM_ID']) delete env[key];
  const started = Date.now();
  const result = spawnSync('pnpm', ['exec', 'electron-builder', '--mac', ...targets, `--${arch}`, '--publish', 'never',
    `-c.directories.output=${output}`, `-c.appId=${TEST_ID}`, `-c.productName=${TEST_PRODUCT}`,
    `-c.extraMetadata.name=${TEST_NAME}`, `-c.extraMetadata.version=${version}`,
    '-c.mac.identity=-', '-c.mac.sign=./scripts/sign-mac-selfsigned.cjs', '-c.forceCodeSigning=true',
    // Release builds timestamp every file; this check does not need it and would spend minutes on it.
    '-c.mac.timestamp=none', '-c.publish.provider=generic', `-c.publish.url=${feedUrl}`],
  { cwd: desktop, env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`electron-builder ${label} failed:\n${`${result.stdout}${result.stderr}`.slice(-4000)}`);
  }
  const app = join(output, arch === 'arm64' ? 'mac-arm64' : 'mac', `${TEST_PRODUCT}.app`);
  return { label, version, certificate, app, zip: join(output, `${TEST_PRODUCT}-${version}-${arch}.zip`),
    seconds: Math.round((Date.now() - started) / 1000) };
}

async function install(build, name) {
  const app = join(root, name, `${TEST_PRODUCT}.app`);
  await mkdir(join(root, name));
  run('ditto', [build.app, app]);
  return app;
}

async function launch(app, label) {
  const port = await freePort();
  const home = await mkdtemp(join(root, `home-${label}-`));
  // HOME, the profile and the mock keychain keep the app off the real login keychain and userData.
  const env = { ...process.env, HOME: home, B4M_DESKTOP_VERBOSE: '1' };
  delete env.ELECTRON_RENDERER_URL;
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(join(app, 'Contents/MacOS', TEST_PRODUCT), ['--use-mock-keychain',
    '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`, `--user-data-dir=${join(home, 'profile')}`],
  { detached: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
  launched.add(child);
  let logs = '';
  child.stdout.on('data', chunk => { logs += chunk; });
  child.stderr.on('data', chunk => { logs += chunk; });
  const exited = new Promise(resolveExit => child.once('exit', () => resolveExit(Date.now())));
  const target = await until(async () => {
    if (child.exitCode !== null) throw new Error(`${label} exited during startup:\n${logs.slice(-4000)}`);
    try {
      const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json());
      return pages.find(page => page.type === 'page' && page.url.startsWith('file://'));
    } catch {
      return null; // The debugger starts after Electron initializes.
    }
  }, 90_000, () => `${label} renderer did not start:\n${logs.slice(-4000)}`);
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolveOpen, reject) => {
    socket.addEventListener('open', resolveOpen, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let id = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
    else waiter.resolve(message.result);
  });
  socket.addEventListener('close', () => {
    for (const waiter of pending.values()) waiter.reject(new Error(`${label} debugger connection closed`));
    pending.clear();
  });
  const evaluate = expression => new Promise((resolveResult, reject) => {
    const requestId = ++id;
    pending.set(requestId, { resolve: resolveResult, reject });
    socket.send(JSON.stringify({ id: requestId, method: 'Runtime.evaluate',
      params: { expression, awaitPromise: true, returnByValue: true } }));
  }).then(result => {
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  });
  await until(() => evaluate('Boolean(window.b4m)').catch(() => false), 60_000, () => `${label} preload did not load`);
  const stop = async () => {
    socket.close();
    for (const signal of ['SIGTERM', 'SIGKILL']) {
      try { process.kill(-child.pid, signal); } catch { /* Already exited. */ }
      if (signal === 'SIGTERM') await Promise.race([exited, delay(3000)]);
    }
    await exited;
    launched.delete(child);
  };
  return { child, home, exited, evaluate, stop, logs: () => logs };
}

const updateState = app => app.evaluate('window.b4m.update.getState()');

async function stageUpdate(app, label) {
  const initial = await updateState(app);
  assert.notEqual(initial.status, 'unsupported', `${label}: a feed-enabled build must enable in-app updates`);
  await app.evaluate('window.b4m.update.check()');
  const offered = await until(async () => {
    const state = await updateState(app);
    return state.status === 'available' || state.status === 'ready' ? state : null;
  }, 60_000, () => `${label}: no update offered:\n${app.logs().slice(-4000)}`);
  assert.equal(offered.version, NEW);
  // Resolves once the download has finished or failed; a failure puts the offer back to 'available'.
  await app.evaluate('window.b4m.update.download()');
  await until(async () => {
    const { status } = await updateState(app);
    if (status === 'available') throw new Error(`${label}: download failed:\n${app.logs().slice(-4000)}`);
    return status === 'ready';
  }, 180_000, () => `${label}: download did not finish:\n${app.logs().slice(-4000)}`);
  // Install with force: the busy prompt is the user's call and not what this checks.
  // The app may quit before the reply arrives; the caller checks what happened next.
  const result = await app.evaluate('window.b4m.update.install(true)').catch(error => {
    if (/connection closed/.test(error.message)) return { ok: true };
    throw error;
  });
  assert.equal(result.ok, true, `${label}: install was refused: ${JSON.stringify(result)}`);
}

// Any main process of the test product counts, wherever it was started from: the name is unique to
// this check, and a relaunch that slipped past a narrower match would run unisolated.
const MAIN_PROCESS = new RegExp(`/${TEST_PRODUCT}\\.app/Contents/MacOS/${TEST_PRODUCT}(?: |$)`);

function findMainProcess(excludePid) {
  const listing = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).stdout;
  for (const line of listing.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match && Number(match[1]) !== excludePid && MAIN_PROCESS.test(match[2])) {
      return { pid: Number(match[1]), command: match[2] };
    }
  }
  return null;
}

function killTree(pid) {
  const children = spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
  for (const child of children) killTree(Number(child));
  try { process.kill(pid, 'SIGKILL'); } catch { /* Already exited. */ }
}

async function main() {
  await removeLeftovers();
  searchListBefore = searchList();
  const password = randomBytes(24).toString('hex');
  run('security', ['create-keychain', '-p', password, keychain]);
  run('security', ['set-keychain-settings', keychain]);
  run('security', ['unlock-keychain', '-p', password, keychain]);
  const certificate = await makeCertificate('a');
  const otherCertificate = await makeCertificate('b');
  run('security', ['set-key-partition-list', '-S', 'apple-tool:,apple:', '-s', '-k', password, keychain]);
  await exposeSigningKeychain(certificate.sha1);

  const feed = new Map();
  server = createServer((request, response) => {
    const entry = feed.get(new URL(request.url, 'http://127.0.0.1').pathname);
    if (!entry) {
      response.writeHead(404).end();
    } else if (entry.text !== undefined) {
      response.writeHead(200, { 'Content-Type': 'text/yaml' }).end(entry.text);
    } else {
      response.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': entry.size });
      createReadStream(entry.file).pipe(response);
    }
  });
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const feedUrl = `http://127.0.0.1:${server.address().port}/`;
  const publish = async build => {
    const payload = await readFile(build.zip);
    const sha512 = createHash('sha512').update(payload).digest('base64');
    const url = `${feedUrl}${basename(build.zip)}`;
    feed.clear();
    feed.set(`/${basename(build.zip)}`, { file: build.zip, size: payload.length });
    feed.set('/latest-mac.yml', { text: [`version: ${build.version}`, 'files:', `  - url: ${url}`, `    sha512: '${sha512}'`,
      `    size: ${payload.length}`, `path: ${url}`, `sha512: '${sha512}'`, `releaseDate: '${new Date().toISOString()}'`, ''].join('\n') });
  };

  const built = spawnSync('pnpm', ['build'], { cwd: desktop, env: { ...process.env, B4M_UPDATE_FEED_URL: feedUrl },
    encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (built.status !== 0) throw new Error(`electron-vite build failed:\n${`${built.stdout}${built.stderr}`.slice(-4000)}`);
  // A zip target, as in a release: electron-builder writes app-update.yml only when it builds one.
  const old = packageBuild('old', OLD, certificate, ['zip'], feedUrl);
  const next = packageBuild('new', NEW, certificate, ['zip'], feedUrl);
  const foreign = packageBuild('other', NEW, otherCertificate, ['zip'], feedUrl);
  for (const build of [old, next, foreign]) {
    const { requirement, machOFiles } = await checkMacSignature(build.app, TEST_ID, build.certificate.sha1);
    console.log(`${build.version} (certificate ${build.certificate.label}, packaged in ${build.seconds} s): ` +
      `${requirement} [${machOFiles} Mach-O files, CDHash ${cdhash(build.app)}]`);
    assert.equal(plist(build.app, 'CFBundleIdentifier'), TEST_ID);
    assert.equal(plist(build.app, 'CFBundleName'), TEST_PRODUCT);
    assert.equal(plist(build.app, 'CFBundleShortVersionString'), build.version);
    const metadata = packageJson(build.app);
    assert.equal(metadata.name, TEST_NAME);
    assert.equal(metadata.productName ?? TEST_NAME, TEST_NAME);
    assert.equal(metadata.version, build.version);
  }
  console.log(`Isolation: bundle id ${TEST_ID}, product ${TEST_PRODUCT}, Electron app name ${TEST_NAME}.`);

  // Update: the old build checks, downloads and installs the new one, and ShipIt relaunches it.
  await publish(next);
  const installed = await install(old, 'install');
  const before = await launch(installed, 'old');
  const info = await before.evaluate('window.b4m.getAppInfo()');
  assert.equal(info.appVersion, OLD);
  console.log(`Running ${info.appVersion} from ${installed} (home ${info.homeDirectory}).`);
  await stageUpdate(before, 'update');
  const exitedAt = await Promise.race([before.exited, delay(180_000, null, { ref: false })]);
  assert.ok(exitedAt, `The old build did not quit to install:\n${before.logs().slice(-4000)}`);
  launched.delete(before.child);
  // ShipIt relaunches through LaunchServices with the login session's HOME and no flags, so the
  // relaunched process is frozen at once and inspected rather than left to start against real state.
  let found = null;
  const deadline = Date.now() + 120_000;
  while (!found && Date.now() < deadline) {
    found = findMainProcess(before.child.pid);
    if (!found) await delay(20);
  }
  if (!found) {
    const logs = await Promise.all([realHome, before.home].map(async home => {
      const path = join(home, 'Library/Caches', SHIPIT_JOB, 'ShipIt_stderr.log');
      return readFile(path, 'utf8').then(text => `${path}:\n${text.slice(-4000)}`, () => `${path}: missing`);
    }));
    throw new Error(`No relaunch within 120 s.\n${logs.join('\n')}\nApp log:\n${before.logs().slice(-4000)}`);
  }
  const relaunched = found.pid;
  process.kill(relaunched, 'SIGSTOP');
  const frozenAfter = Date.now() - exitedAt;
  const withoutPrivate = path => path.replace(/^\/private\//, '/');
  assert.equal(withoutPrivate(found.command.split(' ')[0]), withoutPrivate(join(installed, 'Contents/MacOS', TEST_PRODUCT)),
    `Relaunched from an unexpected path: ${found.command}`);
  const helpers = spawnSync('pgrep', ['-P', String(relaunched)], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
  const runningRequirement = designatedRequirement(String(relaunched));
  const runningHash = cdhash(relaunched);
  const environment = spawnSync('ps', ['-wwE', '-p', String(relaunched), '-o', 'command='], { encoding: 'utf8' }).stdout;
  killTree(relaunched);
  console.log(`ShipIt relaunched pid ${relaunched} ${frozenAfter} ms after the old build quit; frozen with ` +
    `${helpers.length} child processes, HOME=${/\bHOME=(\S+)/.exec(environment)?.[1] ?? 'unknown'}.`);
  console.log(`Relaunched process: ${found.command}\n  ${runningRequirement}, CDHash ${runningHash}.`);
  assert.match(runningHash ?? '', /^[0-9a-f]{40}$/);
  assert.equal(runningHash, cdhash(next.app), 'The relaunched process must be the new build');
  assert.notEqual(runningHash, cdhash(old.app));
  assert.equal(runningRequirement, `designated => identifier "${TEST_ID}" and certificate leaf = H"${certificate.sha1}"`);
  await checkMacSignature(installed, TEST_ID, certificate.sha1);
  assert.equal(plist(installed, 'CFBundleShortVersionString'), NEW);
  const after = await launch(installed, 'updated');
  const updatedInfo = await after.evaluate('window.b4m.getAppInfo()');
  await after.stop();
  assert.equal(updatedInfo.appVersion, NEW);
  console.log(`PASS: ${OLD} updated itself to ${NEW} in place; the installed app reports ${updatedInfo.appVersion}.`);

  // A newer build signed by any other certificate does not satisfy the running build's requirement.
  await publish(foreign);
  const guarded = await install(old, 'install-other');
  const target = await launch(guarded, 'guarded');
  await stageUpdate(target, 'refusal');
  const refusal = await until(() => /did not pass validation|failed to satisfy|code signature/i.exec(target.logs())?.[0] ??
    (target.child.exitCode !== null ? 'exited' : null), 180_000, () => `No refusal logged:\n${target.logs().slice(-4000)}`);
  assert.notEqual(refusal, 'exited', `The guarded build quit:\n${target.logs().slice(-4000)}`);
  const refusalLine = target.logs().split('\n').find(line => line.includes(refusal)) ?? refusal;
  await delay(3000);
  assert.equal(target.child.exitCode, null, 'The guarded build must keep running after the refused update');
  assert.equal(findMainProcess(target.child.pid), null, 'Nothing may relaunch after a refused update');
  await target.stop();
  await checkMacSignature(guarded, TEST_ID, certificate.sha1);
  assert.equal(plist(guarded, 'CFBundleShortVersionString'), OLD);
  const kept = await launch(guarded, 'kept');
  const keptInfo = await kept.evaluate('window.b4m.getAppInfo()');
  await kept.stop();
  assert.equal(keptInfo.appVersion, OLD);
  console.log(`Refused: ${refusalLine.trim().slice(0, 400)}`);
  console.log(`PASS: ${NEW} signed by certificate b was not applied; ${OLD} still launches and reports ${keptInfo.appVersion}.`);
}

try {
  await main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  for (const child of launched) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ }
  }
  for (const path of new Set([root, root.replace(/^\/private\//, '/')])) {
    spawnSync('pkill', ['-KILL', '-f', path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')]);
  }
  if (server) await new Promise(resolveClose => server.close(resolveClose));
  if (searchListChanged) spawnSync('security', ['list-keychains', '-d', 'user', '-s', ...keychainPaths(searchListBefore)]);
  spawnSync('security', ['delete-keychain', keychain]);
  if (searchListBefore !== null && keychainPaths(searchList()).join('\n') !== keychainPaths(searchListBefore).join('\n')) {
    console.error('The keychain search list differs from before the check.');
  }
  await rm(root, { recursive: true, force: true });
  const removed = await removeLeftovers();
  if (removed.length) console.log(`Removed test-identity state: ${removed.join(', ')}`);
  const remaining = [root, keychain, ...leftovers];
  for (const path of remaining) {
    if (await stat(path).then(() => true, () => false)) console.error(`Left on disk: ${path}`);
  }
  if (shipItJobLoaded()) console.error(`Left loaded: launchd job ${SHIPIT_JOB}`);
}
