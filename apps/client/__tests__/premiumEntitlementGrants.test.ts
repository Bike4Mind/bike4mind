import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_CONTRIBUTED_SIGNUP_CREDITS,
  isReservedContributionKey,
} from '@bike4mind/server-utils/lib/entitlements/registry';

/**
 * Guard for the entitlement grant contribution (see `PremiumEntitlementGrants`): the registry trusts
 * the emitted rows' shape, so the validator is the control on it. Runs the real script inside a
 * sandbox tree, as premiumToolDisplayLabels.test.ts does.
 */

const REAL_SCRIPT = join(__dirname, '../scripts/generate-premium-glue.mjs');
const GENERATED = 'packages/server-utils/src/premium-generated/premiumEntitlementGrants.generated.ts';

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
  return readFileSync(join(sandbox, GENERATED), 'utf8');
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
      entitlementGrants: {
        signupCredits: [{ key: 'example:staff', credits: MAX_CONTRIBUTED_SIGNUP_CREDITS }],
        internalStaffEntitlements: ['example:staff'],
      },
    });

    expect(emitted(generate())).toEqual({
      signupCredits: [{ key: 'example:staff', credits: MAX_CONTRIBUTED_SIGNUP_CREDITS }],
      internalStaffEntitlements: ['example:staff'],
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

  it('accepts an implication chained from a staff key or another overlay', () => {
    writeOverlay('alpha', {
      entitlementGrants: {
        internalStaffEntitlements: ['example:staff'],
        impliedEntitlements: [{ ifHeld: 'example:staff', alsoGrant: ['example:b'] }],
      },
    });
    writeOverlay('beta', {
      entitlementGrants: { impliedEntitlements: [{ ifHeld: 'example:b', alsoGrant: ['example:c'] }] },
    });

    expect(generate()).toContain('example:c');
  });

  it('names the package whose implication or credit row has no contributed grant', () => {
    writeOverlay('bad', {
      entitlementGrants: { impliedEntitlements: [{ ifHeld: 'example:a', alsoGrant: ['example:b'] }] },
    });
    expectRejected(/package "@bike4mind\/premium-bad".*ifHeld "example:a"/);

    writeOverlay('bad', { entitlementGrants: { signupCredits: [{ key: 'example:a', credits: 5 }] } });
    expectRejected(/package "@bike4mind\/premium-bad".*signupCredits key "example:a"/);
  });

  it.each(['base', 'datalake:x', 'embed:x', 'source:x', 'customer', 'pending-free-credits'])(
    'rejects reserved tag %s as the registry does',
    sample => {
      expect(isReservedContributionKey(sample)).toBe(true);
      writeOverlay('bad', { entitlementGrants: { tagGrants: [{ tag: sample, entitlements: ['example:pro'] }] } });

      expectRejected(/invalid entitlementGrants from package "@bike4mind\/premium-bad".*reserved/);
    }
  );

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
    ['non-numeric signup credits', { signupCredits: [{ key: 'example:pro', credits: '100' }] }],
    [
      'an implication from the reserved base key',
      { impliedEntitlements: [{ ifHeld: 'base', alsoGrant: ['example:a'] }] },
    ],
    ['a reserved base tag', { tagGrants: [{ tag: 'base', entitlements: ['example:pro'] }] }],
    ['a datalake grant', { tagGrants: [{ tag: 'example-pro', entitlements: ['datalake:some-lake'] }] }],
    ['an embed grant', { impliedEntitlements: [{ ifHeld: 'example:pro', alsoGrant: ['embed:whitelabel'] }] }],
    ['a reserved staff key', { internalStaffEntitlements: ['embed:whitelabel'] }],
    ['a source tag', { tagGrants: [{ tag: 'source:x', entitlements: ['example:pro'] }] }],
    ['a signup-credit key no contributed staff key holds', { signupCredits: [{ key: 'example:pro', credits: 10 }] }],
    [
      'an implication from a key no contribution grants',
      { impliedEntitlements: [{ ifHeld: 'example:a', alsoGrant: ['example:b'] }] },
    ],
    [
      'an implication cycle no contribution grants',
      {
        impliedEntitlements: [
          { ifHeld: 'example:a', alsoGrant: ['example:b'] },
          { ifHeld: 'example:b', alsoGrant: ['example:a'] },
        ],
      },
    ],
    ['a reserved signup-credit key', { signupCredits: [{ key: 'datalake:some-lake', credits: 10 }] }],
  ])('rejects %s', (_case, entitlementGrants) => {
    writeOverlay('bad', { entitlementGrants });

    expectRejected(/invalid entitlementGrants from package "@bike4mind\/premium-bad"/);
  });

  it.each([
    ['zero', 0],
    ['negative', -5],
    ['NaN (null once serialized)', NaN],
    ['fractional', 1.5],
    ['oversized', MAX_CONTRIBUTED_SIGNUP_CREDITS + 1],
  ])('rejects %s signup credits on a contributed staff key', (_case, credits) => {
    writeOverlay('bad', {
      entitlementGrants: {
        internalStaffEntitlements: ['example:staff'],
        signupCredits: [{ key: 'example:staff', credits }],
      },
    });

    expectRejected(/signupCredits for "example:staff" must be an integer from 1 to 250000/);
  });
});
