import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PENDING_FREE_CREDITS_TAG } from '@bike4mind/common';
import type {
  SignupDomainReview,
  SignupObservation,
  SignupProtection,
  SignupProtectionRepository,
} from '@bike4mind/common';
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

describe('domain intelligence holds', () => {
  const withLists = (sources: Record<string, ('aggregate' | 'curated' | 'fakefilter')[]>) => {
    const fixture = buildFixture();
    fixture.findBySettingNames.mockResolvedValue([]);
    Object.assign(fixture.repository, {
      disposableSources: vi.fn(async (domains: string[]) => domains.flatMap(domain => sources[domain] ?? [])),
    });
    return fixture;
  };

  it('holds an aggregate-only domain with burst auto-hold off and notifies once', async () => {
    const fixture = withLists({ 'example-burner.test': ['aggregate'] });
    const user = fixture.user(1, 'person@x1.example-burner.test');
    expect(await protectSignupCredits(user.id, fixture.db)).toBe(true);
    expect(fixture.repository.createHold).toHaveBeenCalledWith(
      expect.objectContaining({
        domain: 'example-burner.test',
        reason: 'disposable-aggregate',
        cohortUserIds: [user.id],
        signupCount: 1,
      })
    );
    expect(fixture.notifyHold).toHaveBeenCalledTimes(1);
    expect(fixture.repository.observe).not.toHaveBeenCalled();
  });

  it('creates no domain-intelligence hold in enforce mode or with the toggle off', async () => {
    const enforce = withLists({ 'example-burner.test': ['aggregate'] });
    (enforce.db as unknown as { signupProtection: { mode: string } }).signupProtection.mode = 'enforce';
    expect(await protectSignupCredits(enforce.user(1, 'a@example-burner.test').id, enforce.db)).toBe(false);
    expect(enforce.repository.createHold).not.toHaveBeenCalled();

    const off = withLists({ 'example-burner.test': ['aggregate'] });
    off.findBySettingNames.mockResolvedValue([{ settingName: 'enableDomainIntelligence', settingValue: false }]);
    expect(await protectSignupCredits(off.user(1, 'a@example-burner.test').id, off.db)).toBe(false);
    expect(off.repository.createHold).not.toHaveBeenCalled();
  });

  it('never flags mainstream or internal staff domains even if a list carries them', async () => {
    vi.stubEnv('NEXT_PUBLIC_INTERNAL_STAFF_DOMAINS', 'staff.example.org');
    try {
      for (const email of ['a@gmail.com', 'a@list.ru', 'a@staff.example.org']) {
        const fixture = withLists({ [email.split('@')[1]]: ['aggregate'] });
        expect(await protectSignupCredits(fixture.user(1, email).id, fixture.db)).toBe(false);
        expect(fixture.repository.disposableSources).not.toHaveBeenCalled();
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('skips the domain checks for an existing review or a signup outside the window', async () => {
    const reviewed = withLists({ 'example-burner.test': ['aggregate'] });
    reviewed.setReview({ domain: 'example-burner.test', status: 'released' } as SignupDomainReview);
    expect(await protectSignupCredits(reviewed.user(1, 'a@example-burner.test').id, reviewed.db)).toBe(false);
    expect(reviewed.repository.disposableSources).not.toHaveBeenCalled();

    const stale = withLists({ 'example-burner.test': ['aggregate'] });
    const user = stale.user(1, 'a@example-burner.test');
    stale.findById.mockResolvedValue({ ...user, emailVerifiedAt: new Date('2020-01-01') });
    expect(await protectSignupCredits(user.id, stale.db)).toBe(false);
    expect(stale.repository.disposableSources).not.toHaveBeenCalled();
  });

  it('fails open when the list read throws', async () => {
    const fixture = withLists({});
    vi.mocked(fixture.repository.disposableSources!).mockRejectedValue(new Error('db down'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await protectSignupCredits(fixture.user(1, 'a@any.test').id, fixture.db)).toBe(false);
  });
});

describe('domains the advisory assessment auto-released', () => {
  const released = (autoDecision?: SignupDomainReview['autoDecision']): SignupDomainReview => ({
    domain: 'example.net',
    status: 'released',
    reason: 'young-domain (<30 days)',
    triggeredAt: new Date(),
    cohortUserIds: [],
    sampleEmails: [],
    signupCount: 1,
    ...(autoDecision ? { autoDecision } : {}),
  });
  const watchedFixture = (review: SignupDomainReview) => {
    const fixture = buildFixture();
    let current: SignupDomainReview | null = review;
    fixture.repository.findReview = vi.fn(async () => current);
    fixture.repository.reholdWatched = vi.fn(async input => {
      if (current?.status !== 'released' || current.autoDecision?.policy !== 'advisory-decision') return false;
      current = input;
      return true;
    });
    // Burst auto-hold off: the watch must not depend on it.
    fixture.findBySettingNames.mockResolvedValue([]);
    return fixture;
  };

  it('pays a quiet signup on an auto-released domain', async () => {
    const fixture = watchedFixture(released({ policy: 'advisory-decision', decidedAt: new Date() }));
    const user = fixture.user(1);
    expect(await protectSignupCredits(user.id, fixture.db)).toBe(false);
    expect(fixture.repository.reholdWatched).not.toHaveBeenCalled();
  });

  it('re-holds an auto-released domain on a signup burst, even with burst auto-hold off', async () => {
    const fixture = watchedFixture(released({ policy: 'advisory-decision', decidedAt: new Date() }));
    for (const index of [1, 2, 3, 4])
      expect(await protectSignupCredits(fixture.user(index).id, fixture.db)).toBe(false);
    const user = fixture.user(5);
    expect(await protectSignupCredits(user.id, fixture.db)).toBe(true);
    expect(fixture.repository.reholdWatched).toHaveBeenCalledWith(
      expect.objectContaining({ domain: 'example.net', status: 'held_pending_review', signupCount: 5 })
    );
    expect(fixture.notifyHold).toHaveBeenCalledTimes(1);
  });

  it('re-holds an auto-released domain that still trips a domain-intel hold, instead of paying', async () => {
    const fixture = watchedFixture(released({ policy: 'advisory-decision', decidedAt: new Date() }));
    Object.assign(fixture.repository, { disposableSources: vi.fn(async () => ['aggregate']) });
    const user = fixture.user(1);
    expect(await protectSignupCredits(user.id, fixture.db)).toBe(true);
    expect(fixture.repository.reholdWatched).toHaveBeenCalledWith(
      expect.objectContaining({ domain: 'example.net', status: 'held_pending_review', cohortUserIds: [user.id] })
    );
    expect(fixture.repository.createHold).not.toHaveBeenCalled();
    expect(fixture.notifyHold).toHaveBeenCalledTimes(1);
  });

  it('keeps an admin release exempt for good, bursts included', async () => {
    const fixture = watchedFixture(released());
    for (const index of [1, 2, 3, 4, 5])
      expect(await protectSignupCredits(fixture.user(index).id, fixture.db)).toBe(false);
    expect(fixture.repository.reholdWatched).not.toHaveBeenCalled();
    expect(fixture.repository.observe).not.toHaveBeenCalled();
  });

  it('neither watches nor re-holds in enforce mode', async () => {
    const fixture = watchedFixture(released({ policy: 'advisory-decision', decidedAt: new Date() }));
    (fixture.db.signupProtection as SignupProtection).mode = 'enforce';
    for (const index of [1, 2, 3, 4, 5])
      expect(await protectSignupCredits(fixture.user(index).id, fixture.db)).toBe(false);
    expect(fixture.repository.observe).not.toHaveBeenCalled();
    expect(fixture.repository.reholdWatched).not.toHaveBeenCalled();
  });
});
