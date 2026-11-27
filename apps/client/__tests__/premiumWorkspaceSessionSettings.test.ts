import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WORKSPACE_SURFACES } from '../../../b4m-core/common/src/surfaces';

/**
 * Guard for the workspace session-settings contribution: ids are declared as data so the generator
 * can validate them. Runs the real script inside a sandbox tree, since its paths derive from its own
 * location.
 */

const REAL_SCRIPT = join(__dirname, '../scripts/generate-premium-glue.mjs');
const GENERATED = 'packages/server-utils/src/premium-generated/premiumWorkspaceSessionSettings.generated.ts';

let sandbox: string;
let script: string;
let clientRoot: string;

// The generator imports an overlay's declared export by relative path, so give each subpath the
// contributions name an `exports` entry pointing at src/<subpath>.ts.
function declaredExports(name: string, contributions: Record<string, unknown>) {
  const specifiers = Object.values(contributions).flatMap(value =>
    value && typeof value === 'object' && !Array.isArray(value) ? Object.values(value) : [value]
  );
  return Object.fromEntries(
    specifiers
      .filter((s): s is string => typeof s === 'string' && s.startsWith(`${name}/`))
      .map(s => [`.${s.slice(name.length)}`, `./src${s.slice(name.length)}.ts`])
  );
}

function writeOverlay(dir: string, contributions: Record<string, unknown>) {
  const overlayDir = join(sandbox, 'packages/premium', dir);
  mkdirSync(overlayDir, { recursive: true });
  writeFileSync(
    join(overlayDir, 'package.json'),
    JSON.stringify({
      name: `@bike4mind/premium-${dir}`,
      exports: declaredExports(`@bike4mind/premium-${dir}`, contributions),
      b4mContributions: contributions,
    })
  );
  // Linked the way a pnpm workspace link would; an unlinked overlay gets the absent form.
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
  return readFileSync(join(sandbox, GENERATED), 'utf8');
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

/** Non-null ids in the registry; the generator mirrors this set as `REGISTERED_WORKSPACE_IDS`. */
const REGISTERED = WORKSPACE_SURFACES.map(surface => surface.id).filter((id): id is string => id !== null);

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
    writeOverlay('alpha', { workspaceSessionSettingsExport: { opti: '@bike4mind/premium-alpha/session-settings' } });

    const out = generate();

    expect(out).toContain(
      "import { workspaceSessionSettings as settings0 } from '../../../premium/alpha/src/session-settings';"
    );
    expect(out).toContain('"opti": settings0,');
    expect(out).toContain('= defineWorkspaceSessionSettingsTable({');
  });

  it('accepts every workspace id registered in WORKSPACE_SURFACES', () => {
    expect(REGISTERED.length).toBeGreaterThan(0);
    writeOverlay('registered', {
      workspaceSessionSettingsExport: Object.fromEntries(
        REGISTERED.map(id => [id, `@bike4mind/premium-registered/${id}`])
      ),
    });

    const out = generate();

    REGISTERED.forEach((id, i) => {
      expect(out).toContain(`"${id}": settings${i},`);
    });
  });

  it('rejects a workspace id that is not a registered surface', () => {
    writeOverlay('unknown', {
      workspaceSessionSettingsExport: { 'not-a-surface': '@bike4mind/premium-unknown/settings' },
    });

    const result = runCodegen();

    expect(result.status, result.stdout).not.toBe(0);
    expect(result.stderr).toContain('"not-a-surface" is not a registered workspace surface id');
    expect(result.stderr).toContain(`(${REGISTERED.join(', ')})`);
  });

  it('accepts a guarded surface registered by its contributing package', () => {
    writeOverlay('guarded', {
      workspaceSurfaceIds: ['private-example'],
      workspaceSessionSettingsExport: { 'private-example': '@bike4mind/premium-guarded/settings' },
    });

    expect(generate()).toContain('"private-example": settings0,');
  });

  it('emits public and guarded settings together', () => {
    writeOverlay('mixed', {
      workspaceSurfaceIds: ['private-example'],
      workspaceSessionSettingsExport: {
        opti: '@bike4mind/premium-mixed/open-settings',
        'private-example': '@bike4mind/premium-mixed/private-settings',
      },
    });

    const out = generate();

    expect(out).toContain('"opti": settings0,');
    expect(out).toContain('"private-example": settings1,');
    expect(out).toContain(
      "import { workspaceSessionSettings as settings1 } from '../../../premium/mixed/src/private-settings';"
    );
  });

  it('rejects duplicate settings even when both packages register the surface', () => {
    for (const name of ['alpha', 'beta']) {
      writeOverlay(name, {
        workspaceSurfaceIds: ['private-example'],
        workspaceSessionSettingsExport: { 'private-example': `@bike4mind/premium-${name}/settings` },
      });
    }

    expectFailure('duplicate workspaceSessionSettingsExport workspace id "private-example"');
  });

  it('rejects a typo even when the package registers a guarded surface', () => {
    writeOverlay('guarded', {
      workspaceSurfaceIds: ['private-example'],
      workspaceSessionSettingsExport: { 'private-exampl': '@bike4mind/premium-guarded/settings' },
    });

    expectFailure('"private-exampl" is not a registered workspace surface id');
  });

  it("does not borrow another package's guarded surface registration", () => {
    writeOverlay('owner', { workspaceSurfaceIds: ['private-example'] });
    writeOverlay('other', {
      workspaceSessionSettingsExport: { 'private-example': '@bike4mind/premium-other/settings' },
    });

    expectFailure('"private-example" is not a registered workspace surface id');
  });

  it.each([
    null,
    false,
    'private-example',
    {},
    [null],
    ['Example'],
    ['has space'],
    [''],
    ['__proto__'],
    ['constructor'],
    ['prototype'],
  ])('rejects malformed surface registration %j even without settings', workspaceSurfaceIds => {
    writeOverlay('malformed', { workspaceSurfaceIds });

    expectFailure('invalid workspaceSurfaceIds');
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
    writeOverlay('alpha', { workspaceSessionSettingsExport: { opti: '@bike4mind/premium-alpha/a' } });
    writeOverlay('beta', { workspaceSessionSettingsExport: { opti: '@bike4mind/premium-beta/b' } });

    expectFailure('duplicate workspaceSessionSettingsExport workspace id "opti"');
  });

  it.each(['../escape/settings', './local', "x'; process.exit(0); //", '', 42])(
    'rejects the module specifier %s',
    specifier => {
      writeOverlay('badSpec', { workspaceSessionSettingsExport: { opti: specifier } });

      expectFailure('invalid workspaceSessionSettingsExport from package');
    }
  );
});
