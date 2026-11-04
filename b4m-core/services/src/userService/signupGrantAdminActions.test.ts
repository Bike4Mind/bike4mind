import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PENDING_FREE_CREDITS_TAG, type SignupGrant } from '@bike4mind/common';
import {
  blockSignupGrant,
  releaseHeldSignupGrant,
  releaseRemainingSignupGrant,
  unblockSignupGrant,
} from './signupGrantAdminActions';
import { releaseHeldGrantNow } from './heldSignupGrants';
import { resolveDripLimits, unlockSignupGrant } from './stagedSignupGrant';

vi.mock('@bike4mind/db-core', () => ({ withTransaction: <T>(fn: () => Promise<T>) => fn() }));
vi.mock('./heldSignupGrants', () => ({ releaseHeldGrantNow: vi.fn() }));
vi.mock('./stagedSignupGrant', () => ({ resolveDripLimits: vi.fn(), unlockSignupGrant: vi.fn() }));

type TestUser = {
  id: string;
  emailVerified?: boolean;
  tags?: string[];
  signupGrant?: SignupGrant;
  signupGrantHeldReason?: string | null;
  signupGrantAssessment?: { band: string; status: string };
};

const REVIEW_HOLD = { band: 'review', status: 'evaluated' };

const grant = (overrides: Partial<SignupGrant> = {}): SignupGrant => ({
  stage: 'signup',
  signupCredits: 10,
  unlockCredits: 40,
  creditsReleased: 10,
  nextCondition: 'verification',
  ...overrides,
});

const buildUsers = (user: TestUser | null) => {
  const state = { user };
  const users = {
    findById: vi.fn(async () => state.user),
    update: vi.fn(async (patch: Record<string, unknown>) => {
      state.user = { ...state.user!, ...patch } as TestUser;
      return state.user;
    }),
    addTagsToUser: vi.fn(async (_id: string, tags: string[]) => {
      state.user = { ...state.user!, tags: [...(state.user!.tags ?? []), ...tags] };
    }),
  };
  return { state, users };
};

const blockAdapters = (user: TestUser | null, rewards = { paused: 2, resumed: 2 }) => {
  const { state, users } = buildUsers(user);
  const heldRewards = {
    pauseForUser: vi.fn(async () => rewards.paused),
    resumeForUser: vi.fn(async () => rewards.resumed),
  };
  const now = () => new Date('2026-11-04T00:00:00.000Z');
  // Test double: the service only calls the repository methods stubbed above.
  const adapters = { users, heldRewards, now } as unknown as Parameters<typeof blockSignupGrant>[1];
  return { state, users, heldRewards, adapters };
};

describe('blockSignupGrant', () => {
  it('stores only the time on the grant and pauses the queued rewards', async () => {
    const { state, heldRewards, adapters } = blockAdapters({ id: 'u1', signupGrant: grant() });

    const result = await blockSignupGrant('u1', adapters);

    expect(result).toEqual({ outcome: 'applied', credits: 0, rewardsAffected: 2 });
    expect(state.user?.signupGrant?.blocked).toEqual({ at: new Date('2026-11-04T00:00:00.000Z') });
    expect(state.user?.signupGrant?.creditsReleased).toBe(10);
    expect(heldRewards.pauseForUser).toHaveBeenCalledExactlyOnceWith('u1');
  });

  it('is a no-op with a reason for an account with no grant, and pauses nothing', async () => {
    const { users, heldRewards, adapters } = blockAdapters({ id: 'u1' });

    expect(await blockSignupGrant('u1', adapters)).toEqual({
      outcome: 'noop',
      reason: 'no_grant',
      rewardsAffected: 0,
    });
    expect(users.update).not.toHaveBeenCalled();
    expect(heldRewards.pauseForUser).not.toHaveBeenCalled();
  });

  it('re-pauses the rewards of an already-blocked account instead of stopping early', async () => {
    const { users, heldRewards, adapters } = blockAdapters({
      id: 'u1',
      signupGrant: grant({ blocked: { at: new Date() } }),
    });

    const result = await blockSignupGrant('u1', adapters);

    expect(result).toEqual({ outcome: 'noop', reason: 'already_blocked', rewardsAffected: 2 });
    expect(users.update).not.toHaveBeenCalled();
    expect(heldRewards.pauseForUser).toHaveBeenCalledTimes(1);
  });

  it('audits inside the change and rolls back by failing when the audit write fails', async () => {
    const { heldRewards, adapters } = blockAdapters({ id: 'u1', signupGrant: grant() });
    const audit = vi.fn().mockRejectedValue(new Error('audit down'));

    await expect(blockSignupGrant('u1', { ...adapters, audit })).rejects.toThrow('audit down');
    expect(heldRewards.pauseForUser).not.toHaveBeenCalled();
  });

  it('writes no audit entry for a no-op', async () => {
    const audit = vi.fn();
    const { adapters } = blockAdapters({ id: 'u1', signupGrant: grant({ blocked: { at: new Date() } }) });

    await blockSignupGrant('u1', { ...adapters, audit });
    expect(audit).not.toHaveBeenCalled();
  });

  it('fails when the grant write does not land, and pauses nothing', async () => {
    const { users, heldRewards, adapters } = blockAdapters({ id: 'u1', signupGrant: grant() });
    users.update.mockResolvedValueOnce(null as never);

    await expect(blockSignupGrant('u1', adapters)).rejects.toThrow('Signup grant block update failed');
    expect(heldRewards.pauseForUser).not.toHaveBeenCalled();
  });
});

