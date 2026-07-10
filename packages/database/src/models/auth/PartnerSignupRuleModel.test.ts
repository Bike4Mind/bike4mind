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
