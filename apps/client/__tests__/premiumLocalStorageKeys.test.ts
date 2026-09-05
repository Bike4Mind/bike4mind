import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Guard for the localStorage-key-prefix contribution: overlays declare the prefixes
 * they own and core sweeps them at identity change (see `PremiumLocalStorageKeyPrefixes`).
 *
 * The prefixes are interpolated raw into a generated string literal, so the validator
 * is a build-time control, not a nicety - the rejection cases below are the control.
 *
 * Runs the real script inside a sandbox tree, since its paths derive from its own
 * location: sandbox/apps/client/scripts/ next to sandbox/packages/premium/.
 */

const REAL_SCRIPT = join(__dirname, '../scripts/generate-premium-glue.mjs');
const GENERATED = 'app/premium-generated/premiumLocalStorageKeys.generated.ts';

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
  sandbox = mkdtempSync(join(tmpdir(), 'b4m-lskeys-test-'));
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

describe('premium localStorage key prefixes', () => {
  it('emits the empty form when no overlay declares any', () => {
    writeOverlay('silent', {});

    const generated = generate();

    expect(generated).toContain('premiumLocalStorageKeyPrefixes: PremiumLocalStorageKeyPrefixes = []');
  });

  it('emits the declared prefixes for an overlay that is NOT linked into node_modules', () => {
    // The whole point of the contribution: it is data, not a module specifier, so it
    // never needs the overlay resolvable. Nothing links the overlay in this sandbox.
    writeOverlay('alpha', { localStorageKeyPrefixes: ['alpha-panel:', 'alpha.store'] });

    const generated = generate();

    expect(generated).toContain(`'alpha-panel:'`);
    expect(generated).toContain(`'alpha.store'`);
    // Data only - the package is never imported to read its own prefixes.
    expect(generated).not.toContain('@bike4mind/premium-alpha');
  });

  it('merges prefixes across overlays and drops duplicates', () => {
    writeOverlay('alpha', { localStorageKeyPrefixes: ['shared-', 'alpha-'] });
    writeOverlay('beta', { localStorageKeyPrefixes: ['shared-', 'beta-'] });

    const generated = generate();

    expect(generated.match(/'shared-'/g)).toHaveLength(1);
    expect(generated).toContain(`'alpha-'`);
    expect(generated).toContain(`'beta-'`);
  });

  it('rejects an empty prefix rather than emitting a sweep that matches every key', () => {
    writeOverlay('greedy', { localStorageKeyPrefixes: [''] });

    const { status, stderr } = runCodegen();

    expect(status).toBe(1);
    expect(stderr).toContain('invalid localStorageKeyPrefixes entry');
  });

  it('rejects a prefix that could break out of the generated string literal', () => {
    writeOverlay('injector', { localStorageKeyPrefixes: [`x'; process.exit(0); //`] });

    const { status, stderr } = runCodegen();

    expect(status).toBe(1);
    expect(stderr).toContain('invalid localStorageKeyPrefixes entry');
  });

  it('rejects a non-array declaration', () => {
    writeOverlay('malformed', { localStorageKeyPrefixes: 'alpha-' });

    const { status, stderr } = runCodegen();

    expect(status).toBe(1);
    expect(stderr).toContain('expected an array of key prefixes');
  });
});
