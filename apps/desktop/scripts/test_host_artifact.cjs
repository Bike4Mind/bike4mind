const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Buffer } = require('node:buffer');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { beforePack, packHostArtifact, requireVersion } = require('./host-artifact.cjs');

function fakeBuild() {
  const root = mkdtempSync(join(tmpdir(), 'b4m-host-artifact-'));
  const source = join(root, 'host');
  mkdirSync(join(source, 'wasm'), { recursive: true });
  writeFileSync(join(source, 'b4m-host.cjs'), 'console.log("host");\n');
  writeFileSync(join(source, 'b4m-host.cjs.map'), '{}');
  writeFileSync(join(source, 'chunk-a1.cjs'), 'module.exports = 1;\n');
  writeFileSync(join(source, 'wasm', 'parser.wasm'), Buffer.from([0, 97, 115, 109]));
  return { root, source, out: join(root, 'artifact') };
}

test('packs the build, without source maps, under the version it is given', () => {
  const { root, source, out } = fakeBuild();
  try {
    const manifest = packHostArtifact({ sourceDir: source, version: '1.4.2-local.abc123', outDir: out });
    assert.equal(manifest.version, '1.4.2-local.abc123');
    assert.deepEqual(
      manifest.files.map(file => file.path),
      ['b4m-host.cjs', 'chunk-a1.cjs', 'wasm/parser.wasm']
    );
    const tarball = readFileSync(join(out, manifest.tarball.file));
    assert.equal(manifest.tarball.size, tarball.length);
    assert.equal(manifest.tarball.sha256, createHash('sha256').update(tarball).digest('hex'));
    assert.deepEqual(JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')), manifest);

    const extracted = join(root, 'extracted');
    mkdirSync(extracted);
    execFileSync('tar', ['-xzf', join(out, manifest.tarball.file), '-C', extracted]);
    assert.equal(readFileSync(join(extracted, 'b4m-host.cjs'), 'utf8'), 'console.log("host");\n');
    assert.deepEqual([...readFileSync(join(extracted, 'wasm', 'parser.wasm'))], [0, 97, 115, 109]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('one input always packs to the same bytes', () => {
  const { root, source, out } = fakeBuild();
  try {
    const first = packHostArtifact({ sourceDir: source, version: '1.0.0', outDir: out });
    const second = packHostArtifact({ sourceDir: source, version: '1.0.0', outDir: out });
    assert.equal(first.tarball.sha256, second.tarball.sha256);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('refuses a build without the entry and a version that is not one', () => {
  const { root, source, out } = fakeBuild();
  try {
    rmSync(join(source, 'b4m-host.cjs'));
    assert.throws(() => packHostArtifact({ sourceDir: source, version: '1.0.0', outDir: out }), /no b4m-host\.cjs/);
    for (const version of ['', '1.0', "1.0.0'; rm -rf /", '1.0.0-', `1.0.0-${'a'.repeat(64)}`]) {
      assert.throws(() => requireVersion(version), /Not a host version/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('beforePack builds the host with the version being packaged', async () => {
  const built = [];
  await beforePack({ packager: { appInfo: { version: '0.3.1' } } }, version => {
    built.push(version);
    return { version, tarball: { size: 1 } };
  });
  assert.deepEqual(built, ['0.3.1']);
});
