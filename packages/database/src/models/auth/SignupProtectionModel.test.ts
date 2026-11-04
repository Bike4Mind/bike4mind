import { beforeEach, describe, expect, it } from 'vitest';
import { setupMongoTest } from '../../__test__/utils';
import {
  signupDomainHoldListRepository,
  SignupDomainReviewModel,
  signupDomainReviewRepository,
  SignupObservationModel,
  signupProtectionRepository,
} from './SignupProtectionModel';
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
  it('lists only pending holds with the given reason, oldest first', async () => {
    await SignupDomainReviewModel.create([
      { ...hold, domain: 'newer.test', reason: 'disposable-aggregate', triggeredAt: new Date('2026-01-03') },
      { ...hold, domain: 'older.test', reason: 'disposable-aggregate', triggeredAt: new Date('2026-01-01') },
      { ...hold, domain: 'young.test', reason: 'young-domain (<30 days)' },
      { ...hold, domain: 'done.test', reason: 'disposable-aggregate', status: 'blocked' },
    ]);
    const pending = await signupDomainReviewRepository.listPending('disposable-aggregate', 10);
    expect(pending.map(review => review.domain)).toEqual(['older.test', 'newer.test']);
  });
  it('auto-confirms only a still-pending hold with the matching reason', async () => {
    const decidedAt = new Date('2026-02-01');
    await SignupDomainReviewModel.create([
      { ...hold, domain: 'rule.test', reason: 'disposable-aggregate' },
      { ...hold, domain: 'young.test', reason: 'young-domain (<30 days)' },
      { ...hold, domain: 'released.test', reason: 'disposable-aggregate', status: 'released', reviewedBy: 'admin-1' },
    ]);
    const confirm = (domain: string) =>
      signupDomainReviewRepository.autoConfirm(domain, 'disposable-aggregate', 'disposable-aggregate-rule', decidedAt);
    expect(await confirm('rule.test')).toBe(true);
    expect(await confirm('rule.test')).toBe(false);
    expect(await confirm('young.test')).toBe(false);
    expect(await confirm('released.test')).toBe(false);
    const confirmed = await signupProtectionRepository.findReview('rule.test');
    expect(confirmed).toMatchObject({
      status: 'blocked',
      reviewedAt: decidedAt,
      autoDecision: { policy: 'disposable-aggregate-rule', decidedAt },
    });
    expect(confirmed?.reviewedBy).toBeUndefined();
    expect((await signupProtectionRepository.findReview('young.test'))?.status).toBe('held_pending_review');
    expect(await signupProtectionRepository.findReview('released.test')).toMatchObject({
      status: 'released',
      reviewedBy: 'admin-1',
    });
  });
  it('lists pending young-domain holds that need an assessment, bounding failed retries', async () => {
    const policyVersion = 2;
    const retryBefore = new Date('2026-02-01T12:00:00Z');
    const judged = (version: number) => ({
      outcome: 'judged',
      policyVersion: version,
      judgment: 'legitimate',
      confidence: 0.8,
      model: 'gpt-6-luna',
      assessedAt: new Date('2026-02-01T00:00:00Z'),
    });
    const failed = (attempts: number, assessedAt: Date) => ({
      outcome: 'failed',
      policyVersion,
      failure: 'provider_error',
      attempts,
      model: 'gpt-6-luna',
      assessedAt,
    });
    const young = 'young-domain (<30 days)';
    await SignupDomainReviewModel.create([
      { ...hold, domain: 'fresh.test', reason: young, triggeredAt: new Date('2026-01-02') },
      {
        ...hold,
        domain: 'stale-version.test',
        reason: young,
        triggeredAt: new Date('2026-01-01'),
        assessment: judged(1),
      },
      { ...hold, domain: 'current.test', reason: young, assessment: judged(policyVersion) },
      {
        ...hold,
        domain: 'retry.test',
        reason: young,
        triggeredAt: new Date('2026-01-03'),
        assessment: failed(1, new Date('2026-02-01T11:00:00Z')),
      },
      { ...hold, domain: 'too-soon.test', reason: young, assessment: failed(1, new Date('2026-02-01T12:30:00Z')) },
      { ...hold, domain: 'exhausted.test', reason: young, assessment: failed(3, new Date('2026-01-01')) },
      { ...hold, domain: 'decided.test', reason: young, status: 'blocked' },
      { ...hold, domain: 'other.test', reason: 'disposable-aggregate' },
      { ...hold, domain: 'infix.test', reason: 'pattern young-domain' },
    ]);
    const listed = await signupDomainReviewRepository.listPendingForAssessment(
      'young-domain',
      { policyVersion, maxAttempts: 3, retryBefore },
      10
    );
    expect(listed.map(review => review.domain)).toEqual(['stale-version.test', 'fresh.test', 'retry.test']);
  });
  it('records an assessment only on a still-pending hold, replacing the previous one', async () => {
    await SignupDomainReviewModel.create([
      { ...hold, domain: 'pending.test', reason: 'young-domain (<30 days)' },
      { ...hold, domain: 'released.test', reason: 'young-domain (<30 days)', status: 'released' },
    ]);
    const assessedAt = new Date('2026-02-01');
    expect(
      await signupDomainReviewRepository.recordAssessment('pending.test', {
        outcome: 'failed',
        policyVersion: 1,
        failure: 'provider_error',
        attempts: 1,
        model: 'gpt-6-luna',
        assessedAt,
      })
    ).toBe(true);
    const verdict = {
      outcome: 'judged',
      policyVersion: 1,
      judgment: 'abuse',
      confidence: 0.95,
      model: 'gpt-6-luna',
      assessedAt,
    } as const;
    expect(await signupDomainReviewRepository.recordAssessment('pending.test', verdict)).toBe(true);
    expect(await signupDomainReviewRepository.recordAssessment('released.test', verdict)).toBe(false);
    const stored = await signupProtectionRepository.findReview('pending.test');
    expect(stored?.assessment).toEqual(verdict);
    expect(stored?.status).toBe('held_pending_review');
    expect((await signupProtectionRepository.findReview('released.test'))?.assessment).toBeUndefined();
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

  describe('admin hold list', () => {
    const window = new Date('2026-03-01');
    const seed = () =>
      SignupDomainReviewModel.create([
        { ...hold, domain: 'pending-old.test', triggeredAt: new Date('2025-01-01') },
        {
          ...hold,
          domain: 'pending-young.test',
          reason: 'young-domain (<30 days)',
          triggeredAt: new Date('2026-03-05'),
        },
        { ...hold, domain: 'blocked-new.test', status: 'blocked', reviewedAt: new Date('2026-03-10') },
        { ...hold, domain: 'blocked-old.test', status: 'blocked', reviewedAt: new Date('2025-06-01') },
        { ...hold, domain: 'released-new.test', status: 'released', reviewedAt: new Date('2026-03-02') },
        { ...hold, domain: 'released-old.test', status: 'released', reviewedAt: new Date('2025-06-01') },
        // No reviewedAt on a legacy settled row: its trigger time decides.
        { ...hold, domain: 'legacy-old.test', status: 'blocked', triggeredAt: new Date('2025-01-01') },
      ]);
    const domains = async (filter: Parameters<typeof signupDomainHoldListRepository.list>[0]) =>
      (await signupDomainHoldListRepository.list(filter, 1, 25)).map(review => review.domain).sort();

    it('filters by status and keeps every pending hold regardless of age', async () => {
      await seed();
      expect(await domains({ status: 'pending', settledSince: window })).toEqual([
        'pending-old.test',
        'pending-young.test',
      ]);
      expect(await domains({ status: 'blocked', settledSince: window })).toEqual(['blocked-new.test']);
      expect(await domains({ status: 'released', settledSince: window })).toEqual(['released-new.test']);
    });

    it('hides settled holds decided before the window but never deletes them', async () => {
      await seed();
      expect(await domains({ status: 'all', settledSince: window })).toEqual([
        'blocked-new.test',
        'pending-old.test',
        'pending-young.test',
        'released-new.test',
      ]);
      expect(await domains({ status: 'all' })).toHaveLength(7);
      expect(await domains({ status: 'blocked' })).toEqual(['blocked-new.test', 'blocked-old.test', 'legacy-old.test']);
      expect(await SignupDomainReviewModel.countDocuments()).toBe(7);
    });

    it('narrows by reason family and counts each status view under the same filter', async () => {
      await seed();
      expect(await domains({ status: 'all', reason: 'young-domain' })).toEqual(['pending-young.test']);
      expect(await signupDomainHoldListRepository.countByStatus({ settledSince: window })).toEqual({
        pending: 2,
        blocked: 1,
        released: 1,
        all: 4,
      });
      expect(await signupDomainHoldListRepository.countByStatus({ reason: 'young-domain' })).toEqual({
        pending: 1,
        blocked: 0,
        released: 0,
        all: 1,
      });
    });

    it('pages newest first', async () => {
      await seed();
      const first = await signupDomainHoldListRepository.list({ status: 'all' }, 1, 2);
      const second = await signupDomainHoldListRepository.list({ status: 'all' }, 2, 2);
      const times = [...first, ...second].map(review => new Date(review.triggeredAt).getTime());
      expect(times).toEqual([...times].sort((a, b) => b - a));
      expect(new Set([...first, ...second].map(review => review.domain)).size).toBe(4);
    });
  });

  describe('young-domain age recheck', () => {
    const young = 'young-domain (<30 days)';
    const now = new Date('2026-03-01');
    const retryBefore = new Date('2026-02-28');

    it('lists pending young-domain holds with no known registration date, retrying a failed lookup later', async () => {
      await SignupDomainReviewModel.create([
        { ...hold, domain: 'fresh.test', reason: young },
        { ...hold, domain: 'retry.test', reason: young, domainAgeCheckedAt: new Date('2026-02-01') },
        { ...hold, domain: 'recent-try.test', reason: young, domainAgeCheckedAt: new Date('2026-02-28T12:00:00Z') },
        { ...hold, domain: 'known.test', reason: young, domainRegisteredAt: new Date('2026-02-10') },
        { ...hold, domain: 'decided.test', reason: young, status: 'blocked' },
        { ...hold, domain: 'other.test', reason: 'disposable-aggregate' },
      ]);
      const listed = await signupDomainReviewRepository.listForAgeRecheck(retryBefore, 10);
      expect(listed.map(review => review.domain).sort()).toEqual(['fresh.test', 'retry.test']);
    });

    it('records a lookup only on a still-pending hold', async () => {
      await SignupDomainReviewModel.create([
        { ...hold, domain: 'fresh.test', reason: young },
        { ...hold, domain: 'decided.test', reason: young, status: 'released' },
      ]);
      const registeredAt = new Date('2026-01-01');
      expect(await signupDomainReviewRepository.recordDomainAgeCheck('fresh.test', now, registeredAt)).toBe(true);
      expect(await signupDomainReviewRepository.recordDomainAgeCheck('decided.test', now, registeredAt)).toBe(false);
      const stored = await SignupDomainReviewModel.findOne({ domain: 'fresh.test' }).lean();
      expect(stored?.domainRegisteredAt).toEqual(registeredAt);
      expect(stored?.domainAgeCheckedAt).toEqual(now);
      expect((await SignupDomainReviewModel.findOne({ domain: 'decided.test' }).lean())?.domainAgeCheckedAt).toBe(
        undefined
      );
    });

    it('marks only pending young-domain holds registered before the cutoff, and never changes a status', async () => {
      const cutoff = new Date('2026-01-30');
      await SignupDomainReviewModel.create([
        { ...hold, domain: 'aged.test', reason: young, domainRegisteredAt: new Date('2026-01-01') },
        { ...hold, domain: 'still-young.test', reason: young, domainRegisteredAt: new Date('2026-02-20') },
        { ...hold, domain: 'unknown.test', reason: young },
        {
          ...hold,
          domain: 'blocked.test',
          reason: young,
          status: 'blocked',
          domainRegisteredAt: new Date('2026-01-01'),
        },
        { ...hold, domain: 'other.test', reason: 'pattern', domainRegisteredAt: new Date('2026-01-01') },
      ]);
      expect(await signupDomainReviewRepository.markAgedDomains(cutoff, now)).toBe(1);
      expect(await signupDomainReviewRepository.markAgedDomains(cutoff, now)).toBe(0);
      const rows = await SignupDomainReviewModel.find().lean();
      const byDomain = Object.fromEntries(rows.map(row => [row.domain, row]));
      expect(byDomain['aged.test'].domainAgedAt).toEqual(now);
      expect(byDomain['aged.test'].status).toBe('held_pending_review');
      for (const domain of ['still-young.test', 'unknown.test', 'blocked.test', 'other.test'])
        expect(byDomain[domain].domainAgedAt).toBeUndefined();
      expect(byDomain['blocked.test'].status).toBe('blocked');
    });
  });
});
