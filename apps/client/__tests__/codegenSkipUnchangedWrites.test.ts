import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Codegen must not rewrite generated files whose content is unchanged: rewriting
 * (temp file + rename) on every start fires watcher events that crash sst dev.
 */

const REAL_SCRIPT = join(__dirname, '../scripts/generate-premium-glue.mjs');
const GENERATED = 'apps/client/app/premium-generated/premiumRoutes.generated.ts';

let sandbox: string;
let clientRoot: string;

function runCodegen() {
  const result = spawnSync(process.execPath, [join(clientRoot, 'scripts/generate-premium-glue.mjs')], {
    encoding: 'utf8',
    env: { ...process.env, CI: '' },
  });
  expect(result.status, result.stderr).toBe(0);
  return result;
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'b4m-skip-unchanged-test-'));
  clientRoot = join(sandbox, 'apps/client');
  mkdirSync(join(clientRoot, 'scripts'), { recursive: true });
  cpSync(REAL_SCRIPT, join(clientRoot, 'scripts/generate-premium-glue.mjs'));
  mkdirSync(join(clientRoot, 'pages/api'), { recursive: true });
  writeFileSync(join(sandbox, 'sst.config.ts'), '');
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe('codegen unchanged writes', () => {
  it('leaves an identical generated file untouched on a second run', () => {
    runCodegen();
    const path = join(sandbox, GENERATED);
    const before = statSync(path);

    const { stdout } = runCodegen();

    expect(stdout).toContain('unchanged');
    expect(statSync(path).ino).toBe(before.ino);
    expect(statSync(path).mtimeMs).toBe(before.mtimeMs);
  });

  it('rewrites a generated file whose content drifted', () => {
    const { stdout: first } = runCodegen();
    const path = join(sandbox, GENERATED);
    const original = readFileSync(path, 'utf8');
    writeFileSync(path, 'stale\n');

    runCodegen();

    expect(first).toContain('wrote');
    expect(readFileSync(path, 'utf8')).toBe(original);
  });
});
