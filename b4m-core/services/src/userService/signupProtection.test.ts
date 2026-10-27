import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PENDING_FREE_CREDITS_TAG } from '@bike4mind/common';
import type { SignupDomainReview, SignupObservation, SignupProtectionRepository } from '@bike4mind/common';
import { protectSignupCredits } from './signupProtection';
import { grantFreeCredits, releasePendingFreeCredits } from './freeCredits';
import * as creditService from '../creditService';

const buildFixture = () => {
  const observations = new Map<string, SignupObservation>();
  let review: SignupDomainReview | null = null;
  const repository: SignupProtectionRepository = {
    observe: vi.fn(async signup => {
      if (!observations.has(signup.userId)) observations.set(signup.userId, signup);
    }),
    recent: vi.fn(async () => [...observations.values()]),
    findReview: vi.fn(async () => review),
    createHold: vi.fn(async input => {
      if (review) return false;
      review = input;
      return true;
    }),
    isOrganizationDomain: vi.fn(async () => false),
  };
  const notifyHold = vi.fn();
  const findById = vi.fn();
  const findBySettingNames = vi.fn().mockResolvedValue([{ settingName: 'signupBurstAutoHold', settingValue: true }]);
  const db = {
    users: { findById, addTagsToUser: vi.fn() },
    adminSettings: { findBySettingName: vi.fn().mockResolvedValue(null), findBySettingNames },
    signupProtection: { repository, notifyHold },
    creditTransactions: { findOne: vi.fn().mockResolvedValue(null) },
  } as unknown as Parameters<typeof grantFreeCredits>[1]['db'];
  const user = (index: number, email = `person28aa0${index}@s${index}.example.net`) => {
    const result = { id: `u${index}`, email, emailVerifiedAt: new Date(), createdAt: new Date() };
    findById.mockResolvedValue(result);
    return result;
  };
  return {
    db,
    repository,
    user,
    notifyHold,
    findById,
    findBySettingNames,
    setReview: (value: SignupDomainReview | null) => {
      review = value;
    },
  };
};

