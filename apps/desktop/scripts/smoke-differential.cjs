// Exercise the embedded-blockmap downloader without executing or installing a payload.
const assert = require('node:assert/strict');
const { Buffer } = require('node:buffer');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');
const { URL } = require('node:url');

const dependencies = process.env.UPDATER_TEST_DEPENDENCIES;
const load = dependencies ? createRequire(path.resolve(dependencies, 'package.json')) : require;
const builder = createRequire(load.resolve('electron-builder/package.json'));
const builderLib = createRequire(builder.resolve('app-builder-lib/package.json'));
const { appendBlockmap } = builderLib('./out/targets/differentialUpdateInfoBuilder');
const { NodeHttpExecutor } = builderLib('builder-util/out/nodeHttpExecutor');
const updaterLib = createRequire(load.resolve('electron-updater/package.json'));
const { CancellationToken } = updaterLib('builder-util-runtime');
const { FileWithEmbeddedBlockMapDifferentialDownloader: Downloader } = load(
  'electron-updater/out/differentialDownloader/FileWithEmbeddedBlockMapDifferentialDownloader'
);
const yaml = updaterLib('js-yaml');

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'b4m-differential-'));
  let server;
  try {
    const oldFile = path.join(root, 'Bike4Mind-0.2.2-x64.AppImage');
    const newFile = path.join(root, 'Bike4Mind-0.2.3-x64.AppImage');
    // Stable pseudorandom content models mostly unchanged compressed installer bytes.
    const old = Buffer.concat(
      Array.from({ length: 65536 }, (_, index) => createHash('sha256').update(String(index)).digest())
    );
    const next = Buffer.from(old);
    next.fill(0x42, 1024 * 1024, 1024 * 1024 + 16384);
    await fs.writeFile(oldFile, old);
    await fs.writeFile(newFile, next);
    await appendBlockmap(oldFile);
    const builderInfo = await appendBlockmap(newFile);
    for (const suffix of ['arm64.zip', 'arm64.dmg', 'arm64.zip.blockmap']) {
      await fs.writeFile(path.join(root, `Bike4Mind-0.2.3-${suffix}`), 'fixture');
    }
    const assets = path.join(root, 'assets');
    await fs.mkdir(assets);
    for (const name of await fs.readdir(root)) {
      if (name.startsWith('Bike4Mind-0.2.3-')) await fs.copyFile(path.join(root, name), path.join(assets, name));
    }
    execFileSync('python3', [path.join(__dirname, 'distribution.py'), assets], {
      env: {
        ...process.env,
        DESKTOP_VERSION: '0.2.3',
        DESKTOP_RELEASE_REPOSITORY: 'example/dist',
        GITHUB_REPOSITORY: 'example/source',
        MAC_RELEASE_MODE: 'signed',
      },
    });
    const info = yaml.load(await fs.readFile(path.join(assets, 'latest-linux.yml'), 'utf8')).files[0];
    for (const key of ['size', 'sha512', 'blockMapSize']) assert.equal(info[key], builderInfo[key], key);
    const payload = await fs.readFile(newFile);
    let transferred = 0;
    let corrupt = false;
    const ranges = [];
    server = http.createServer((request, response) => {
      const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range || '');
      if (!range) {
        response.writeHead(400).end('Range required');
        return;
      }
      const start = Number(range[1]);
      const end = Number(range[2]);
      ranges.push([start, end]);
      const bytes = Buffer.from(payload.subarray(start, end + 1));
      if (corrupt && start < payload.length - info.blockMapSize - 4) bytes[0] ^= 1;
      transferred += bytes.length;
      response.writeHead(206, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': bytes.length,
        'Content-Range': `bytes ${start}-${end}/${payload.length}`,
        'Accept-Ranges': 'bytes',
      });
      response.end(bytes);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const logger = { info() {}, warn() {}, error() {}, debug() {} };
    const download = (metadata, destination) =>
      new Downloader(metadata, new NodeHttpExecutor(), {
        newUrl: new URL(`http://127.0.0.1:${server.address().port}/new.AppImage`),
        oldFile,
        newFile: path.join(root, destination),
        logger,
        isUseMultipleRangeRequest: false,
        cancellationToken: new CancellationToken(),
      }).download();
    await download(info, 'downloaded.AppImage');
    assert.deepEqual(await fs.readFile(path.join(root, 'downloaded.AppImage')), payload);
    assert.ok(ranges.length > 1, 'Must fetch both metadata and changed payload ranges');
    assert.deepEqual(ranges[0], [payload.length - info.blockMapSize - 4, payload.length - 1]);
    assert.ok(transferred < payload.length / 4, 'Must reuse old blocks, not download the full file');
    console.log(
      `PASS: builder metadata matches assembled feed; two-version differential fetched ${transferred}/${payload.length} bytes, exact SHA-512 verified.`
    );
    corrupt = true;
    await assert.rejects(download(info, 'corrupt.AppImage'), /checksum mismatch/i);
    const { blockMapSize, ...missing } = info;
    assert.ok(blockMapSize > 0);
    await assert.rejects(download(missing, 'missing.AppImage'));
    console.log('PASS: corrupt range and missing blockMapSize rejected. No installation attempted.');
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
