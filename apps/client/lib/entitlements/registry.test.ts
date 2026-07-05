import { describe, expect, it } from 'vitest';
import {
  __registryRows,
  entitlementsForEmail,
  entitlementsForPriceIds,
  entitlementsForTags,
  normalizeTag,
  resolveEntitlements,
  signupCreditsForEmail,
} from './registry';

// Behavior tests are table-driven over the real registry rows (no product
// literals here - product names in this file would trip the module boundary
// guard). The invariant tests below are the CI tripwire for config mistakes.
// The price-row check is now LIVE: PRICE_STAGED_ROWS has at least one real product
// row, and the staged price ids resolve from NEXT_PUBLIC_STRIPE_PRICE_* env vars
// seeded in vitest.setup.ts. It validates the wiring shape (both stages
// resolve to a real `price_` id) - it cannot detect a deployment that forgets to
// set the real prod var, which is inherent to build-time NEXT_PUBLIC_* inlining.

describe('registry invariants', () => {
  it('every price row has a real Stripe price id for both stages (no empty/placeholder fill-in)', () => {
    // Validate BOTH stages from the staged rows - the isTestMode ternary only
    // resolves one id at import (test-mode in CI), so checking the resolved
    // `priceRows` alone would let a placeholder prod id ship to production.
    for (const row of __registryRows.stagedPriceRows) {
      for (const priceId of [row.priceIds.test, row.priceIds.prod]) {
        expect(priceId, 'priceId must not be empty').toBeTruthy();
        expect(priceId, 'priceId must be a real Stripe id (both stages)').toMatch(/^price_(?!<)/);
      }
      expect(row.entitlements.length).toBeGreaterThan(0);
    }
  });

  it('every entitlement key and grant tag is already in canonical (normalized) form', () => {
    const allKeys = [
      ...__registryRows.priceRows.flatMap(r => r.entitlements),
      ...__registryRows.tagGrantRows.flatMap(r => r.entitlements),
      ...__registryRows.domainGrantRows.flatMap(r => r.entitlements),
    ];
    for (const key of allKeys) {
      expect(key).toBe(normalizeTag(key));
    }
    for (const row of __registryRows.tagGrantRows) {
      expect(row.tag).toBe(normalizeTag(row.tag));
    }
    for (const row of __registryRows.domainGrantRows) {
      expect(row.domain).toBe(normalizeTag(row.domain));
    }
  });

  // PRICE_ENTITLEMENTS / TAG_GRANTS are built via `new Map(rows.map(...))`, so a
  // duplicate key (priceId, or normalized tag) silently last-wins and drops the
  // earlier row's entitlements at runtime. Guard the config against that and
  // against grant rows that map to nothing - both are silent Q2+ footguns.
  it('has no duplicate priceId rows (Map build would silently drop the earlier one)', () => {
    const priceIds = __registryRows.priceRows.map(r => r.priceId);
    expect(new Set(priceIds).size).toBe(priceIds.length);
  });

  it('has no duplicate tag-grant rows after normalization', () => {
    const tags = __registryRows.tagGrantRows.map(r => normalizeTag(r.tag));
    expect(new Set(tags).size).toBe(tags.length);
  });

  it('every tag-grant row maps to at least one entitlement key', () => {
    for (const row of __registryRows.tagGrantRows) {
      expect(row.entitlements.length, `tag '${row.tag}' grants nothing`).toBeGreaterThan(0);
    }
  });

  it('has no duplicate domain-grant rows after normalization', () => {
    const domains = __registryRows.domainGrantRows.map(r => normalizeTag(r.domain));
    expect(new Set(domains).size).toBe(domains.length);
  });

  it('every domain-grant row maps to at least one entitlement key', () => {
    for (const row of __registryRows.domainGrantRows) {
      expect(row.entitlements.length, `domain '${row.domain}' grants nothing`).toBeGreaterThan(0);
    }
  });

  // SIGNUP_CREDITS is built via `new Map(rows.map(...))` keyed on the normalized
  // entitlement key - same silent-last-wins duplicate hazard as the grant maps.
  it('every signup-credit row is keyed in canonical (normalized) form', () => {
    for (const row of __registryRows.signupCreditRows) {
      expect(row.key).toBe(normalizeTag(row.key));
    }
  });

  it('has no duplicate signup-credit rows after normalization', () => {
    const keys = __registryRows.signupCreditRows.map(r => normalizeTag(r.key));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('every signup-credit row grants a positive, finite credit amount', () => {
    for (const row of __registryRows.signupCreditRows) {
      expect(Number.isInteger(row.credits), `signup credit for '${row.key}' must be an integer`).toBe(true);
      expect(row.credits, `signup credit for '${row.key}' must be positive`).toBeGreaterThan(0);
    }
  });
});

describe('normalizeTag', () => {
  it('lowercases and trims', () => {
    expect(normalizeTag('  SomeTag ')).toBe('sometag');
  });
});

describe('entitlementsForTags', () => {
  it('passes every tag through as its own key, normalized (1:1 rule)', () => {
    expect(entitlementsForTags(['Analyst', 'OTHER'])).toEqual(new Set(['analyst', 'other']));
  });

  it('applies every TAG_GRANTS remap row case-insensitively, on top of the passthrough', () => {
    for (const row of __registryRows.tagGrantRows) {
      const granted = entitlementsForTags([row.tag.toUpperCase()]);
      expect(granted.has(row.tag)).toBe(true); // 1:1 passthrough survives the remap
      for (const key of row.entitlements) {
        expect(granted.has(key)).toBe(true);
      }
    }
  });

  it('ignores empty/whitespace tags', () => {
    expect(entitlementsForTags(['', '   '])).toEqual(new Set());
  });
});

describe('entitlementsForPriceIds', () => {
  it('returns nothing for unknown price ids', () => {
    expect(entitlementsForPriceIds(['price_unknown'])).toEqual(new Set());
  });

  it('resolves every registered price row, deduplicating across rows', () => {
    for (const row of __registryRows.priceRows) {
      const granted = entitlementsForPriceIds([row.priceId, row.priceId]);
      expect(granted).toEqual(new Set(row.entitlements));
    }
  });
});

describe('entitlementsForEmail', () => {
  // Table-driven over the real domain-grant rows (no product literals - keeps
  // this file boundary-clean and auto-covers rows added later).
  const grantRow = __registryRows.domainGrantRows[0];
  const grantDomain = grantRow?.domain;

  it('grants the domain row keys for a verified email in that domain', () => {
    for (const row of __registryRows.domainGrantRows) {
      expect(entitlementsForEmail(`person@${row.domain}`, true)).toEqual(new Set(row.entitlements));
    }
  });

  it('matches the domain case-insensitively (local part and domain casing ignored)', () => {
    if (!grantRow) return;
    expect(entitlementsForEmail(`Person.Name@${grantDomain!.toUpperCase()}`, true)).toEqual(
      new Set(grantRow.entitlements)
    );
  });

  it('grants nothing when the email is not verified', () => {
    if (!grantRow) return;
    expect(entitlementsForEmail(`person@${grantDomain}`, false)).toEqual(new Set());
    expect(entitlementsForEmail(`person@${grantDomain}`, null)).toEqual(new Set());
    expect(entitlementsForEmail(`person@${grantDomain}`, undefined)).toEqual(new Set());
  });

  it('grants nothing for a domain with no grant row, even when verified', () => {
    expect(entitlementsForEmail('person@example.com', true)).toEqual(new Set());
  });

  it('grants nothing for a missing, empty, or malformed email', () => {
    expect(entitlementsForEmail(null, true)).toEqual(new Set());
    expect(entitlementsForEmail(undefined, true)).toEqual(new Set());
    expect(entitlementsForEmail('', true)).toEqual(new Set());
    expect(entitlementsForEmail('no-at-sign', true)).toEqual(new Set());
    expect(entitlementsForEmail('trailing@', true)).toEqual(new Set());
  });

  it('matches the domain after the LAST @ (sub-addressing / quirky locals)', () => {
    if (!grantRow) return;
    expect(entitlementsForEmail(`weird@local@${grantDomain}`, true)).toEqual(new Set(grantRow.entitlements));
  });
});

describe('signupCreditsForEmail', () => {
  // Expected credit for a domain = SUM of the signup-credit amount for each key
  // the domain confers. Derived from the real rows (no product literals) so this
  // auto-covers domains/products added later.
  const creditForKey = new Map(__registryRows.signupCreditRows.map(r => [normalizeTag(r.key), r.credits]));
  const expectedForRow = (row: { entitlements: string[] }) =>
    row.entitlements.reduce((sum, key) => sum + (creditForKey.get(normalizeTag(key)) ?? 0), 0);

  it('sums the signup-credit amount over every entitlement a verified domain email confers (no cap)', () => {
    for (const row of __registryRows.domainGrantRows) {
      expect(signupCreditsForEmail(`person@${row.domain}`, true)).toBe(expectedForRow(row));
    }
  });

  it('grants a two-product domain the sum of both keys (additive, uncapped)', () => {
    const twoProduct = __registryRows.domainGrantRows.find(r => r.entitlements.length >= 2);
    if (!twoProduct) return;
    const expected = expectedForRow(twoProduct);
    // Two-product domains sum strictly more than any single key contributes.
    expect(expected).toBeGreaterThan(
      Math.max(...twoProduct.entitlements.map(k => creditForKey.get(normalizeTag(k)) ?? 0))
    );
    expect(signupCreditsForEmail(`person@${twoProduct.domain}`, true)).toBe(expected);
  });

  it('matches the domain case-insensitively', () => {
    const row = __registryRows.domainGrantRows[0];
    if (!row) return;
    expect(signupCreditsForEmail(`Person@${row.domain.toUpperCase()}`, true)).toBe(expectedForRow(row));
  });

  it('grants nothing when the email is unverified', () => {
    const row = __registryRows.domainGrantRows[0];
    if (!row) return;
    expect(signupCreditsForEmail(`person@${row.domain}`, false)).toBe(0);
    expect(signupCreditsForEmail(`person@${row.domain}`, null)).toBe(0);
    expect(signupCreditsForEmail(`person@${row.domain}`, undefined)).toBe(0);
  });

  it('grants nothing for a non-domain-grant, missing, or malformed email', () => {
    expect(signupCreditsForEmail('person@example.com', true)).toBe(0);
    expect(signupCreditsForEmail(null, true)).toBe(0);
    expect(signupCreditsForEmail(undefined, true)).toBe(0);
    expect(signupCreditsForEmail('', true)).toBe(0);
    expect(signupCreditsForEmail('no-at-sign', true)).toBe(0);
  });
});

describe('resolveEntitlements', () => {
  it('unions tag-derived and price-derived keys without duplicates', () => {
    const keys = resolveEntitlements({ tags: ['Analyst', 'analyst'], activePriceIds: [] });
    expect(keys).toEqual(['analyst']);
  });

  it('unions verified-email-domain keys with tag- and price-derived keys', () => {
    const grantRow = __registryRows.domainGrantRows[0];
    if (!grantRow) return;
    const keys = resolveEntitlements({
      tags: ['Analyst'],
      activePriceIds: [],
      email: `person@${grantRow.domain}`,
      emailVerified: true,
    });
    expect(new Set(keys)).toEqual(new Set(['analyst', ...grantRow.entitlements]));
  });

  it('omits email-domain keys when the email is unverified', () => {
    const grantRow = __registryRows.domainGrantRows[0];
    if (!grantRow) return;
    expect(
      resolveEntitlements({ tags: [], activePriceIds: [], email: `person@${grantRow.domain}`, emailVerified: false })
    ).toEqual([]);
  });

  it('returns empty for a user with no tags, no subscriptions, and no email', () => {
    expect(resolveEntitlements({ tags: [], activePriceIds: [] })).toEqual([]);
  });
});
