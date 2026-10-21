import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_CONTRIBUTED_SIGNUP_CREDITS } from '@client/lib/entitlements/registry';

/**
 * Guard for the entitlement grant contribution (see `PremiumEntitlementGrants`): the registry trusts
 * the emitted rows' shape, so the validator is the control on it. Runs the real script inside a
 * sandbox tree, as premiumToolDisplayLabels.test.ts does.
 */

const REAL_SCRIPT = join(__dirname, '../scripts/generate-premium-glue.mjs');
const GENERATED = 'app/premium-generated/premiumEntitlementGrants.generated.ts';

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
  // CI is forced off: the script hard-fails a hydrated-but-unlinked tree when CI === 'true'.
  return spawnSync(process.execPath, [script], { encoding: 'utf8', env: { ...process.env, CI: '' } });
}

function generate() {
  const result = runCodegen();
  expect(result.status, result.stderr).toBe(0);
  return readFileSync(join(clientRoot, GENERATED), 'utf8');
}

function expectRejected(pattern: RegExp) {
  const result = runCodegen();
  expect(result.status).not.toBe(0);
  expect(result.stderr).toMatch(pattern);
}

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'b4m-entitlementgrants-test-'));
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

const emitted = (generated: string): unknown =>
  JSON.parse(generated.slice(generated.indexOf('= ') + 2, generated.lastIndexOf(';')));