describe('unblockSignupGrant', () => {
  it('removes the block, keeps the rest of the grant and resumes the paused rewards', async () => {
    const { state, heldRewards, adapters } = blockAdapters({
      id: 'u1',
      signupGrant: grant({ dripCredits: 5, blocked: { at: new Date() } }),
    });

    const result = await unblockSignupGrant('u1', adapters);

    expect(result).toEqual({ outcome: 'applied', credits: 0, rewardsAffected: 2 });
    expect(state.user?.signupGrant).toEqual(grant({ dripCredits: 5 }));
    expect(state.user?.signupGrant).not.toHaveProperty('blocked');
    expect(heldRewards.resumeForUser).toHaveBeenCalledExactlyOnceWith('u1');
  });

  it('queues a tranche whose email was verified during the block, so the held-release job pays it', async () => {
    const { state, users, adapters } = blockAdapters({
      id: 'u1',
      emailVerified: true,
      signupGrant: grant({ stage: 'pending_email', creditsReleased: 0, blocked: { at: new Date() } }),
    });

    await unblockSignupGrant('u1', adapters);

    expect(state.user?.signupGrantHeldReason).toBe('budget_exhausted');
    expect(users.addTagsToUser).toHaveBeenCalledWith('u1', [PENDING_FREE_CREDITS_TAG]);
  });

  it('does not queue a tranche whose email is still unverified or that is already held', async () => {
    const unverified = blockAdapters({
      id: 'u1',
      emailVerified: false,
      signupGrant: grant({ stage: 'pending_email', creditsReleased: 0, blocked: { at: new Date() } }),
    });
    await unblockSignupGrant('u1', unverified.adapters);
    expect(unverified.users.addTagsToUser).not.toHaveBeenCalled();

    const held = blockAdapters({
      id: 'u1',
      emailVerified: true,
      signupGrantHeldReason: 'budget_exhausted',
      signupGrant: grant({ stage: 'pending_email', creditsReleased: 0, blocked: { at: new Date() } }),
    });
    await unblockSignupGrant('u1', held.adapters);
    expect(held.users.addTagsToUser).not.toHaveBeenCalled();
  });

  it('audits once when it lifts a block', async () => {
    const audit = vi.fn();
    const { adapters } = blockAdapters({ id: 'u1', signupGrant: grant({ blocked: { at: new Date() } }) });

    await unblockSignupGrant('u1', { ...adapters, audit });
    expect(audit).toHaveBeenCalledTimes(1);
  });

  it('audits inside the change and fails without resuming rewards when the audit write fails', async () => {
    const { heldRewards, adapters } = blockAdapters({ id: 'u1', signupGrant: grant({ blocked: { at: new Date() } }) });
    const audit = vi.fn().mockRejectedValue(new Error('audit down'));

    await expect(unblockSignupGrant('u1', { ...adapters, audit })).rejects.toThrow('audit down');
    expect(heldRewards.resumeForUser).not.toHaveBeenCalled();
  });

  it('is a no-op with a reason for an account that is not blocked, but still resumes stranded rewards', async () => {
    const { users, heldRewards, adapters } = blockAdapters({ id: 'u1', signupGrant: grant() });

    const result = await unblockSignupGrant('u1', adapters);

    expect(result).toEqual({ outcome: 'noop', reason: 'not_blocked', rewardsAffected: 2 });
    expect(users.update).not.toHaveBeenCalled();
    expect(heldRewards.resumeForUser).toHaveBeenCalledTimes(1);
  });

  it('is a no-op with a reason for an account with no grant', async () => {
    const { heldRewards, adapters } = blockAdapters({ id: 'u1' });

    expect(await unblockSignupGrant('u1', adapters)).toEqual({
      outcome: 'noop',
      reason: 'no_grant',
      rewardsAffected: 0,
    });
    expect(heldRewards.resumeForUser).not.toHaveBeenCalled();
  });
});

const heldAdapters = (user: TestUser | null) => {
  const { users } = buildUsers(user);
  // Test double: the service only reads the user through db.users.findById.
  return { grant: { db: { users } } } as unknown as Parameters<typeof releaseHeldSignupGrant>[1];
};

const heldUser = (overrides: Partial<TestUser> = {}): TestUser => ({
  id: 'u1',
  emailVerified: true,
  tags: [PENDING_FREE_CREDITS_TAG],
  signupGrantHeldReason: 'budget_exhausted',
  signupGrant: grant({ stage: 'pending_email', creditsReleased: 0 }),
  ...overrides,
});

