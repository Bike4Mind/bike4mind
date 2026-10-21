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

  it('lists a contributed staff key as known when no staff domain is configured', async () => {
    vi.stubEnv('NEXT_PUBLIC_INTERNAL_STAFF_DOMAINS', '');
    const registry = await loadRegistry({ internalStaffEntitlements: ['example:staff'] });

    expect(registry.__registryRows.domainGrantRows.flatMap(row => row.entitlements)).not.toContain('example:staff');
    expect(registry.unknownEntitlementKeys(['example:staff'])).toEqual([]);
  });

  it('serves the built-in rows for a malformed contribution', async () => {
    const builtIn = (await loadRegistry({})).__registryRows.builtInRows;
    const registry = await loadRegistry('not an object');

    expect(registry.__registryRows.tagGrantRows).toEqual(builtIn.tagGrantRows);
    expect(registry.__registryRows.impliedRows).toEqual(builtIn.impliedRows);
  });

  it('drops a contributed implication from the reserved base key and records why', async () => {
    const registry = await loadRegistry({ impliedEntitlements: [{ ifHeld: 'base', alsoGrant: ['example:pro'] }] });

    expect(registry.applyImpliedEntitlements([registry.BASE_ENTITLEMENT_KEY])).toEqual(['base']);
    expect(registry.__registryRows.rejectedContributions).toEqual([expect.stringContaining('reserved')]);
  });

  it('never lets a contributed tag grant a key a built-in tag grants', async () => {
    const builtIn = (await loadRegistry({})).__registryRows.builtInRows;
    const coreRow = builtIn.tagGrantRows[0];
    const registry = await loadRegistry({
      tagGrants: [{ tag: 'example-second', entitlements: [...coreRow.entitlements] }],
    });

    expect(registry.entitlementsForTags(['example-second'])).toEqual(new Set(['example-second']));
    expect(registry.grantTagForEntitlement(coreRow.entitlements[0])).toBe(coreRow.tag);
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

  it('appends new rows normalized and collapses a repeat of a built-in row', async () => {
    const merged = await merge({
      tagGrants: [
        { tag: ' CORE ', entitlements: ['core:pro'] },
        { tag: 'Example', entitlements: ['Example:Pro'] },
      ],
      impliedEntitlements: [
        { ifHeld: 'core:pro', alsoGrant: ['core:addon'] },
        { ifHeld: 'example:pro', alsoGrant: ['example:addon'] },
      ],
      signupCredits: [
        { key: 'CORE:PRO', credits: 100 },
        { key: 'example:pro', credits: 50 },
      ],
      internalStaffEntitlements: ['EXAMPLE:STAFF', 'core:pro'],
    });

    expect(merged).toEqual({
      tagGrantRows: [...BUILT_IN.tagGrantRows, { tag: 'example', entitlements: ['example:pro'] }],
      impliedRows: [...BUILT_IN.impliedRows, { ifHeld: 'example:pro', alsoGrant: ['example:addon'] }],
      signupCreditRows: [...BUILT_IN.signupCreditRows, { key: 'example:pro', credits: 50 }],
      internalStaffEntitlements: ['core:pro', 'example:staff'],
    });
  });

  it.each([
    ['a key added to a built-in tag', { tagGrants: [{ tag: 'core', entitlements: ['example:extra'] }] }],
    ['a new tag granting a built-in key', { tagGrants: [{ tag: 'example', entitlements: ['core:pro'] }] }],
    ['a new tag named after a built-in key', { tagGrants: [{ tag: 'core:addon', entitlements: ['example:pro'] }] }],
    ['a new tag granting a price-row key', { tagGrants: [{ tag: 'example', entitlements: ['core:priced'] }] }],
    [
      'a key added to a built-in implication',
      { impliedEntitlements: [{ ifHeld: 'core:pro', alsoGrant: ['example:a'] }] },
    ],
    [
      'an implication from a built-in key',
      { impliedEntitlements: [{ ifHeld: 'core:addon', alsoGrant: ['example:a'] }] },
    ],
    ['an implication to a built-in key', { impliedEntitlements: [{ ifHeld: 'example:a', alsoGrant: ['core:pro'] }] }],
    ['an implication from base', { impliedEntitlements: [{ ifHeld: 'base', alsoGrant: ['example:a'] }] }],
    ['a datalake grant', { tagGrants: [{ tag: 'example', entitlements: ['datalake:some-lake'] }] }],
    ['an embed grant', { impliedEntitlements: [{ ifHeld: 'example:a', alsoGrant: ['embed:whitelabel'] }] }],
    ['a changed built-in credit amount', { signupCredits: [{ key: 'CORE:PRO', credits: 999_999 }] }],
    ['credits for an unpriced built-in key', { signupCredits: [{ key: 'core:addon', credits: 10 }] }],
    ['fractional credits', { signupCredits: [{ key: 'example:pro', credits: 1.5 }] }],
    ['oversized credits', { signupCredits: [{ key: 'example:pro', credits: 250_001 }] }],
    ['a built-in key as a staff key', { internalStaffEntitlements: ['core:addon'] }],
    ['a reserved staff key', { internalStaffEntitlements: ['embed:whitelabel'] }],
  ])('drops %s and reports it', async (_case, contributed) => {
    const registry = await loadRegistry({});
    const reasons: string[] = [];
    const merged = registry.mergeContributedRows(BUILT_IN, contributed as PremiumEntitlementGrants, {
      otherCoreKeys: ['core:priced'],
      onReject: reason => reasons.push(reason),
    });

    expect(merged).toEqual(BUILT_IN);
    expect(reasons).toHaveLength(1);
  });

  it('keeps one granting tag per contributed key', async () => {
    const merged = await merge({
      tagGrants: [
        { tag: 'example-one', entitlements: ['example:pro'] },
        { tag: 'example-two', entitlements: ['example:pro'] },
      ],
    });

    expect(merged.tagGrantRows).toEqual([
      ...BUILT_IN.tagGrantRows,
      { tag: 'example-one', entitlements: ['example:pro'] },
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
        { ifHeld: 'example:a', alsoGrant: ['example:b'] },
        { ifHeld: 'example:b', alsoGrant: ['example:a'] },
      ],
    });
    const registry = await loadRegistry({});
    const graph = new Map(merged.impliedRows.map(row => [row.ifHeld, row.alsoGrant]));

    expect(registry.applyImpliedEntitlements(['example:a'], graph)).toEqual(['example:a', 'example:b']);
  });
});
