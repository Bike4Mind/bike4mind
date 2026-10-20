import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Guard for the workspace session-settings contribution: ids are declared as data so the generator
 * can validate them. Runs the real script inside a sandbox tree, since its paths derive from its own
 * location.
 */

const REAL_SCRIPT = join(__dirname, '../scripts/generate-premium-glue.mjs');
const GENERATED = 'server/premium-generated/premiumWorkspaceSessionSettings.generated.ts';

let sandbox: string;
let script: string;
let clientRoot: string;

function writeOverlay(dir: string, contributions: Record<string, unknown>) {
  const overlayDir = join(sandbox, 'packages/premium', dir);
  mkdirSync(overlayDir, { recursive: true });
  writeFileSync(
    join(overlayDir, 'package.json'),
    JSON.stringify({ name: `@bike4mind/premium-${dir}`, b4mContributions: contributions })
  );
  // The generator emits bare-specifier imports, so it only reads overlays linked into node_modules.
  const linkDir = join(clientRoot, 'node_modules/@bike4mind');
  mkdirSync(linkDir, { recursive: true });
  symlinkSync(overlayDir, join(linkDir, `premium-${dir}`));
}

function runCodegen() {
  return spawnSync(process.execPath, [script], { encoding: 'utf8', env: { ...process.env, CI: '' } });
}

function generate() {
  const result = runCodegen();
  expect(result.status, result.stderr).toBe(0);
  return readFileSync(join(clientRoot, GENERATED), 'utf8');
}

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'b4m-sessionsettings-test-'));
  clientRoot = join(sandbox, 'apps/client');
  script = join(clientRoot, 'scripts/generate-premium-glue.mjs');
  mkdirSync(join(clientRoot, 'scripts'), { recursive: true });
  cpSync(REAL_SCRIPT, script);
});

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(join(sandbox, 'packages/premium'), { recursive: true, force: true });
  rmSync(join(clientRoot, 'node_modules'), { recursive: true, force: true });
});

const EMPTY = 'premiumWorkspaceSessionSettings: WorkspaceSessionSettingsTable = {};';

function expectFailure(stderrFragment: string) {
  const result = runCodegen();
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain(stderrFragment);
}

describe('premium workspace session settings', () => {
  it('emits the empty form when no overlay is present', () => {
    mkdirSync(join(sandbox, 'packages/premium'), { recursive: true });

    expect(generate()).toContain(EMPTY);
  });

  it('emits the empty form when an overlay declares none', () => {
    writeOverlay('silent', {});

    expect(generate()).toContain(EMPTY);
  });

  it('imports each contributed module under its workspace id', () => {
    writeOverlay('alpha', {
      workspaceSessionSettingsExport: { 'example-workspace': '@bike4mind/premium-alpha/session-settings' },
    });
    writeOverlay('beta', { workspaceSessionSettingsExport: { other_space: '@bike4mind/premium-beta/settings' } });

    const out = generate();

    expect(out).toContain(
      "import { workspaceSessionSettings as settings0 } from '@bike4mind/premium-alpha/session-settings';"
    );
    expect(out).toContain("import { workspaceSessionSettings as settings1 } from '@bike4mind/premium-beta/settings';");
    expect(out).toContain('"example-workspace": settings0,');
    expect(out).toContain('"other_space": settings1,');
    expect(out).toContain('= defineWorkspaceSessionSettingsTable({');
  });

  it.each([[null], [false], [[]], ['@bike4mind/premium-malformed/settings']])(
    'rejects a contribution that is not an object: %j',
    contribution => {
      writeOverlay('malformed', { workspaceSessionSettingsExport: contribution });

      expectFailure('expected an object of workspace id -> module specifier');
    }
  );

  it.each(['Example-Workspace', 'has space', '__proto__', 'constructor', 'prototype'])(
    'rejects the workspace id %s',
    workspaceId => {
      writeOverlay('badId', {
        workspaceSessionSettingsExport: { [workspaceId]: '@bike4mind/premium-badId/settings' },
      });

      expectFailure('invalid workspaceSessionSettingsExport workspace id');
    }
  );

  it('rejects the same workspace id from two packages', () => {
    writeOverlay('alpha', { workspaceSessionSettingsExport: { 'example-workspace': '@bike4mind/premium-alpha/a' } });
    writeOverlay('beta', { workspaceSessionSettingsExport: { 'example-workspace': '@bike4mind/premium-beta/b' } });

    expectFailure('duplicate workspaceSessionSettingsExport workspace id "example-workspace"');
  });

  it.each(['../escape/settings', './local', "x'; process.exit(0); //", '', 42])(
    'rejects the module specifier %s',
    specifier => {
      writeOverlay('badSpec', { workspaceSessionSettingsExport: { 'example-workspace': specifier } });

      expectFailure('invalid workspaceSessionSettingsExport from package');
    }
  );
});
