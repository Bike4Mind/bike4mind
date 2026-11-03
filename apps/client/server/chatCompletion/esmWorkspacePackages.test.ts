import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The chatCompletion process shape: CommonJS code requires a dual CJS/ESM package and also an
// ESM-only package (like @bike4mind/database) that imports it. Plain node, not tsx, because tsx
// transpiles a required .mjs to CJS in some load paths and would hide the split being tested.
const here = dirname(fileURLToPath(import.meta.url));
const HOOK = join(here, 'esmWorkspacePackages.mjs');
const SELFHOST_ALIAS = join(here, 'selfhostSstAlias.mjs');

let fixtureDir: string;

function writeDualPackage(name: string) {
  const pkgDir = join(fixtureDir, 'node_modules', ...name.split('/'));
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify({ name, type: 'module', exports: { '.': { import: './index.mjs', require: './index.cjs' } } })
  );
  writeFileSync(join(pkgDir, 'index.mjs'), 'export const instance = {};\n');
  writeFileSync(join(pkgDir, 'index.cjs'), 'exports.instance = {};\n');
}

beforeAll(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), 'esm-workspace-packages-'));
  writeDualPackage('@bike4mind/dual-fixture');
  writeDualPackage('third-party-dual');
  const esmOnlyDir = join(fixtureDir, 'node_modules', '@bike4mind', 'esm-only-fixture');
  mkdirSync(esmOnlyDir, { recursive: true });
  writeFileSync(
    join(esmOnlyDir, 'package.json'),
    JSON.stringify({
      name: '@bike4mind/esm-only-fixture',
      type: 'module',
      exports: { '.': { default: './index.mjs' } },
    })
  );
  writeFileSync(
    join(esmOnlyDir, 'index.mjs'),
    "export { instance as workspace } from '@bike4mind/dual-fixture';\n" +
      "export { instance as thirdParty } from 'third-party-dual';\n"
  );
  writeFileSync(
    join(fixtureDir, 'main.cjs'),
    "const { instance: workspace } = require('@bike4mind/dual-fixture');\n" +
      "const { instance: thirdParty } = require('third-party-dual');\n" +
      "const esm = require('@bike4mind/esm-only-fixture');\n" +
      'console.log(JSON.stringify({ workspace: workspace === esm.workspace, thirdParty: thirdParty === esm.thirdParty }));\n'
  );
});

afterAll(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

function runMain(preloads: string[]): { workspace: boolean; thirdParty: boolean } {
  const args = [...preloads.flatMap(p => ['--import', p]), join(fixtureDir, 'main.cjs')];
  const out = execFileSync(process.execPath, args, { cwd: fixtureDir, encoding: 'utf8' });
  return JSON.parse(out.trim().split('\n').pop()!);
}

describe('esmWorkspacePackages', () => {
  it('reproduces the split without the hook (fixture sanity)', () => {
    expect(runMain([])).toEqual({ workspace: false, thirdParty: false });
  });

  it('gives CommonJS require and ESM import one instance of a workspace package', () => {
    expect(runMain([HOOK])).toEqual({ workspace: true, thirdParty: false });
  });

  it('is installed by the sst alias shim every self-host tsx process preloads', () => {
    expect(runMain([SELFHOST_ALIAS]).workspace).toBe(true);
  });
});
