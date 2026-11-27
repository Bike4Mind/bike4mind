import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('./tsgo.mjs', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'tsgo-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const typecheck = (name, source) => {
  const file = join(dir, name);
  writeFileSync(file, source);
  return spawnSync(process.execPath, [bin, '--ignoreConfig', '--noEmit', file], { encoding: 'utf8' });
};

test('a clean file exits 0', () => {
  assert.equal(typecheck('clean.ts', 'export const x: number = 1;\n').status, 0);
});

test('a type error exits nonzero', () => {
  const result = typecheck('broken.ts', "export const x: number = 'a';\n");
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /TS2322/);
});
