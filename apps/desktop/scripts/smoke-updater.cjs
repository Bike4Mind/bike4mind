// Checks real updater transport and hashing without launching or installing an app.
const assert = require('node:assert/strict');
const { Buffer } = require('node:buffer');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { URL } = require('node:url');

const dependencies = process.env.UPDATER_TEST_DEPENDENCIES;
const load = dependencies ? createRequire(path.resolve(dependencies, 'package.json')) : require;
const { AppImageUpdater } = load('electron-updater/out/AppImageUpdater');
const builder = dependencies ? load : createRequire(load.resolve('electron-builder/package.json'));
const builderLib = createRequire(builder.resolve('app-builder-lib/package.json'));
const { NodeHttpExecutor } = builderLib('builder-util/out/nodeHttpExecutor');
const { ElectronHttpExecutor } = load('electron-updater/out/electronHttpExecutor');
const updaterLib = createRequire(load.resolve('electron-updater/package.json'));
const yaml = updaterLib('js-yaml');

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'b4m-updater-'));
  const payload = Buffer.from('temporary update transport fixture, not an executable');
  const requests = [];
  let corrupt = false;
  let base;
  const manifest = {
    version: '0.2.3',
    files: [{ url: '', sha512: createHash('sha512').update(payload).digest('base64'), size: payload.length }],
  };
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, base);
    requests.push(url.pathname);
    if (url.pathname === '/latest/latest-linux.yml') {
      response.writeHead(302, { Location: '/release/desktop-v0.2.3/latest-linux.yml' });
      response.end();
    } else if (url.pathname.endsWith('.yml')) {
      response.end(yaml.dump(manifest));
    } else if (url.pathname.endsWith('.AppImage')) {
      response.end(corrupt ? Buffer.from('corrupt payload') : payload);
    } else {
      response.writeHead(404).end();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  manifest.files[0].url = `${base}/release/desktop-v0.2.3/Bike4Mind-0.2.3-x64.AppImage`;
  const oldAppImage = process.env.APPIMAGE;
  process.env.APPIMAGE = path.join(root, 'Bike4Mind-0.2.2-x64.AppImage');
  await fs.writeFile(process.env.APPIMAGE, 'old fixture');
  const makeUpdater = async (version, profile) => {
    const userData = path.join(root, profile);
    await fs.mkdir(userData, { recursive: true });
    const app = {
      version, name: 'updater-verification', isPackaged: true,
      userDataPath: userData, baseCachePath: userData,
      appUpdateConfigPath: path.join(userData, 'app-update.yml'),
      whenReady: async () => {}, onQuit: () => { throw new Error('Unexpected quit registration'); },
    };
    await fs.writeFile(app.appUpdateConfigPath, 'updaterCacheDirName: test-cache\n');
    const updater = new AppImageUpdater(null, app);
    updater.httpExecutor = new NodeHttpExecutor();
    updater.httpExecutor.download = ElectronHttpExecutor.prototype.download;
    updater._testOnlyOptions = { platform: 'linux' };
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.disableDifferentialDownload = true;
    updater.logger = null;
    updater.setFeedURL({ provider: 'generic', url: `${base}/latest/` });
    return updater;
  };
  try {
    const old = await makeUpdater('0.2.2', 'old');
    const available = await old.checkForUpdates();
    assert.equal(available.updateInfo.version, '0.2.3');
    assert.equal(available.downloadPromise, null);
    assert.equal(requests.some(url => url.endsWith('.AppImage')), false);
    const downloaded = await old.downloadUpdate();
    assert.deepEqual(await fs.readFile(downloaded[0]), payload);
    const current = await makeUpdater('0.2.3', 'current');
    let offered = false;
    current.on('update-available', () => { offered = true; });
    await current.checkForUpdates();
    assert.equal(offered, false);
    corrupt = true;
    const denied = await makeUpdater('0.2.2', 'corrupt');
    await denied.checkForUpdates();
    await assert.rejects(denied.downloadUpdate(), /checksum mismatch/i);
    console.log('PASS: latest redirect, 0.2.2 -> 0.2.3 offer, explicit download, SHA-512 rejection, current-version no-op. No installation attempted.');
  } finally {
    await new Promise(resolve => server.close(resolve));
    if (oldAppImage === undefined) delete process.env.APPIMAGE;
    else process.env.APPIMAGE = oldAppImage;
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