describe('premium entitlement grants', () => {
  it('emits the empty form when no overlay is present', () => {
    expect(generate()).toContain('premiumEntitlementGrants: PremiumEntitlementGrants = {};');
  });

  it('emits the empty form when no overlay declares any', () => {
    writeOverlay('silent', {});

    expect(emitted(generate())).toEqual({});
  });

  it('emits declared rows without importing the overlay', () => {
    writeOverlay('alpha', {
      entitlementGrants: {
        tagGrants: [{ tag: 'example-pro', entitlements: ['example:pro', 'example:pro'] }],
        impliedEntitlements: [{ ifHeld: 'example:pro', alsoGrant: ['example:addon'] }],
        signupCredits: [{ key: 'example:pro', credits: 1000 }],
        internalStaffEntitlements: ['example:pro'],
      },
    });

    const generated = generate();

    expect(generated).not.toContain('@bike4mind/premium-alpha');
    expect(emitted(generated)).toEqual({
      tagGrants: [{ tag: 'example-pro', entitlements: ['example:pro'] }],
      impliedEntitlements: [{ ifHeld: 'example:pro', alsoGrant: ['example:addon'] }],
      signupCredits: [{ key: 'example:pro', credits: 1000 }],
      internalStaffEntitlements: ['example:pro'],
    });
  });

  it('accepts signup credits at the registry cap', () => {
    writeOverlay('alpha', {
      entitlementGrants: { signupCredits: [{ key: 'example:pro', credits: MAX_CONTRIBUTED_SIGNUP_CREDITS }] },
    });

    expect(emitted(generate())).toEqual({
      signupCredits: [{ key: 'example:pro', credits: MAX_CONTRIBUTED_SIGNUP_CREDITS }],
    });
  });

  it('merges rows across overlays and collapses an identical repeat', () => {
    writeOverlay('alpha', {
      entitlementGrants: {
        tagGrants: [{ tag: 'shared', entitlements: ['example:b', 'example:a'] }],
        internalStaffEntitlements: ['example:a'],
      },
    });
    writeOverlay('beta', {
      entitlementGrants: {
        tagGrants: [
          { tag: 'shared', entitlements: ['example:a', 'example:b'] },
          { tag: 'beta-pro', entitlements: ['beta:pro'] },
        ],
        internalStaffEntitlements: ['example:a', 'beta:pro'],
      },
    });

    expect(emitted(generate())).toEqual({
      tagGrants: [
        { tag: 'shared', entitlements: ['example:a', 'example:b'] },
        { tag: 'beta-pro', entitlements: ['beta:pro'] },
      ],
      internalStaffEntitlements: ['beta:pro', 'example:a'],
    });
  });

  it.each([
    [
      'tagGrants',
      { tagGrants: [{ tag: 'shared', entitlements: ['example:a'] }] },
      { tagGrants: [{ tag: 'shared', entitlements: ['example:b'] }] },
    ],
    [
      'impliedEntitlements',
      { impliedEntitlements: [{ ifHeld: 'example:a', alsoGrant: ['example:b'] }] },
      { impliedEntitlements: [{ ifHeld: 'example:a', alsoGrant: ['example:c'] }] },
    ],
    [
      'signupCredits',
      { signupCredits: [{ key: 'example:a', credits: 10 }] },
      { signupCredits: [{ key: 'example:a', credits: 20 }] },
    ],
  ])('fails when two overlays give one %s id different values, naming both', (field, alpha, beta) => {
    writeOverlay('alpha', { entitlementGrants: alpha });
    writeOverlay('beta', { entitlementGrants: beta });

    expectRejected(
      new RegExp(
        `entitlementGrants\\.${field} gives .* in packages "@bike4mind/premium-alpha" and "@bike4mind/premium-beta"`
      )
    );
  });

  it('fails when two tags grant one key, naming both', () => {
    writeOverlay('alpha', {
      entitlementGrants: { tagGrants: [{ tag: 'example-one', entitlements: ['example:pro'] }] },
    });
    writeOverlay('beta', { entitlementGrants: { tagGrants: [{ tag: 'example-two', entitlements: ['example:pro'] }] } });

    expectRejected(/grants "example:pro" from tag "example-one" .* and tag "example-two"/);
  });

  it.each([
    ['a non-object declaration', ['example:pro']],
    ['an unknown field', { priceGrants: [] }],
    ['a non-array field', { tagGrants: { tag: 'example-pro', entitlements: ['example:pro'] } }],
    ['a non-object row', { tagGrants: ['example-pro'] }],
    ['a mixed-case tag', { tagGrants: [{ tag: 'Example-Pro', entitlements: ['example:pro'] }] }],
    ['a tag outside the safe charset', { tagGrants: [{ tag: "x'];//", entitlements: ['example:pro'] }] }],
    ['a mixed-case key', { tagGrants: [{ tag: 'example-pro', entitlements: ['Example:Pro'] }] }],
    ['an empty key list', { tagGrants: [{ tag: 'example-pro', entitlements: [] }] }],
    ['a missing key list', { impliedEntitlements: [{ ifHeld: 'example:pro' }] }],
    ['an empty internal staff list', { internalStaffEntitlements: [] }],
    ['zero signup credits', { signupCredits: [{ key: 'example:pro', credits: 0 }] }],
    ['negative signup credits', { signupCredits: [{ key: 'example:pro', credits: -5 }] }],
    ['non-numeric signup credits', { signupCredits: [{ key: 'example:pro', credits: '100' }] }],
    ['NaN signup credits (null once serialized)', { signupCredits: [{ key: 'example:pro', credits: NaN }] }],
    ['fractional signup credits', { signupCredits: [{ key: 'example:pro', credits: 1.5 }] }],
    [
      'oversized signup credits',
      { signupCredits: [{ key: 'example:pro', credits: MAX_CONTRIBUTED_SIGNUP_CREDITS + 1 }] },
    ],
    [
      'an implication from the reserved base key',
      { impliedEntitlements: [{ ifHeld: 'base', alsoGrant: ['example:a'] }] },
    ],
    ['a reserved base tag', { tagGrants: [{ tag: 'base', entitlements: ['example:pro'] }] }],
    ['a datalake grant', { tagGrants: [{ tag: 'example-pro', entitlements: ['datalake:some-lake'] }] }],
    ['an embed grant', { impliedEntitlements: [{ ifHeld: 'example:pro', alsoGrant: ['embed:whitelabel'] }] }],
    ['a reserved staff key', { internalStaffEntitlements: ['embed:whitelabel'] }],
    ['a reserved signup-credit key', { signupCredits: [{ key: 'datalake:some-lake', credits: 10 }] }],
  ])('rejects %s', (_case, entitlementGrants) => {
    writeOverlay('bad', { entitlementGrants });

    expectRejected(/invalid entitlementGrants from package "@bike4mind\/premium-bad"/);
  });
});
