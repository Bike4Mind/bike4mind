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
