import { describe, it, expect } from 'vitest';
import type { ISignupRiskScore, SignupRiskReviewState } from '@bike4mind/common';
import mongoose from 'mongoose';
import { User, userRepository } from './UserModel';
import { setupMongoTest } from '../../__test__/utils';

setupMongoTest();

let seq = 0;
const createUser = async (createdAt?: Date, reviewState?: SignupRiskReviewState) => {
  seq += 1;
  const user = await User.create({ username: `risk${seq}`, name: 'Risk', email: `risk${seq}@example.com` });
  // Raw driver write: mongoose timestamps make createdAt immutable through the model.
  const set: Record<string, unknown> = {};
  if (createdAt) set.createdAt = createdAt;
  if (reviewState) set.riskScore = { score: 10, signals: [], computedAt: new Date(), reviewState };
  if (Object.keys(set).length > 0) await User.collection.updateOne({ _id: user._id }, { $set: set });
  return user.id as string;
};

const proposal = (reviewState: SignupRiskReviewState, score = 70): ISignupRiskScore => ({
  score,
  signals: [{ signal: 'quickApiKey', points: 15, reason: 'First API key created 3 minutes after signup' }],
  computedAt: new Date('2026-10-26T12:00:00Z'),
  reviewState,
});

describe('UserRepository.setRiskScore', () => {
  it('stores the score, signals and proposed state on a user with none yet', async () => {
    const id = await createUser();

    await userRepository.setRiskScore(id, proposal('pending'));

    const stored = (await User.findById(id).lean())?.riskScore;
    expect(stored).toEqual(proposal('pending'));
  });

  it('lets scoring flag an account with no pending review', async () => {
    const id = await createUser(undefined, 'none');

    await userRepository.setRiskScore(id, proposal('pending'));

    expect((await User.findById(id).lean())?.riskScore?.reviewState).toBe('pending');
  });

  it('keeps a pending hold when the recomputed score drops below the review threshold', async () => {
    const id = await createUser(undefined, 'pending');
    await userRepository.setRiskScore(id, proposal('none', 5));
    const stored = (await User.findById(id).lean())?.riskScore;
    expect(stored?.reviewState).toBe('pending');
    expect(stored?.score).toBe(5);
  });

  it.each(['approved', 'banned'] as const)('keeps an admin ruling of %s, while refreshing the score', async ruling => {
    const id = await createUser(undefined, ruling);

    await userRepository.setRiskScore(id, proposal('pending', 90));

    const stored = (await User.findById(id).lean())?.riskScore;
    expect(stored?.reviewState).toBe(ruling);
    expect(stored?.score).toBe(90);
  });

  it('stores a reason that starts with $ as text, not a field path', async () => {
    const id = await createUser();
    const withDollar = proposal('none');
    withDollar.signals = [{ signal: 'fastSpend', points: 4, reason: '$email' }];

    await userRepository.setRiskScore(id, withDollar);

    expect((await User.findById(id).lean())?.riskScore?.signals[0].reason).toBe('$email');
  });
});

describe('UserRepository.findRiskScoringCandidateIds', () => {
  const since = new Date('2026-10-12T00:00:00Z');
  const recent = new Date('2026-10-20T00:00:00Z');

  it('returns recent accounts whose review is not settled, in id order', async () => {
    const fresh = await createUser(recent);
    const pending = await createUser(recent, 'pending');
    await createUser(recent, 'approved');
    await createUser(recent, 'banned');
    await createUser(new Date('2026-09-01T00:00:00Z'));

    await expect(userRepository.findRiskScoringCandidateIds(since, { limit: 10 })).resolves.toEqual(
      [fresh, pending].sort()
    );
  });

  it('pages after the given id', async () => {
    const ids = [await createUser(recent), await createUser(recent), await createUser(recent)].sort();

    const first = await userRepository.findRiskScoringCandidateIds(since, { limit: 2 });
    const second = await userRepository.findRiskScoringCandidateIds(since, { afterId: first[1], limit: 2 });

    expect(first).toEqual(ids.slice(0, 2));
    expect(second).toEqual(ids.slice(2));
  });
});

