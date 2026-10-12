import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Two packages/premium dirs can declare the same package name (e.g. a sibling git
 * worktree). Codegen must keep exactly one, and it must be the directory pnpm links,
 * because the infra and relative-import glue are keyed off the directory name.
 */

const REAL_SCRIPT = join(__dirname, '../scripts/generate-premium-glue.mjs');
const PKG_NAME = '@bike4mind/premium-collide';

let sandbox: string;
let clientRoot: string;

function writeOverlay(dir: string) {
  const overlayDir = join(sandbox, 'packages/premium', dir);
  mkdirSync(join(overlayDir, 'src'), { recursive: true });
  writeFileSync(
    join(overlayDir, 'package.json'),
    JSON.stringify({
      name: PKG_NAME,
      b4mContributions: { spaRoutesExport: `${PKG_NAME}/routes`, infra: true },
    })
  );
  writeFileSync(join(overlayDir, 'src/infra.ts'), 'export function contributeInfra() {}\n');
}

function linkTo(dir: string) {
  mkdirSync(join(clientRoot, 'node_modules/@bike4mind'), { recursive: true });
  symlinkSync(join(sandbox, 'packages/premium', dir), join(clientRoot, 'node_modules', PKG_NAME), 'dir');
}

function runCodegen() {
  const result = spawnSync(process.execPath, [join(clientRoot, 'scripts/generate-premium-glue.mjs')], {
    encoding: 'utf8',
    env: { ...process.env, CI: '' },
  });
  expect(result.status, result.stderr).toBe(0);
  return result;
}

function readGenerated(path: string) {
  return readFileSync(join(sandbox, path), 'utf8');
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'b4m-collision-test-'));
  clientRoot = join(sandbox, 'apps/client');
  mkdirSync(join(clientRoot, 'scripts'), { recursive: true });
  cpSync(REAL_SCRIPT, join(clientRoot, 'scripts/generate-premium-glue.mjs'));
  mkdirSync(join(clientRoot, 'pages/api'), { recursive: true });
  // fix-overwatch sorts before overwatch
  writeOverlay('fix-overwatch');
  writeOverlay('overwatch');
  writeFileSync(
    join(sandbox, 'sst.config.ts'),
    `await import('./infra/premium-generated/fix-overwatch-infra.generated');\n` +
      `await import('./infra/premium-generated/overwatch-infra.generated');\n`
  );
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe('premium package name collision', () => {
  it('keeps the pnpm-linked directory even when an unlinked one sorts first', () => {
    linkTo('overwatch');
    const { stderr } = runCodegen();

    expect(stderr).toContain('skipping fix-overwatch');
    expect(stderr).toContain('keeping overwatch');

    const routes = readGenerated('apps/client/app/premium-generated/premiumRoutes.generated.ts');
    expect(routes.match(new RegExp(`from '${PKG_NAME}/routes'`, 'g'))).toHaveLength(1);

    expect(readGenerated('infra/premium-generated/overwatch-infra.generated.ts')).toContain(
      `from '../../packages/premium/overwatch/src/infra'`
    );
    expect(readGenerated('infra/premium-generated/fix-overwatch-infra.generated.ts')).toContain(
      'export function contributeInfra'
    );
  });

  it('falls back to the sorted-first directory when neither is linked', () => {
    const { stderr } = runCodegen();

    expect(stderr).toContain('skipping overwatch');
    expect(stderr).toContain('keeping fix-overwatch');

    expect(readGenerated('infra/premium-generated/fix-overwatch-infra.generated.ts')).toContain(
      `from '../../packages/premium/fix-overwatch/src/infra'`
    );
    expect(readGenerated('infra/premium-generated/overwatch-infra.generated.ts')).toContain(
      'export function contributeInfra'
    );
  });
});
