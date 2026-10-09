import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Guard for the workspace copy-grant contribution: overlays declare which extra entitlements may keep
 * a fork/snip/clone inside a workspace (see `PremiumWorkspaceCopyEntitlements`), and the server
 * enforces whatever lands in the generated table - so the validator is the control on its shape.
 *
 * Runs the real script inside a sandbox tree, since its paths derive from its own
 * location: sandbox/apps/client/scripts/ next to sandbox/packages/premium/.
 */

const REAL_SCRIPT = join(__dirname, '../scripts/generate-premium-glue.mjs');
const GENERATED = 'app/premium-generated/premiumWorkspaceCopyEntitlements.generated.ts';

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
}

function runCodegen() {
  // CI is forced off: the script hard-fails a hydrated-but-unlinked tree when
  // CI === 'true', and these overlays are deliberately never linked.
  return spawnSync(process.execPath, [script], { encoding: 'utf8', env: { ...process.env, CI: '' } });
}

function generate() {
  const result = runCodegen();
  expect(result.status, result.stderr).toBe(0);
  return readFileSync(join(clientRoot, GENERATED), 'utf8');
}

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'b4m-copygrants-test-'));
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
});

describe('premium workspace copy entitlements', () => {
  it('emits the empty form when no overlay declares any', () => {
    writeOverlay('silent', {});

    const generated = generate();

    expect(generated).toContain('premiumWorkspaceCopyEntitlements: PremiumWorkspaceCopyEntitlements = {}');
  });

  it('emits the declared grants for an overlay that is NOT linked into node_modules', () => {
    writeOverlay('alpha', { workspaceCopyEntitlements: { 'alpha-space': ['Base:Pro'] } });

    const generated = generate();

    // Keys are lowercased to match the resolved (normalized) entitlement list they are compared to.
    expect(generated).toContain(`"alpha-space": ["base:pro"]`);
    // Data only - the package is never imported to read its own grants.
    expect(generated).not.toContain('@bike4mind/premium-alpha');
  });

  it('merges grants for the same workspace across overlays and drops duplicates', () => {
    writeOverlay('alpha', { workspaceCopyEntitlements: { shared: ['base:pro', 'alpha:pro'] } });
    writeOverlay('beta', { workspaceCopyEntitlements: { shared: ['base:pro', 'beta:pro'], other: ['beta:pro'] } });

    const generated = generate();

    expect(generated).toContain(`"shared": ["base:pro", "alpha:pro", "beta:pro"]`);
    expect(generated).toContain(`"other": ["beta:pro"]`);
  });

  it('rejects a non-object declaration', () => {
    writeOverlay('malformed', { workspaceCopyEntitlements: ['base:pro'] });

    const { status, stderr } = runCodegen();

    expect(status).toBe(1);
    expect(stderr).toContain('expected an object of workspace id -> entitlement keys');
  });

  it('rejects a workspace id outside the safe charset', () => {
    writeOverlay('proto', { workspaceCopyEntitlements: JSON.parse('{"__proto__": ["base:pro"]}') });

    const { status, stderr } = runCodegen();

    expect(status).toBe(1);
    expect(stderr).toContain('invalid workspaceCopyEntitlements workspace id');
  });

  it('rejects keys that are not an array of entitlement keys', () => {
    writeOverlay('loose', { workspaceCopyEntitlements: { space: 'base:pro' } });
    expect(runCodegen().status).toBe(1);

    writeOverlay('loose', { workspaceCopyEntitlements: { space: [''] } });
    expect(runCodegen().status).toBe(1);

    writeOverlay('loose', { workspaceCopyEntitlements: { space: [`x"]; process.exit(0); //`] } });
    const { status, stderr } = runCodegen();
    expect(status).toBe(1);
    expect(stderr).toContain('invalid workspaceCopyEntitlements keys');
  });
});
