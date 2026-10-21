import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PremiumEntitlementGrants } from '@client/app/premiumContract';

const GENERATED = '@client/app/premium-generated/premiumEntitlementGrants.generated';

async function loadRegistry(premiumEntitlementGrants: unknown) {
  vi.resetModules();
  vi.doMock(GENERATED, () => ({ premiumEntitlementGrants }));
  return import('./registry');
}

afterEach(() => {
  vi.doUnmock(GENERATED);
  vi.unstubAllEnvs();
});

const CONTRIBUTION: PremiumEntitlementGrants = {
  tagGrants: [{ tag: 'example-pro', entitlements: ['example:pro'] }],
  impliedEntitlements: [{ ifHeld: 'example:pro', alsoGrant: ['example:addon'] }],
  signupCredits: [
    { key: 'example:pro', credits: 1000 },
    { key: 'example:addon', credits: 500 },
  ],
  internalStaffEntitlements: ['example:staff'],
};

describe('registry resolution with contributed rows', () => {
  it('resolves a contributed tag grant and the key it implies', async () => {
    const registry = await loadRegistry(CONTRIBUTION);

    expect(registry.entitlementsForTags(['Example-Pro'])).toEqual(new Set(['example-pro', 'example:pro']));
    expect(registry.applyImpliedEntitlements(['example:pro'])).toEqual(['example:pro', 'example:addon']);
    expect(registry.grantTagForEntitlement('example:pro')).toBe('example-pro');
  });

  it('pays contributed signup credits once per bundle', async () => {
    const registry = await loadRegistry(CONTRIBUTION);

    expect(registry.signupCreditsForKeys(['example:pro'])).toBe(1000);
    expect(registry.signupCreditsForKeys(['example:pro', 'example:addon'])).toBe(1000);
    expect(registry.signupCreditsForKeys(['example:addon'])).toBe(500);
  });

  it('lists contributed keys as known and still rejects a typo', async () => {
    const registry = await loadRegistry(CONTRIBUTION);

    for (const key of ['example:pro', 'example:addon', 'example:staff']) {
      expect(registry.KNOWN_ENTITLEMENT_KEYS).toContain(key);
    }
    expect(registry.unknownEntitlementKeys(['example:pro', 'example:prp'])).toEqual(['example:prp']);
  });

  it('grants contributed internal staff keys to a verified staff-domain email', async () => {
    vi.stubEnv('NEXT_PUBLIC_INTERNAL_STAFF_DOMAINS', 'staff.example.com');
    const registry = await loadRegistry(CONTRIBUTION);

    expect(registry.entitlementsForEmail('a@staff.example.com', true)).toContain('example:staff');
    expect(registry.entitlementsForEmail('a@staff.example.com', false).size).toBe(0);
  });

  it('falls back to the built-in rows when the contribution is malformed', async () => {
    const builtIn = (await loadRegistry({})).__registryRows.builtInRows;
    const registry = await loadRegistry('not an object');

    expect(registry.__registryRows.tagGrantRows).toEqual(builtIn.tagGrantRows);
    expect(registry.__registryRows.impliedRows).toEqual(builtIn.impliedRows);
  });
});

describe('mergeContributedRows', () => {
  const BUILT_IN = {
    tagGrantRows: [{ tag: 'core', entitlements: ['core:pro'] }],
    impliedRows: [{ ifHeld: 'core:pro', alsoGrant: ['core:addon'] }],
    signupCreditRows: [{ key: 'core:pro', credits: 100 }],
    internalStaffEntitlements: ['core:pro'],
  };

  const merge = async (contributed: unknown) =>
    (await loadRegistry({})).mergeContributedRows(BUILT_IN, contributed as PremiumEntitlementGrants);

  it('returns the built-in rows for an empty or missing contribution', async () => {
    expect(await merge({})).toEqual(BUILT_IN);
    expect(await merge(undefined)).toEqual(BUILT_IN);
  });

  it('adds keys to a built-in tag or implying key and appends new ones, normalized', async () => {
    const merged = await merge({
      tagGrants: [
        { tag: ' CORE ', entitlements: ['Example:Extra', 'core:pro'] },
        { tag: 'Example', entitlements: ['example:pro'] },
      ],
      impliedEntitlements: [{ ifHeld: 'core:pro', alsoGrant: ['example:pro'] }],
      internalStaffEntitlements: ['EXAMPLE:PRO', 'core:pro'],
    });

    expect(merged.tagGrantRows).toEqual([
      { tag: 'core', entitlements: ['core:pro', 'example:extra'] },
      { tag: 'example', entitlements: ['example:pro'] },
    ]);
    expect(merged.impliedRows).toEqual([{ ifHeld: 'core:pro', alsoGrant: ['core:addon', 'example:pro'] }]);
    expect(merged.internalStaffEntitlements).toEqual(['core:pro', 'example:pro']);
  });

  it('never overrides a built-in signup credit amount', async () => {
    const merged = await merge({
      signupCredits: [
        { key: 'CORE:PRO', credits: 999_999 },
        { key: 'example:pro', credits: 50 },
      ],
    });

    expect(merged.signupCreditRows).toEqual([
      { key: 'core:pro', credits: 100 },
      { key: 'example:pro', credits: 50 },
    ]);
  });

  it('drops malformed fields, rows and values without throwing', async () => {
    const merged = await merge({
      tagGrants: 'core',
      impliedEntitlements: [null, 'x', { ifHeld: 7, alsoGrant: ['example:a'] }, { ifHeld: 'example:a', alsoGrant: [] }],
      signupCredits: [
        { key: 'example:zero', credits: 0 },
        { key: 'example:neg', credits: -1 },
        { key: 'example:nan', credits: Number.NaN },
        { key: 'example:inf', credits: Number.POSITIVE_INFINITY },
        { key: 'example:str', credits: '10' },
      ],
      internalStaffEntitlements: [42, '', 'example:staff'],
    });

    expect(merged).toEqual({ ...BUILT_IN, internalStaffEntitlements: ['core:pro', 'example:staff'] });
  });

  it('keeps an implication cycle resolvable', async () => {
    const merged = await merge({
      impliedEntitlements: [
        { ifHeld: 'core:addon', alsoGrant: ['example:a'] },
        { ifHeld: 'example:a', alsoGrant: ['core:pro'] },
      ],
    });
    const registry = await loadRegistry({});
    const graph = new Map(merged.impliedRows.map(row => [row.ifHeld, row.alsoGrant]));

    expect(registry.applyImpliedEntitlements(['core:pro'], graph)).toEqual(['core:pro', 'core:addon', 'example:a']);
  });
});
