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