describe('releaseHeldSignupGrant', () => {
  beforeEach(() => {
    vi.mocked(releaseHeldGrantNow).mockReset();
  });

  it('pays a held tranche and reports the credits', async () => {
    vi.mocked(releaseHeldGrantNow).mockResolvedValue({ userId: 'u1', outcome: 'released', credits: 10 });

    expect(await releaseHeldSignupGrant('u1', heldAdapters(heldUser()))).toEqual({ outcome: 'applied', credits: 10 });
  });

  it.each([
    ['no grant', { signupGrant: undefined }, 'no_grant'],
    ['a blocked grant', { signupGrant: grant({ stage: 'pending_email', blocked: { at: new Date() } }) }, 'blocked'],
    [
      'a tranche withheld for risk review',
      { signupGrantAssessment: REVIEW_HOLD, signupGrant: grant({ creditsReleased: 0 }) },
      'held_for_review',
    ],
    ['no hold', { signupGrantHeldReason: null }, 'not_held'],
    ['no pending tag', { tags: [] }, 'not_held'],
  ])('is a no-op with a reason for %s, and pays nothing', async (_label, overrides, reason) => {
    const result = await releaseHeldSignupGrant('u1', heldAdapters(heldUser(overrides)));

    expect(result).toEqual({ outcome: 'noop', reason });
    expect(releaseHeldGrantNow).not.toHaveBeenCalled();
  });

  it('reports a withheld or already-paid release as not paid rather than a zero', async () => {
    vi.mocked(releaseHeldGrantNow).mockResolvedValue({ userId: 'u1', outcome: 'withheld', credits: 0 });

    expect(await releaseHeldSignupGrant('u1', heldAdapters(heldUser()))).toEqual({
      outcome: 'noop',
      reason: 'not_paid',
    });
  });

  it('throws when the payout failed so no audit entry is written', async () => {
    vi.mocked(releaseHeldGrantNow).mockResolvedValue({ userId: 'u1', outcome: 'failed', credits: 0 });

    await expect(releaseHeldSignupGrant('u1', heldAdapters(heldUser()))).rejects.toThrow('release failed');
  });
});

const remainingAdapters = (user: TestUser | null) => {
  const { users } = buildUsers(user);
  // Test double: the service reads the user and passes the adapters through to the mocked unlock.
  return { db: { users, adminSettings: {} } } as unknown as Parameters<typeof releaseRemainingSignupGrant>[1];
};

describe('releaseRemainingSignupGrant', () => {
  beforeEach(() => {
    vi.mocked(unlockSignupGrant).mockReset();
    vi.mocked(resolveDripLimits).mockResolvedValue({ dailyCredits: 5, dripCap: 40, dripCapSource: 'setting' });
  });

  it('pays the rest of the cap through the admin unlock', async () => {
    vi.mocked(unlockSignupGrant).mockResolvedValue({ creditsGranted: 40, currentCredits: 50 });
    const adapters = remainingAdapters({ id: 'u1', signupGrant: grant() });

    expect(await releaseRemainingSignupGrant('u1', adapters)).toEqual({ outcome: 'applied', credits: 40 });
    expect(unlockSignupGrant).toHaveBeenCalledExactlyOnceWith('u1', 'admin', adapters);
  });

  it.each([
    ['no grant', { id: 'u1' }, 'no_grant'],
    ['a blocked grant', { id: 'u1', signupGrant: grant({ blocked: { at: new Date() } }) }, 'blocked'],
    ['a tranche still pending', { id: 'u1', signupGrant: grant({ stage: 'pending_email' }) }, 'tranche_pending'],
    [
      'a tranche withheld for risk review',
      { id: 'u1', signupGrantAssessment: REVIEW_HOLD, signupGrant: grant({ creditsReleased: 0 }) },
      'held_for_review',
    ],
    [
      'nothing left to release',
      { id: 'u1', signupGrant: grant({ stage: 'unlocked', creditsReleased: 50, dripCredits: 40 }) },
      'nothing_remaining',
    ],
  ] as const)('is a no-op with a reason for %s, and pays nothing', async (_label, user, reason) => {
    const result = await releaseRemainingSignupGrant('u1', remainingAdapters(user as TestUser));

    expect(result).toEqual({ outcome: 'noop', reason });
    expect(unlockSignupGrant).not.toHaveBeenCalled();
  });

  it('reports an unlock that paid nothing as not paid rather than a zero', async () => {
    vi.mocked(unlockSignupGrant).mockResolvedValue({ creditsGranted: 0, currentCredits: null });

    expect(await releaseRemainingSignupGrant('u1', remainingAdapters({ id: 'u1', signupGrant: grant() }))).toEqual({
      outcome: 'noop',
      reason: 'not_paid',
    });
  });
});
