import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Guard for the admin-settings contribution: the registration module imports the generated file
 * statically on the server and the client, so it must exist (empty) with nothing mounted. Server
 * handler stubs must register the settings themselves, since cron and queue Lambdas do not go
 * through baseApi.
 */

const REAL_SCRIPT = join(__dirname, '../scripts/generate-premium-glue.mjs');
const GENERATED = 'packages/server-utils/src/premium-generated/premiumAdminSettings.generated.ts';

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

// Hydrates the overlay under packages/premium AND links it from apps/client's node_modules, the
// way a pnpm workspace link would, so the bare-specifier glue treats it as resolvable.
function writeOverlay(dir: string, contributions: Record<string, unknown>) {
  const name = `@bike4mind/premium-${dir}`;
  const overlayDir = join(sandbox, 'packages/premium', dir);
  mkdirSync(overlayDir, { recursive: true });
  writeFileSync(
    join(overlayDir, 'package.json'),
    JSON.stringify({ name, exports: declaredExports(name, contributions), b4mContributions: contributions })
  );
  const linkDir = join(clientRoot, 'node_modules', name);
  mkdirSync(linkDir, { recursive: true });
  writeFileSync(join(linkDir, 'package.json'), JSON.stringify({ name }));
}

function runCodegen() {
  // CI is forced off: the script hard-fails a hydrated-but-unlinked tree when CI === 'true'.
  return spawnSync(process.execPath, [script], { encoding: 'utf8', env: { ...process.env, CI: '' } });
}

function generate() {
  const result = runCodegen();
  expect(result.status, result.stderr).toBe(0);
  return readFileSync(join(sandbox, GENERATED), 'utf8');
}

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'b4m-adminsettings-test-'));
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

describe('premium admin settings', () => {
  it('emits the empty typed form when no overlay is present', () => {
    const out = generate();
    expect(out).toContain(`import type { SettingDefinition } from '@bike4mind/common';`);
    expect(out).toContain('premiumAdminSettings: SettingDefinition<string>[] = [];');
  });

  it('spreads every contributor into one list', () => {
    writeOverlay('alpha', { adminSettingsExport: '@bike4mind/premium-alpha/admin-settings' });
    writeOverlay('beta', { adminSettingsExport: '@bike4mind/premium-beta/admin-settings' });
    const out = generate();
    expect(out).toContain(`import { adminSettings as settings0 } from '../../../premium/alpha/src/admin-settings';`);
    expect(out).toContain(`import { adminSettings as settings1 } from '../../../premium/beta/src/admin-settings';`);
    expect(out).toContain('[\n  ...settings0,\n  ...settings1\n];');
  });

  it('rejects a specifier that is not a module path', () => {
    writeOverlay('alpha', { adminSettingsExport: "x'; process.exit(1); '" });
    const result = runCodegen();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/adminSettingsExport/);
  });

  it('registers the settings at the top of every server handler stub', () => {
    writeOverlay('alpha', {
      serverHandlerStubs: [
        { generatedPath: 'server/premium-generated/alpha/cron.ts', exportFrom: '@bike4mind/premium-alpha/cron' },
      ],
    });
    generate();
    const stub = readFileSync(join(clientRoot, 'server/premium-generated/alpha/cron.ts'), 'utf8');
    const lines = stub.split('\n');
    const registerLine = lines.indexOf(
      `import '../../../../../packages/server-utils/src/lib/settings/registerContributedSettings';`
    );
    expect(registerLine).toBeGreaterThan(-1);
    expect(registerLine).toBeLessThan(lines.indexOf(`export * from '@bike4mind/premium-alpha/cron';`));
  });

  it('points the stubs at the registration module that exists', () => {
    expect(
      existsSync(join(__dirname, '../../../packages/server-utils/src/lib/settings/registerContributedSettings.ts'))
    ).toBe(true);
  });
});
