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
  signupCredits: [{ key: 'example:staff', credits: 1000 }],
  internalStaffEntitlements: ['example:staff'],
};

describe('registry resolution with contributed rows', () => {
  it('resolves a contributed tag grant and the key it implies', async () => {
    const registry = await loadRegistry(CONTRIBUTION);

    expect(registry.entitlementsForTags(['Example-Pro'])).toEqual(new Set(['example-pro', 'example:pro']));
    expect(registry.applyImpliedEntitlements(['example:pro'])).toEqual(['example:pro', 'example:addon']);
    expect(registry.grantTagForEntitlement('example:pro')).toBe('example-pro');
  });

  it('pays a contributed staff credit once and nothing on an uncredited key', async () => {
    const registry = await loadRegistry(CONTRIBUTION);

    expect(registry.signupCreditsForKeys(['example:staff'])).toBe(1000);
    expect(registry.signupCreditsForKeys(['example:staff', 'example:staff'])).toBe(1000);
    expect(registry.signupCreditsForKeys(['example:pro'])).toBe(0);
  });

  it('only implies between known keys over the merged rows', async () => {
    const registry = await loadRegistry({
      ...CONTRIBUTION,
      impliedEntitlements: [
        ...(CONTRIBUTION.impliedEntitlements ?? []),
        { ifHeld: 'example:orphan', alsoGrant: ['example:orphan-addon'] },
      ],
    });
    const known = new Set(registry.KNOWN_ENTITLEMENT_KEYS);
    const { impliedRows } = registry.__registryRows;

    expect(impliedRows.map(row => row.ifHeld)).toContain('example:pro');
    expect(impliedRows.map(row => row.ifHeld)).not.toContain('example:orphan');
    for (const row of impliedRows) {
      expect(known.has(row.ifHeld), `'${row.ifHeld}' is not a known key`).toBe(true);
      for (const key of row.alsoGrant) expect(known.has(key), `'${key}' is not a known key`).toBe(true);
    }
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

  it.each([false, true])(
    'keeps external grants on an overlapping staff domain (contribution: %s)',
    async contributed => {
      vi.stubEnv('NEXT_PUBLIC_INTERNAL_STAFF_DOMAINS', 'staff.example.com');
      vi.stubEnv(
        'NEXT_PUBLIC_PREMIUM_DOMAIN_GRANTS',
        JSON.stringify([{ domain: 'staff.example.com', entitlements: ['external:pro'] }])
      );
      const registry = await loadRegistry(contributed ? CONTRIBUTION : {});
      const expected = contributed ? ['external:pro', 'example:staff'] : ['external:pro'];

      expect([...registry.entitlementsForEmail('a@staff.example.com', true)]).toEqual(expected);
      expect(registry.entitlementsForEmail('a@staff.example.com', false).size).toBe(0);
      expect(registry.signupCreditsForKeys(expected)).toBe(contributed ? 1000 : 0);
      expect(registry.__registryRows.domainGrantRows.filter(row => row.domain === 'staff.example.com')).toHaveLength(1);
    }
  );

  it('does not add contributed staff keys to an external-only domain', async () => {
    vi.stubEnv('NEXT_PUBLIC_INTERNAL_STAFF_DOMAINS', 'staff.example.com');
    vi.stubEnv(
      'NEXT_PUBLIC_PREMIUM_DOMAIN_GRANTS',
      JSON.stringify([{ domain: 'external.example.com', entitlements: ['external:pro'] }])
    );
    const registry = await loadRegistry(CONTRIBUTION);
    const keys = registry.entitlementsForEmail('a@external.example.com', true);

    expect([...keys]).toEqual(['external:pro']);
    expect(registry.signupCreditsForKeys(keys)).toBe(0);
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
        { key: 'example:staff', credits: 50 },
      ],
      internalStaffEntitlements: ['EXAMPLE:STAFF', 'core:pro'],
    });

    expect(merged).toEqual({
      tagGrantRows: [...BUILT_IN.tagGrantRows, { tag: 'example', entitlements: ['example:pro'] }],
      impliedRows: [...BUILT_IN.impliedRows, { ifHeld: 'example:pro', alsoGrant: ['example:addon'] }],
      signupCreditRows: [...BUILT_IN.signupCreditRows, { key: 'example:staff', credits: 50 }],
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
    ['credits on a key no contributed staff key holds', { signupCredits: [{ key: 'example:pro', credits: 10 }] }],
    [
      'an implication from a key no contribution grants',
      { impliedEntitlements: [{ ifHeld: 'example:a', alsoGrant: ['example:b'] }] },
    ],
    ['a source tag', { tagGrants: [{ tag: 'source:x', entitlements: ['example:pro'] }] }],
    ['a reserved base tag', { tagGrants: [{ tag: 'base', entitlements: ['example:pro'] }] }],
    ['a reserved datalake tag', { tagGrants: [{ tag: 'datalake:x', entitlements: ['example:pro'] }] }],
    ['a reserved embed tag', { tagGrants: [{ tag: 'embed:x', entitlements: ['example:pro'] }] }],
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

  it.each([
    ['fractional', 1.5],
    ['oversized', 250_001],
    ['zero', 0],
    ['negative', -1],
    ['NaN', Number.NaN],
    ['infinite', Number.POSITIVE_INFINITY],
  ])('drops %s credits on a contributed staff key and says why', async (_case, credits) => {
    const registry = await loadRegistry({});
    const reasons: string[] = [];
    const merged = registry.mergeContributedRows(
      BUILT_IN,
      { internalStaffEntitlements: ['example:staff'], signupCredits: [{ key: 'example:staff', credits }] },
      { onReject: reason => reasons.push(reason) }
    );

    expect(merged).toEqual({
      ...BUILT_IN,
      internalStaffEntitlements: [...BUILT_IN.internalStaffEntitlements, 'example:staff'],
    });
    expect(reasons).toEqual(['signup credits for "example:staff" must be an integer from 1 to 250000']);
  });

  it('keeps the first credit row for a contributed key and reports a conflicting second', async () => {
    const registry = await loadRegistry({});
    const reasons: string[] = [];
    const merged = registry.mergeContributedRows(
      BUILT_IN,
      {
        internalStaffEntitlements: ['example:staff'],
        signupCredits: [
          { key: 'example:staff', credits: 100 },
          { key: 'example:staff', credits: 200 },
        ],
      },
      { onReject: reason => reasons.push(reason) }
    );

    expect(merged.signupCreditRows).toEqual([...BUILT_IN.signupCreditRows, { key: 'example:staff', credits: 100 }]);
    expect(reasons).toEqual(['signup credits for "example:staff" are contributed twice with different amounts']);
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
      tagGrants: [{ tag: 'example-a', entitlements: ['example:a'] }],
      impliedEntitlements: [
        { ifHeld: 'example:a', alsoGrant: ['example:b'] },
        { ifHeld: 'example:b', alsoGrant: ['example:a'] },
      ],
    });
    const registry = await loadRegistry({});
    const graph = new Map(merged.impliedRows.map(row => [row.ifHeld, row.alsoGrant]));

    expect(registry.applyImpliedEntitlements(['example:a'], graph)).toEqual(['example:a', 'example:b']);
  });

  it('chains an implication from a staff key and from another kept implication, in any order', async () => {
    const merged = await merge({
      internalStaffEntitlements: ['example:staff'],
      impliedEntitlements: [
        { ifHeld: 'example:b', alsoGrant: ['example:c'] },
        { ifHeld: 'example:staff', alsoGrant: ['example:b'] },
      ],
    });

    expect(merged.impliedRows.map(row => row.ifHeld)).toEqual(['core:pro', 'example:staff', 'example:b']);
  });

  it('drops an implication cycle that no contributed row grants into', async () => {
    const reasons: string[] = [];
    const registry = await loadRegistry({});
    const merged = registry.mergeContributedRows(
      BUILT_IN,
      {
        impliedEntitlements: [
          { ifHeld: 'example:a', alsoGrant: ['example:b'] },
          { ifHeld: 'example:b', alsoGrant: ['example:a'] },
        ],
      },
      { onReject: reason => reasons.push(reason) }
    );

    expect(merged.impliedRows).toEqual(BUILT_IN.impliedRows);
    expect(reasons).toHaveLength(2);
  });

  describe('a key core only pays signup credits on', () => {
    const CREDIT_ONLY = {
      ...BUILT_IN,
      signupCreditRows: [...BUILT_IN.signupCreditRows, { key: 'core:credited', credits: 100 }],
    };
    const CONTRIBUTED = {
      tagGrants: [
        { tag: 'example-pro', entitlements: ['example:pro'] },
        { tag: 'example-credited', entitlements: ['core:credited'] },
      ],
      impliedEntitlements: [{ ifHeld: 'example:pro', alsoGrant: ['core:credited'] }],
      internalStaffEntitlements: ['example:pro'],
      signupCredits: [{ key: 'example:pro', credits: 100 }],
    };
    const mergeOver = async (contributed: unknown) => {
      const registry = await loadRegistry({});
      const reasons: string[] = [];
      const merged = registry.mergeContributedRows(CREDIT_ONLY, contributed as PremiumEntitlementGrants, {
        onReject: reason => reasons.push(reason),
      });
      return { registry, merged, reasons };
    };

    it('lets a contribution grant and imply it', async () => {
      const { merged, reasons } = await mergeOver(CONTRIBUTED);

      expect(reasons).toEqual([]);
      expect(merged.tagGrantRows).toEqual([...CREDIT_ONLY.tagGrantRows, ...CONTRIBUTED.tagGrants]);
      expect(merged.impliedRows).toEqual([...CREDIT_ONLY.impliedRows, ...CONTRIBUTED.impliedEntitlements]);
      expect(merged.signupCreditRows).toEqual([...CREDIT_ONLY.signupCreditRows, { key: 'example:pro', credits: 100 }]);
    });

    it('pays its credit once when another held key implies it', async () => {
      const { registry, merged } = await mergeOver(CONTRIBUTED);
      const credits = new Map(merged.signupCreditRows.map(row => [row.key, row.credits]));
      const implications = new Map(merged.impliedRows.map(row => [row.ifHeld, row.alsoGrant]));
      const pay = (keys: string[]) =>
        registry.signupCreditsForKeys(registry.applyImpliedEntitlements(keys, implications), credits, implications);

      expect(pay(['example:pro'])).toBe(100);
      expect(pay(['example:pro', 'core:credited'])).toBe(100);
      expect(pay(['core:credited'])).toBe(100);
    });

    it.each([
      ['a tag', { tagGrants: [{ tag: 'example', entitlements: ['core:pro'] }] }],
      ['an implication', { impliedEntitlements: [{ ifHeld: 'core:pro', alsoGrant: ['example:a'] }] }],
      [
        'an implication to it',
        {
          internalStaffEntitlements: ['example:a'],
          impliedEntitlements: [{ ifHeld: 'example:a', alsoGrant: ['core:addon'] }],
        },
      ],
    ])('still drops %s naming a key core also grants', async (_case, contributed) => {
      const { merged, reasons } = await mergeOver(contributed);

      expect(merged.impliedRows).toEqual(CREDIT_ONLY.impliedRows);
      expect(merged.tagGrantRows).toEqual(CREDIT_ONLY.tagGrantRows);
      expect(merged.signupCreditRows).toEqual(CREDIT_ONLY.signupCreditRows);
      expect(reasons).toHaveLength(1);
    });
  });

  describe('against the real built-in tag names', () => {
    const loadReal = async () => {
      const registry = await loadRegistry({});
      const rows = registry.__registryRows.builtInRows;
      const owned = new Set(
        [
          ...rows.tagGrantRows.flatMap(row => row.entitlements),
          ...rows.impliedRows.flatMap(row => [row.ifHeld, ...row.alsoGrant]),
          ...rows.internalStaffEntitlements,
        ].map(key => key.toLowerCase())
      );
      const tagName = rows.tagGrantRows.map(row => row.tag.toLowerCase()).find(tag => !owned.has(tag));
      expect(tagName).toBeDefined();
      const reasons: string[] = [];
      const run = (contributed: unknown) =>
        registry.mergeContributedRows(rows, contributed as PremiumEntitlementGrants, {
          onReject: reason => reasons.push(reason),
        });
      return { rows, tagName: tagName as string, reasons, run };
    };

    it('rejects an implication from a built-in tag name', async () => {
      const { rows, tagName, reasons, run } = await loadReal();
      const merged = run({ impliedEntitlements: [{ ifHeld: tagName, alsoGrant: ['example:a'] }] });

      expect(merged.impliedRows).toEqual(rows.impliedRows);
      expect(reasons).toHaveLength(1);
    });

    it('rejects a staff key equal to a built-in tag name', async () => {
      const { rows, tagName, reasons, run } = await loadReal();
      const merged = run({ internalStaffEntitlements: [tagName] });

      expect(merged.internalStaffEntitlements).toEqual(rows.internalStaffEntitlements);
      expect(reasons).toHaveLength(1);
    });
  });
});
