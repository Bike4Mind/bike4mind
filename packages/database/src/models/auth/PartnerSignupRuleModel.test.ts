import { describe, it, expect, beforeEach } from 'vitest';
import { PartnerSignupRule, partnerSignupRuleRepository } from './PartnerSignupRuleModel';
import { setupMongoTest } from '../../__test__/utils';

describe('PartnerSignupRuleModel', () => {
  setupMongoTest();

  beforeEach(async () => {
    await PartnerSignupRule.deleteMany({});
    await PartnerSignupRule.ensureIndexes();
  });

  it('normalizes the domain on write (trim + lowercase)', async () => {
    const created = await partnerSignupRuleRepository.create({
      domain: '  PARTNER.com ',
      entitlements: ['optihashi:pro'],
      signupCredits: 150_000,
      enabled: true,
    });

    expect(created.domain).toBe('partner.com');
  });

  it('findByDomain returns null for an unknown domain', async () => {
    expect(await partnerSignupRuleRepository.findByDomain('missing.com')).toBeNull();
  });

  it('findByDomain matches case-insensitively and ignores whitespace', async () => {
    await partnerSignupRuleRepository.create({
      domain: 'partner.com',
      entitlements: ['optihashi:pro'],
      signupCredits: 150_000,
      enabled: true,
    });

    const found = await partnerSignupRuleRepository.findByDomain('  Partner.COM ');
    expect(found).toBeTruthy();
    expect(found?.signupCredits).toBe(150_000);
  });

  it('defaults tags to an empty list and stores them case-preserved', async () => {
    const untagged = await partnerSignupRuleRepository.create({
      domain: 'untagged.com',
      entitlements: [],
      signupCredits: 0,
      enabled: true,
    });
    const tagged = await partnerSignupRuleRepository.create({
      domain: 'tagged.com',
      entitlements: [],
      signupCredits: 0,
      tags: ['Partner', 'cohort-a'],
      enabled: true,
    });

    expect(untagged.tags).toEqual([]);
    expect(tagged.tags).toEqual(['Partner', 'cohort-a']);
  });

  it('round-trips the subscription and defaults it to null', async () => {
    const plain = await partnerSignupRuleRepository.create({
      domain: 'plain.com',
      entitlements: [],
      signupCredits: 0,
      enabled: true,
    });
    await partnerSignupRuleRepository.create({
      domain: 'subscribed.com',
      entitlements: [],
      signupCredits: 0,
      subscription: { priceId: 'price_pro', durationMonths: 3 },
      enabled: true,
    });

    expect(plain.subscription ?? null).toBeNull();
    const found = await partnerSignupRuleRepository.findByDomain('subscribed.com');
    expect(found?.subscription).toEqual({ priceId: 'price_pro', durationMonths: 3 });
  });

  it('enforces a unique domain', async () => {
    await partnerSignupRuleRepository.create({
      domain: 'partner.com',
      entitlements: [],
      signupCredits: 0,
      enabled: true,
    });

    await expect(
      partnerSignupRuleRepository.create({
        domain: 'partner.com',
        entitlements: [],
        signupCredits: 0,
        enabled: true,
      } as any)
    ).rejects.toThrow();
  });

  it('findActiveRules returns only enabled, non-deleted rules', async () => {
    await partnerSignupRuleRepository.create({
      domain: 'enabled.com',
      entitlements: ['optihashi:pro'],
      signupCredits: 100,
      enabled: true,
    });
    await partnerSignupRuleRepository.create({
      domain: 'disabled.com',
      entitlements: ['optihashi:pro'],
      signupCredits: 100,
      enabled: false,
    });

    const active = await partnerSignupRuleRepository.findActiveRules();
    expect(active.map(r => r.domain).sort()).toEqual(['enabled.com']);
  });

  it('listRules paginates and searches by domain', async () => {
    await partnerSignupRuleRepository.create({
      domain: 'alpha.com',
      entitlements: [],
      signupCredits: 0,
      enabled: true,
    });
    await partnerSignupRuleRepository.create({
      domain: 'beta.com',
      entitlements: [],
      signupCredits: 0,
      enabled: true,
    });

    const all = await partnerSignupRuleRepository.listRules({ page: 1, limit: 10 });
    expect(all.meta.total).toBe(2);

    const filtered = await partnerSignupRuleRepository.listRules({ page: 1, limit: 10, search: 'alpha' });
    expect(filtered.meta.total).toBe(1);
    expect(filtered.data[0].domain).toBe('alpha.com');
  });
});

describe('PartnerSignupRuleRepository.countByGrantPackage', () => {
  setupMongoTest();

  beforeEach(async () => {
    await PartnerSignupRule.deleteMany({});
  });

  const rule = (domain: string, grantPackageId: string | null, enabled = true) =>
    partnerSignupRuleRepository.create({ domain, entitlements: [], signupCredits: 0, enabled, grantPackageId });

  it('counts linked domains and the enabled ones per package', async () => {
    await rule('a1.com', 'a');
    await rule('a2.com', 'a', false);
    await rule('b1.com', 'b');
    await rule('none.com', null);

    const counts = await partnerSignupRuleRepository.countByGrantPackage(['a', 'b', 'missing']);

    expect(counts.get('a')).toEqual({ domains: 2, enabledDomains: 1 });
    expect(counts.get('b')).toEqual({ domains: 1, enabledDomains: 1 });
    expect(counts.has('missing')).toBe(false);
  });

  it('returns an empty map for no ids', async () => {
    await rule('a1.com', 'a');
    expect((await partnerSignupRuleRepository.countByGrantPackage([])).size).toBe(0);
  });
});

describe('PartnerSignupRuleRepository.listByGrantPackage', () => {
  setupMongoTest();

  beforeEach(async () => {
    await PartnerSignupRule.deleteMany({});
  });

  const rule = (domain: string, grantPackageId: string | null) =>
    partnerSignupRuleRepository.create({ domain, entitlements: [], signupCredits: 0, enabled: true, grantPackageId });

  it('lists only the package rules, newest first, and flags more past the limit', async () => {
    await rule('old.com', 'a');
    await rule('mid.com', 'a');
    await rule('new.com', 'a');
    await rule('other.com', 'b');

    const page = await partnerSignupRuleRepository.listByGrantPackage('a', 2);
    expect(page.data.map(r => r.domain)).toEqual(['new.com', 'mid.com']);
    expect(page.truncated).toBe(true);

    const all = await partnerSignupRuleRepository.listByGrantPackage('a', 3);
    expect(all.data).toHaveLength(3);
    expect(all.truncated).toBe(false);
  });
});
