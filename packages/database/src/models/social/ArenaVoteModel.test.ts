import { describe, it, expect, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { setupMongoTest } from '../../__test__/utils';
import { ArenaVote, arenaVoteRepository as repo } from './ArenaVoteModel';

setupMongoTest();

// The shared cleanup drops indexes between tests.
beforeEach(async () => {
  await ArenaVote.createIndexes();
});

const newPairId = () => new mongoose.Types.ObjectId().toHexString();

describe('arenaVoteRepository outstanding-pair invariant', () => {
  it('serves one pair and refuses a second while the first is outstanding', async () => {
    const first = await repo.serve({ userId: 'u1', pairId: newPairId(), swapped: false, isGold: false });
    const second = await repo.serve({ userId: 'u1', pairId: newPairId(), swapped: true, isGold: false });
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(await ArenaVote.countDocuments({ userId: 'u1' })).toBe(1);
  });

  it('allows another outstanding pair once the first is voted', async () => {
    const pairId = newPairId();
    await repo.serve({ userId: 'u1', pairId, swapped: false, isGold: false });
    await repo.recordVote('u1', pairId, { choice: 'a', votedAt: new Date(), responseMs: 5000, goldCorrect: null });
    const next = await repo.serve({ userId: 'u1', pairId: newPairId(), swapped: false, isGold: false });
    expect(next).not.toBeNull();
  });

  it('keeps outstanding pairs independent across users', async () => {
    const pairId = newPairId();
    expect(await repo.serve({ userId: 'u1', pairId, swapped: false, isGold: false })).not.toBeNull();
    expect(await repo.serve({ userId: 'u2', pairId, swapped: false, isGold: false })).not.toBeNull();
  });

  it('refuses serving the same pair to the same user twice', async () => {
    const pairId = newPairId();
    await repo.serve({ userId: 'u1', pairId, swapped: false, isGold: false });
    await repo.recordVote('u1', pairId, { choice: 'b', votedAt: new Date(), responseMs: 5000, goldCorrect: null });
    expect(await repo.serve({ userId: 'u1', pairId, swapped: false, isGold: false })).toBeNull();
  });

  it('records a vote only once', async () => {
    const pairId = newPairId();
    await repo.serve({ userId: 'u1', pairId, swapped: false, isGold: false });
    const outcome = { choice: 'a' as const, votedAt: new Date(), responseMs: 5000, goldCorrect: null };
    expect(await repo.recordVote('u1', pairId, outcome)).not.toBeNull();
    expect(await repo.recordVote('u1', pairId, outcome)).toBeNull();
  });
});
