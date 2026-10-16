import { describe, it, expect } from 'vitest';
import {
  createPartnerSignupRuleSchema,
  updatePartnerSignupRuleSchema,
  normalizeSignupRuleDomain,
} from './partnerSignupRule';

describe('createPartnerSignupRuleSchema', () => {
  const base = { domain: 'partner.com', entitlements: ['optihashi:pro'], signupCredits: 150_000 };

  it('accepts a valid rule and defaults enabled to true', () => {
    const parsed = createPartnerSignupRuleSchema.parse(base);
    expect(parsed.enabled).toBe(true);
    expect(parsed.domain).toBe('partner.com');
    expect(parsed.entitlements).toEqual(['optihashi:pro']);
  });

  it('trims tags, keeps their case, and drops duplicates', () => {
    const parsed = createPartnerSignupRuleSchema.parse({ ...base, tags: [' Partner ', 'Partner', 'cohort-a'] });
    expect(parsed.tags).toEqual(['Partner', 'cohort-a']);
  });

  it('leaves tags undefined when omitted', () => {
    expect(createPartnerSignupRuleSchema.parse(base).tags).toBeUndefined();
  });

  it('rejects an empty tag and more than 20 tags', () => {
    expect(() => createPartnerSignupRuleSchema.parse({ ...base, tags: ['  '] })).toThrow();
    const tooMany = Array.from({ length: 21 }, (_, i) => `tag-${i}`);
    expect(() => createPartnerSignupRuleSchema.parse({ ...base, tags: tooMany })).toThrow();
  });

  it('rejects the system-managed pending-free-credits tag', () => {
    expect(() => createPartnerSignupRuleSchema.parse({ ...base, tags: ['pending-free-credits'] })).toThrow(/reserved/);
  });

  it('accepts a subscription, trimming the price id', () => {
    const parsed = createPartnerSignupRuleSchema.parse({
      ...base,
      subscription: { priceId: ' price_pro ', durationMonths: 12 },
    });
    expect(parsed.subscription).toEqual({ priceId: 'price_pro', durationMonths: 12 });
  });

  it('rejects subscription months outside 1..12 or fractional, and an empty price id', () => {
    for (const durationMonths of [0, 13, 1.5]) {
      expect(() =>
        createPartnerSignupRuleSchema.parse({ ...base, subscription: { priceId: 'price_pro', durationMonths } })
      ).toThrow();
    }
    expect(() =>
      createPartnerSignupRuleSchema.parse({ ...base, subscription: { priceId: '  ', durationMonths: 1 } })
    ).toThrow();
  });

  it('rejects developer tags', () => {
    for (const tag of ['Developer', 'dev', 'developers']) {
      expect(() => createPartnerSignupRuleSchema.parse({ ...base, tags: [tag] })).toThrow(/reserved/);
    }
    expect(() => updatePartnerSignupRuleSchema.parse({ tags: ['Dev'] })).toThrow(/reserved/);
  });

  it('normalizes domain and entitlement keys to lowercase', () => {
    const parsed = createPartnerSignupRuleSchema.parse({
      ...base,
      domain: '  PARTNER.com ',
      entitlements: ['OptiHashi:Pro'],
    });
    expect(parsed.domain).toBe('partner.com');
    expect(parsed.entitlements).toEqual(['optihashi:pro']);
  });

  it('accepts multi-label domains', () => {
    expect(createPartnerSignupRuleSchema.parse({ ...base, domain: 'sub.partner.co.uk' }).domain).toBe(
      'sub.partner.co.uk'
    );
  });

  it.each([
    ['a full email', 'user@partner.com'],
    ['a bare word (no TLD)', 'partner'],
    ['a path', 'partner.com/signup'],
    ['a leading hyphen', '-partner.com'],
    ['a trailing dot', 'partner.com.'],
    ['a trailing-hyphen label', 'partner-.com'],
  ])('rejects %s', (_label, domain) => {
    expect(createPartnerSignupRuleSchema.safeParse({ ...base, domain }).success).toBe(false);
  });

  it('rejects public mail providers', () => {
    for (const domain of ['gmail.com', 'outlook.com', 'proton.me']) {
      expect(createPartnerSignupRuleSchema.safeParse({ ...base, domain }).success).toBe(false);
    }
  });

  it('rejects negative or non-integer signup credits', () => {
    expect(createPartnerSignupRuleSchema.safeParse({ ...base, signupCredits: -1 }).success).toBe(false);
    expect(createPartnerSignupRuleSchema.safeParse({ ...base, signupCredits: 1.5 }).success).toBe(false);
  });

  it('allows a credits-only rule with no entitlements', () => {
    expect(createPartnerSignupRuleSchema.safeParse({ ...base, entitlements: [] }).success).toBe(true);
  });

  it('accepts a 24-char hex organizationId and allows null to clear it', () => {
    expect(createPartnerSignupRuleSchema.safeParse({ ...base, organizationId: 'a'.repeat(24) }).success).toBe(true);
    expect(createPartnerSignupRuleSchema.safeParse({ ...base, organizationId: null }).success).toBe(true);
  });

  it('rejects a malformed organizationId', () => {
    expect(createPartnerSignupRuleSchema.safeParse({ ...base, organizationId: 'not-an-id' }).success).toBe(false);
    expect(createPartnerSignupRuleSchema.safeParse({ ...base, organizationId: 'z'.repeat(24) }).success).toBe(false);
  });
});

describe('updatePartnerSignupRuleSchema', () => {
  it('allows a partial update of a single field', () => {
    const parsed = updatePartnerSignupRuleSchema.parse({ enabled: false });
    expect(parsed).toEqual({ enabled: false });
  });

  it('does NOT default enabled when omitted (an omitted field is a true no-op)', () => {
    const parsed = updatePartnerSignupRuleSchema.parse({ signupCredits: 5 });
    expect('enabled' in parsed).toBe(false);
  });

  it('rejects domain (immutable key) via strict()', () => {
    expect(updatePartnerSignupRuleSchema.safeParse({ domain: 'other.com' }).success).toBe(false);
  });

  it('rejects unknown keys via strict()', () => {
    expect(updatePartnerSignupRuleSchema.safeParse({ bogus: true }).success).toBe(false);
  });
});

describe('normalizeSignupRuleDomain', () => {
  it('trims and lowercases', () => {
    expect(normalizeSignupRuleDomain('  Partner.COM ')).toBe('partner.com');
  });
});

describe('updatePartnerSignupRuleSchema subscription', () => {
  it('accepts null to clear the subscription and leaves it undefined when omitted', () => {
    expect(updatePartnerSignupRuleSchema.parse({ subscription: null }).subscription).toBeNull();
    expect(updatePartnerSignupRuleSchema.parse({}).subscription).toBeUndefined();
  });

  it('validates a provided subscription', () => {
    expect(
      updatePartnerSignupRuleSchema.parse({ subscription: { priceId: 'price_pro', durationMonths: 6 } }).subscription
    ).toEqual({ priceId: 'price_pro', durationMonths: 6 });
    expect(() =>
      updatePartnerSignupRuleSchema.parse({ subscription: { priceId: 'price_pro', durationMonths: 13 } })
    ).toThrow();
  });
});