describe('UserRepository.findPendingRiskReviews', () => {
  const scored = async (score: number, reviewState: SignupRiskReviewState, extra: Record<string, unknown> = {}) => {
    const id = await createUser();
    await User.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(id) },
      { $set: { riskScore: { score, signals: [], computedAt: new Date(), reviewState }, ...extra } }
    );
    return id;
  };

  it('returns unbanned pending accounts, highest score first, up to the limit', async () => {
    const mid = await scored(60, 'pending');
    const high = await scored(90, 'pending');
    const low = await scored(55, 'pending');
    await scored(95, 'approved');
    await scored(99, 'pending', { isBanned: true });
    await scored(10, 'none');

    const rows = await userRepository.findPendingRiskReviews(10);
    expect(rows.map(row => row.id)).toEqual([high, mid, low]);
    expect(await userRepository.findPendingRiskReviews(2).then(r => r.map(row => row.id))).toEqual([high, mid]);
  });

  it('returns the signup grant fields the queue reads to flag a held tranche', async () => {
    const signupGrant = { stage: 'signup', signupCredits: 12, unlockCredits: 28, creditsReleased: 0 };
    await scored(60, 'pending', { signupGrant, signupGrantAssessment: { band: 'review' } });

    const [row] = await userRepository.findPendingRiskReviews(10);
    expect(row.signupGrant).toMatchObject(signupGrant);
    expect(row.signupGrantAssessment?.band).toBe('review');
  });
});

describe('UserRepository.countPendingRiskReviews', () => {
  it('counts unbanned pending accounts with no limit', async () => {
    for (const state of ['pending', 'pending', 'pending', 'approved', 'none'] as const)
      await createUser(undefined, state);
    const banned = await createUser(undefined, 'pending');
    await User.collection.updateOne({ _id: new mongoose.Types.ObjectId(banned) }, { $set: { isBanned: true } });

    await expect(userRepository.countPendingRiskReviews()).resolves.toBe(3);
  });
});

describe('UserRepository.setRiskReviewState', () => {
  it('moves a review only from the expected state', async () => {
    const id = await createUser(undefined, 'pending');

    await expect(userRepository.setRiskReviewState(id, 'pending', 'approved')).resolves.toBe(true);
    await expect(userRepository.setRiskReviewState(id, 'pending', 'approved')).resolves.toBe(false);
    expect((await User.findById(id).lean())?.riskScore?.reviewState).toBe('approved');

    await expect(userRepository.setRiskReviewState(id, 'approved', 'pending')).resolves.toBe(true);
    expect((await User.findById(id).lean())?.riskScore?.reviewState).toBe('pending');
  });

  it('keeps an approval or its undo when a scorer writes a stale proposal', async () => {
    const id = await createUser(undefined, 'pending');
    await userRepository.setRiskReviewState(id, 'pending', 'approved');
    await userRepository.setRiskScore(id, proposal('pending'));
    expect((await User.findById(id).lean())?.riskScore?.reviewState).toBe('approved');

    await userRepository.setRiskReviewState(id, 'approved', 'pending');
    await userRepository.setRiskScore(id, proposal('none', 0));
    expect((await User.findById(id).lean())?.riskScore?.reviewState).toBe('pending');
  });

  it('does nothing for a user with no score', async () => {
    const id = await createUser();

    await expect(userRepository.setRiskReviewState(id, 'pending', 'approved')).resolves.toBe(false);
    expect((await User.findById(id).lean())?.riskScore).toBeUndefined();
  });
});

