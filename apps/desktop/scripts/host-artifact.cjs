// The headless host program as Desktop ships it: `out/host` (vite.host.config.ts) packed into one
// gzipped tarball plus a manifest, in `out/host-artifact`, which electron-builder copies into the
// app's resources as `host/` (see electron-builder.yml). The manifest is read back by
// src/main/host/remote/install/hostArtifact.ts; its shape must stay in sync with that schema.
//
// electron-builder runs this file as its beforePack hook, so the host is built with the exact
// version electron-builder stamps into the app. An unpackaged Desktop runs `build` on demand.

const { Buffer } = require('node:buffer');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } = require('node:fs');
const { dirname, join, relative, resolve, sep } = require('node:path');
const { gzipSync } = require('node:zlib');

const APP_DIR = resolve(__dirname, '..');
const HOST_BUILD_DIR = join(APP_DIR, 'out', 'host');
const ARTIFACT_DIR = join(APP_DIR, 'out', 'host-artifact');
const MANIFEST_FILE = 'manifest.json';
const TARBALL_FILE = 'b4m-host.tar.gz';
const ENTRY_FILE = 'b4m-host.cjs';
const MANIFEST_SCHEMA = 1;

// The same shape the installer accepts for a version it writes into a remote path.
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/;
const MAX_VERSION_LENGTH = 64;

// Every entry gets the same owner and time, so one input always packs to the same bytes.
const FIXED_MTIME_SECONDS = 946684800;
const BLOCK = 512;

function requireVersion(version) {
  if (
    typeof version !== 'string' ||
    version.length > MAX_VERSION_LENGTH ||
    !VERSION_PATTERN.test(version) ||
    version.endsWith('.tmp')
  ) {
    throw new Error(`Not a host version: ${JSON.stringify(version)}`);
  }
  return version;
}

/** Files under `root`, as sorted forward-slash paths. Source maps stay behind: they triple the upload. */
function listFiles(root) {
  const found = [];
  const walk = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && !entry.name.endsWith('.map')) found.push(relative(root, path).split(sep).join('/'));
      else if (!entry.isFile()) throw new Error(`${path} is neither a file nor a directory`);
    }
  };
  walk(root);
  return found.sort();
}

function writeOctal(header, offset, length, value) {
  header.write(`${value.toString(8).padStart(length - 1, '0')}\0`, offset, length, 'ascii');
}

/** One ustar header block. Paths are ASCII and short, so the prefix field is never needed. */
function tarHeader(path, size, type) {
  if (!/^[A-Za-z0-9._/-]+$/.test(path) || Buffer.byteLength(path) > 100) {
    throw new Error(`Cannot pack ${JSON.stringify(path)}: tar paths must be short ASCII`);
  }
  const header = Buffer.alloc(BLOCK, 0);
  header.write(path, 0, 100, 'ascii');
  writeOctal(header, 100, 8, type === 'directory' ? 0o755 : 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, FIXED_MTIME_SECONDS);
  header.write(type === 'directory' ? '5' : '0', 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  // The checksum is computed with its own field read as spaces.
  header.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return header;
}

/** A gzipped ustar archive of `files` (relative to `root`), with a directory entry before its first file. */
function packTarball(root, files) {
  const parts = [];
  const directories = new Set();
  for (const file of files) {
    const segments = file.split('/');
    for (let depth = 1; depth < segments.length; depth++) {
      const directory = `${segments.slice(0, depth).join('/')}/`;
      if (directories.has(directory)) continue;
      directories.add(directory);
      parts.push(tarHeader(directory, 0, 'directory'));
    }
    const data = readFileSync(join(root, file));
    parts.push(tarHeader(file, data.length, 'file'), data);
    const padding = (BLOCK - (data.length % BLOCK)) % BLOCK;
    if (padding > 0) parts.push(Buffer.alloc(padding, 0));
  }
  parts.push(Buffer.alloc(BLOCK * 2, 0));
  return gzipSync(Buffer.concat(parts), { level: 9 });
}

/**
 * Packs a built host directory into `outDir` as `b4m-host.tar.gz` and `manifest.json`, replacing
 * whatever was there. Returns the manifest.
 */
function packHostArtifact({ sourceDir, version, outDir }) {
  requireVersion(version);
  const files = listFiles(sourceDir);
  if (!files.includes(ENTRY_FILE)) throw new Error(`${sourceDir} has no ${ENTRY_FILE}; build the host first`);
  const tarball = packTarball(sourceDir, files);
  const manifest = {
    schema: MANIFEST_SCHEMA,
    version,
    entry: ENTRY_FILE,
    tarball: {
      file: TARBALL_FILE,
      size: tarball.length,
      sha256: createHash('sha256').update(tarball).digest('hex'),
    },
    files: files.map(path => ({ path, size: statSync(join(sourceDir, path)).size })),
  };
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, TARBALL_FILE), tarball);
  writeFileSync(join(outDir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/** Builds `out/host` with vite.host.config.ts, the version baked in through B4M_HOST_VERSION. */
function buildHost(version) {
  const vitePackage = require.resolve('vite/package.json', { paths: [APP_DIR] });
  const viteBin = join(dirname(vitePackage), require(vitePackage).bin.vite);
  const result = spawnSync(process.execPath, [viteBin, 'build', '--config', 'vite.host.config.ts', '--logLevel', 'warn'], {
    cwd: APP_DIR,
    env: { ...process.env, B4M_HOST_VERSION: requireVersion(version) },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Building the host program failed (vite exited ${result.status})`);
}

/** Builds the host at `version` and packs it into `out/host-artifact`. */
function buildHostArtifact(version, { build = buildHost, pack = packHostArtifact } = {}) {
  build(version);
  return pack({ sourceDir: HOST_BUILD_DIR, version, outDir: ARTIFACT_DIR });
}

/** electron-builder's beforePack: the host always carries the version being packaged. */
async function beforePack(context, build = buildHostArtifact) {
  const { version } = context.packager.appInfo;
  const manifest = build(version);
  console.log(`  - host program ${manifest.version} packed (${manifest.tarball.size} bytes)`);
}

if (require.main === module) {
  try {
    const [command, flag, version] = process.argv.slice(2);
    if (command !== 'build' || flag !== '--version' || version === undefined) {
      throw new Error('Usage: host-artifact.cjs build --version <version>');
    }
    const manifest = buildHostArtifact(version);
    console.log(`Host program ${manifest.version} packed into ${ARTIFACT_DIR}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

module.exports = {
  default: beforePack,
  beforePack,
  buildHostArtifact,
  packHostArtifact,
  requireVersion,
  ARTIFACT_DIR,
  MANIFEST_FILE,
  TARBALL_FILE,
};
