import { beforeEach, describe, expect, it } from 'vitest';
import { setupMongoTest } from '../../__test__/utils';
import { SignupDomainReviewModel, SignupObservationModel, signupProtectionRepository } from './SignupProtectionModel';
import { PartnerSignupRule } from './PartnerSignupRuleModel';
import type { SignupDomainReview } from '@bike4mind/common';

const hold: SignupDomainReview = {
  domain: 'example.net',
  status: 'held_pending_review',
  reason: 'pattern',
  triggeredAt: new Date(),
  cohortUserIds: ['user-1'],
  sampleEmails: ['person28aa01@x.example.net'],
  signupCount: 5,
};

describe('signup protection persistence', () => {
  setupMongoTest();
  beforeEach(async () => {
    await Promise.all([
      SignupDomainReviewModel.deleteMany({}),
      SignupObservationModel.deleteMany({}),
      PartnerSignupRule.deleteMany({}),
    ]);
    await Promise.all([SignupDomainReviewModel.ensureIndexes(), SignupObservationModel.ensureIndexes()]);
  });
  it('creates one durable hold under concurrent detection and does not re-hold after release', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => signupProtectionRepository.createHold(hold)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await SignupDomainReviewModel.countDocuments()).toBe(1);
    await SignupDomainReviewModel.updateOne({ domain: hold.domain }, { $set: { status: 'released' } });
    expect(await signupProtectionRepository.createHold(hold)).toBe(false);
    expect((await signupProtectionRepository.findReview(hold.domain))?.status).toBe('released');
  });
  it('deduplicates observations by user and preserves the first verification timestamp', async () => {
    const first = {
      userId: 'user-1',
      email: 'a@example.net',
      domain: 'example.net',
      verifiedAt: new Date('2026-01-01'),
    };
    await Promise.all(Array.from({ length: 5 }, () => signupProtectionRepository.observe(first)));
    await signupProtectionRepository.observe({ ...first, verifiedAt: new Date('2026-01-02') });
    const recent = await signupProtectionRepository.recent('example.net', new Date('2025-12-31'));
    expect(recent).toHaveLength(1);
    expect(recent[0].verifiedAt).toEqual(first.verifiedAt);
    expect(await signupProtectionRepository.recent('example.org', new Date('2025-12-31'))).toEqual([]);
  });
  it('keeps the newest observations when a domain exceeds the sample cap', async () => {
    const start = Date.now() - 2000;
    await SignupObservationModel.insertMany(
      Array.from({ length: 1005 }, (_, index) => ({
        userId: `user-${index}`,
        email: `person${index}@example.net`,
        domain: 'example.net',
        verifiedAt: new Date(start + index),
      }))
    );
    const recent = await signupProtectionRepository.recent('example.net', new Date(start - 1));
    expect(recent).toHaveLength(1000);
    expect(recent[0].userId).toBe('user-1004');
    expect(recent[999].userId).toBe('user-5');
  });
  it('exempts only enabled signup rules with an organization and matches subdomains', async () => {
    await PartnerSignupRule.create({ domain: 'example.net', enabled: true, organizationId: 'organization-1' });
    expect(await signupProtectionRepository.isOrganizationDomain('a@sub.example.net')).toBe(true);
    expect(await signupProtectionRepository.isOrganizationDomain('a@otherexample.net')).toBe(false);
    await PartnerSignupRule.updateOne({ domain: 'example.net' }, { $set: { enabled: false } });
    expect(await signupProtectionRepository.isOrganizationDomain('a@example.net')).toBe(false);
  });
});