describe('UserRepository.autoApproveRiskReview', () => {
  const approval = { policy: 'settled_payment' as const, decidedAt: new Date('2026-11-01T00:00:00Z') };

  it('approves a pending review and records the policy', async () => {
    const id = await createUser(undefined, 'pending');

    await expect(userRepository.autoApproveRiskReview(id, approval)).resolves.toBe(true);
    const user = await User.findById(id).lean();
    expect(user?.riskScore?.reviewState).toBe('approved');
    expect(user?.riskReviewAutoApproval).toEqual(approval);
  });

  it.each([
    ['banned', { isBanned: true }],
    ['disputed', { disputePending: true }],
    ['suspended', { 'moderation.status': 'suspended' }],
    ['forfeited', { 'signupGrant.unlockForfeited': { cause: 'refund', at: new Date() } }],
    ['reopened by an admin', { riskReviewReopenedAt: new Date() }],
  ])('refuses a %s account at write time', async (_label, set) => {
    const id = await createUser(undefined, 'pending');
    await User.collection.updateOne({ _id: new mongoose.Types.ObjectId(id) }, { $set: set });

    await expect(userRepository.autoApproveRiskReview(id, approval)).resolves.toBe(false);
    expect((await User.findById(id).lean())?.riskScore?.reviewState).toBe('pending');
  });

  it('refuses a review that is no longer pending', async () => {
    const id = await createUser(undefined, 'approved');

    await expect(userRepository.autoApproveRiskReview(id, approval)).resolves.toBe(false);
    expect((await User.findById(id).lean())?.riskReviewAutoApproval).toBeUndefined();
  });

  it('is undone by an admin reopen, which clears the marker and blocks another automatic approval', async () => {
    const id = await createUser(undefined, 'pending');
    await userRepository.autoApproveRiskReview(id, approval);

    await expect(userRepository.setRiskReviewState(id, 'approved', 'pending')).resolves.toBe(true);
    const reopened = await User.findById(id).lean();
    expect(reopened?.riskReviewAutoApproval).toBeUndefined();
    expect(reopened?.riskReviewReopenedAt).toBeInstanceOf(Date);
    await expect(userRepository.findRiskAutoApprovals({ since: new Date(0), limit: 10 })).resolves.toEqual([]);
    await expect(userRepository.autoApproveRiskReview(id, approval)).resolves.toBe(false);
  });

  it('leaves no reopen marker when an admin approves', async () => {
    const id = await createUser(undefined, 'pending');

    await userRepository.setRiskReviewState(id, 'pending', 'approved');
    expect((await User.findById(id).lean())?.riskReviewReopenedAt).toBeUndefined();
  });
});

describe('UserRepository.findPendingRiskReviewIds', () => {
  it('returns unbanned pending accounts in id order, paging after the given id', async () => {
    const ids = [
      await createUser(undefined, 'pending'),
      await createUser(undefined, 'pending'),
      await createUser(undefined, 'pending'),
    ];
    const banned = await createUser(undefined, 'pending');
    await User.collection.updateOne({ _id: new mongoose.Types.ObjectId(banned) }, { $set: { isBanned: true } });
    await createUser(undefined, 'approved');

    const first = await userRepository.findPendingRiskReviewIds({ limit: 2 });
    const second = await userRepository.findPendingRiskReviewIds({ afterId: first[1], limit: 2 });

    expect([...first, ...second]).toEqual(ids);
  });

  it('leaves out accounts that cannot be approved automatically', async () => {
    const eligible = await createUser(undefined, 'pending');
    const set = (id: string, fields: Record<string, unknown>) =>
      User.collection.updateOne({ _id: new mongoose.Types.ObjectId(id) }, { $set: fields });
    await set(await createUser(undefined, 'pending'), { riskReviewReopenedAt: new Date() });
    await set(await createUser(undefined, 'pending'), { disputePending: true });
    await set(await createUser(undefined, 'pending'), { 'moderation.status': 'suspended' });
    await set(await createUser(undefined, 'pending'), { 'signupGrant.unlockForfeited': { at: new Date() } });

    await expect(userRepository.findPendingRiskReviewIds({ limit: 10 })).resolves.toEqual([eligible]);
  });
});

describe('UserRepository.findRiskAutoApprovals', () => {
  it('returns approved accounts approved automatically since the cutoff, newest first', async () => {
    const decided = (iso: string) => ({ policy: 'settled_payment' as const, decidedAt: new Date(iso) });
    const older = await createUser(undefined, 'pending');
    const newer = await createUser(undefined, 'pending');
    const stale = await createUser(undefined, 'pending');
    await userRepository.autoApproveRiskReview(older, decided('2026-11-01T00:00:00Z'));
    await userRepository.autoApproveRiskReview(newer, decided('2026-11-02T00:00:00Z'));
    await userRepository.autoApproveRiskReview(stale, decided('2026-09-01T00:00:00Z'));
    const byAdmin = await createUser(undefined, 'pending');
    await userRepository.setRiskReviewState(byAdmin, 'pending', 'approved');

    const rows = await userRepository.findRiskAutoApprovals({ since: new Date('2026-10-01T00:00:00Z'), limit: 10 });

    expect(rows.map(row => row.id)).toEqual([newer, older]);
  });

  it('leaves out banned accounts', async () => {
    const id = await createUser(undefined, 'pending');
    await userRepository.autoApproveRiskReview(id, { policy: 'settled_payment', decidedAt: new Date() });
    await User.collection.updateOne({ _id: new mongoose.Types.ObjectId(id) }, { $set: { isBanned: true } });

    await expect(userRepository.findRiskAutoApprovals({ since: new Date(0), limit: 10 })).resolves.toEqual([]);
  });
});