beforeEach(() => vi.restoreAllMocks());
describe('signup protection and credit boundary', () => {
  it('holds the threshold signup once and preserves pending credits until an admin release', async () => {
    const fixture = buildFixture();
    for (const index of [1, 2, 3, 4]) {
      const user = fixture.user(index);
      expect(await protectSignupCredits(user.id, fixture.db)).toBe(false);
    }
    const user = fixture.user(5);
    const add = vi
      .spyOn(creditService, 'addCredits')
      .mockResolvedValue({ currentCredits: 25 } as Awaited<ReturnType<typeof creditService.addCredits>>);
    const adapters = { db: fixture.db, reason: 'test', logger: { error: vi.fn() } };
    const pending = { ...user, tags: [PENDING_FREE_CREDITS_TAG], pendingCreditGrant: 25 };
    expect(await releasePendingFreeCredits(pending, adapters)).toMatchObject({ released: false, patch: {} });
    expect(add).not.toHaveBeenCalled();
    expect(fixture.db.users.addTagsToUser).toHaveBeenCalledWith(user.id, [PENDING_FREE_CREDITS_TAG]);
    expect(fixture.notifyHold).toHaveBeenCalledTimes(1);
    expect(await protectSignupCredits(user.id, fixture.db)).toBe(true);
    expect(fixture.notifyHold).toHaveBeenCalledTimes(1);
    fixture.setReview({
      domain: 'example.net',
      status: 'released',
      reason: 'false positive',
      triggeredAt: new Date(),
      cohortUserIds: [],
      sampleEmails: [],
      signupCount: 5,
    });
    expect(await releasePendingFreeCredits(pending, adapters)).toMatchObject({ released: true, creditsGranted: 25 });
    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({ credits: 25, transactionId: 'verify-grant:u5' }),
      expect.objectContaining({ creditHolderMethods: fixture.db.users })
    );
  });
  it.each(['a@gmail.com', 'a@sub.outlook.com', 'a@system.example.net', 'a@yahoo.co.jp', 'a@qq.com', 'a@fastmail.com'])(
    'exempts %s',
    async email => {
      const fixture = buildFixture();
      fixture.findBySettingNames.mockResolvedValue([
        { settingName: 'signupBurstAutoHold', settingValue: true },
        { settingName: 'syntheticUserEmailDomains', settingValue: 'system.example.net' },
      ]);
      const user = fixture.user(1, email);
      expect(await protectSignupCredits(user.id, fixture.db)).toBe(false);
      expect(fixture.repository.observe).not.toHaveBeenCalled();
    }
  );
  it('exempts configured organization domains', async () => {
    const fixture = buildFixture();
    vi.mocked(fixture.repository.isOrganizationDomain).mockResolvedValue(true);
    const user = fixture.user(1);
    expect(await protectSignupCredits(user.id, fixture.db)).toBe(false);
    expect(fixture.repository.observe).not.toHaveBeenCalled();
  });
  it('does not treat backfills of old verified users as new signups', async () => {
    const fixture = buildFixture();
    const user = fixture.user(1);
    fixture.findById.mockResolvedValue({ ...user, emailVerifiedAt: new Date('2020-01-01') });
    expect(await protectSignupCredits(user.id, fixture.db)).toBe(false);
    expect(fixture.repository.observe).not.toHaveBeenCalled();
  });
  it('leaves blocked and disposable domains to the signup email gate', async () => {
    const fixture = buildFixture();
    fixture.findBySettingNames.mockResolvedValue([]);
    vi.mocked(fixture.db.adminSettings.findBySettingName).mockResolvedValue({
      settingName: 'blockedEmailDomains',
      settingValue: ['example.net'],
    } as never);
    const user = fixture.user(1);
    expect(await protectSignupCredits(user.id, fixture.db)).toBe(false);
    expect(fixture.db.adminSettings.findBySettingName).not.toHaveBeenCalled();
  });
  it('exempts regional public mailbox providers even when their domain has a hold', async () => {
    const fixture = buildFixture();
    fixture.setReview({
      domain: 'bk.ru',
      status: 'blocked',
      reason: 'abuse',
      triggeredAt: new Date(),
      cohortUserIds: [],
      sampleEmails: [],
      signupCount: 5,
    });
    const user = fixture.user(1, 'someone@bk.ru');
    expect(await protectSignupCredits(user.id, fixture.db)).toBe(false);
  });
  it('keeps existing holds enforced when automatic detection is off', async () => {
    const fixture = buildFixture();
    fixture.findBySettingNames.mockResolvedValue([]);
    fixture.setReview({
      domain: 'example.net',
      status: 'blocked',
      reason: 'abuse',
      triggeredAt: new Date(),
      cohortUserIds: [],
      sampleEmails: [],
      signupCount: 5,
    });
    const user = fixture.user(1);
    expect(await protectSignupCredits(user.id, fixture.db)).toBe(true);
  });
  it('honors a release after the initial hold lookup', async () => {
    const fixture = buildFixture();
    const review: SignupDomainReview = {
      domain: 'example.net',
      status: 'held_pending_review',
      reason: 'abuse',
      triggeredAt: new Date(),
      cohortUserIds: [],
      sampleEmails: [],
      signupCount: 5,
    };
    vi.mocked(fixture.repository.findReview)
      .mockResolvedValueOnce(review)
      .mockResolvedValueOnce({ ...review, status: 'released' });
    const user = fixture.user(1);
    expect(await protectSignupCredits(user.id, fixture.db)).toBe(false);
    expect(fixture.repository.findReview).toHaveBeenCalledTimes(2);
  });
  it('does not re-tag an already granted balance when its domain is held', async () => {
    const fixture = buildFixture();
    fixture.setReview({
      domain: 'example.net',
      status: 'blocked',
      reason: 'abuse',
      triggeredAt: new Date(),
      cohortUserIds: [],
      sampleEmails: [],
      signupCount: 5,
    });
    const user = fixture.user(1);
    vi.mocked(fixture.db.creditTransactions.findOne).mockResolvedValue({ transactionId: 'verify-grant:u1' } as Awaited<
      ReturnType<typeof fixture.db.creditTransactions.findOne>
    >);
    expect(await grantFreeCredits({ id: user.id }, { db: fixture.db, reason: 'test' })).toMatchObject({
      withheld: true,
    });
    expect(fixture.db.users.addTagsToUser).not.toHaveBeenCalled();
  });
  it('does not replay signup events or create unnotified holds during backfill', async () => {
    const fixture = buildFixture();
    fixture.db.signupProtection = { repository: fixture.repository, mode: 'enforce' };
    const user = fixture.user(1);
    expect(await protectSignupCredits(user.id, fixture.db)).toBe(false);
    expect(fixture.repository.observe).not.toHaveBeenCalled();
    expect(fixture.repository.createHold).not.toHaveBeenCalled();
    fixture.setReview({
      domain: 'example.net',
      status: 'held_pending_review',
      reason: 'abuse',
      triggeredAt: new Date(),
      cohortUserIds: [],
      sampleEmails: [],
      signupCount: 5,
    });
    expect(await protectSignupCredits(user.id, fixture.db)).toBe(true);
  });
  it('fails closed without clearing the pending breadcrumb on repository failure', async () => {
    const fixture = buildFixture();
    const user = fixture.user(1);
    vi.mocked(fixture.repository.findReview).mockRejectedValue(new Error('offline'));
    const logger = { error: vi.fn() };
    expect(
      await releasePendingFreeCredits(
        { ...user, tags: [PENDING_FREE_CREDITS_TAG] },
        { db: fixture.db, reason: 'test', logger }
      )
    ).toMatchObject({ released: false, patch: {} });
    expect(logger.error).toHaveBeenCalled();
  });
});
