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
const longAgo = new Date(0);

/** Claims the served row and records the outcome against that claim, as the vote path does. */
async function settle(userId: string, pairId: string, outcome: Parameters<typeof repo.recordVote>[3]) {
  const claimedAt = new Date();
  await repo.claim(userId, pairId, claimedAt, longAgo);
  return repo.recordVote(userId, pairId, claimedAt, outcome);
}

const rejected = { credited: false as const, rejectReason: 'unqualified' as const };
const outcomeAt = (votedAt: Date) => ({
  choice: 'a' as const,
  votedAt,
  responseMs: 5000,
  goldCorrect: null,
  ...rejected,
});

/** Serves and votes one pair for a user, returning the voted row. */
async function castVote(
  userId: string,
  vote: Partial<Parameters<typeof repo.recordVote>[3]> & { isGold?: boolean } = {}
) {
  const pairId = newPairId();
  const { isGold = false, ...outcome } = vote;
  await repo.serve({ userId, pairId, swapped: false, isGold });
  const { rejectReason: _unused, ...base } = outcomeAt(new Date());
  const merged = outcome.credited ? { ...base, ...outcome } : { ...base, ...rejected, ...outcome };
  return settle(userId, pairId, merged as Parameters<typeof repo.recordVote>[3]);
}

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
    await settle('u1', pairId, outcomeAt(new Date()));
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
    await settle('u1', pairId, outcomeAt(new Date()));
    expect(await repo.serve({ userId: 'u1', pairId, swapped: false, isGold: false })).toBeNull();
  });

  it('records a vote only once', async () => {
    const pairId = newPairId();
    await repo.serve({ userId: 'u1', pairId, swapped: false, isGold: false });
    const outcome = outcomeAt(new Date());
    expect(await settle('u1', pairId, outcome)).not.toBeNull();
    expect(await settle('u1', pairId, outcome)).toBeNull();
  });

  it('grants one live claim and refuses to record without it', async () => {
    const pairId = newPairId();
    await repo.serve({ userId: 'u1', pairId, swapped: false, isGold: false });
    const first = new Date('2026-03-02T10:00:00Z');
    const second = new Date('2026-03-02T10:00:01Z');
    expect(await repo.claim('u1', pairId, first, new Date('2026-03-02T09:59:00Z'))).not.toBeNull();
    expect(await repo.claim('u1', pairId, second, new Date('2026-03-02T09:59:01Z'))).toBeNull();
    expect(await repo.recordVote('u1', pairId, second, outcomeAt(second))).toBeNull();
    expect(await repo.recordVote('u1', pairId, first, outcomeAt(first))).not.toBeNull();
  });

  it('lets a retry take over a stale claim', async () => {
    const pairId = newPairId();
    await repo.serve({ userId: 'u1', pairId, swapped: false, isGold: false });
    const crashed = new Date('2026-03-02T10:00:00Z');
    const retry = new Date('2026-03-02T10:02:00Z');
    await repo.claim('u1', pairId, crashed, new Date('2026-03-02T09:59:00Z'));
    expect(await repo.claim('u1', pairId, retry, new Date('2026-03-02T10:01:00Z'))).not.toBeNull();
    expect(await repo.recordVote('u1', pairId, crashed, outcomeAt(crashed))).toBeNull();
  });
});

describe('arenaVoteRepository cap and quality reads', () => {
  it('stamps the judged outcome in the same write that leaves served', async () => {
    const voted = await castVote('u1', { credited: true, creditsAwarded: 3 });
    expect(voted).toMatchObject({ status: 'voted', credited: true, creditsAwarded: 3 });
  });

  it('counts only credited votes since the cutoff, for this user', async () => {
    const today = new Date('2026-03-02T10:00:00Z');
    await castVote('u1', { votedAt: today, credited: true, creditsAwarded: 2 });
    await castVote('u1', { votedAt: new Date('2026-03-01T23:59:59Z'), credited: true, creditsAwarded: 2 });
    await castVote('u1', { votedAt: today });
    await castVote('u2', { votedAt: today, credited: true, creditsAwarded: 2 });

    expect(await repo.countCreditedSince('u1', new Date('2026-03-02T00:00:00Z'))).toBe(1);
    expect(await repo.creditsEarned('u1')).toBe(4);
  });

  it('ignores a served row that is still being judged', async () => {
    await repo.serve({ userId: 'u1', pairId: newPairId(), swapped: false, isGold: true });
    expect(await repo.goldRecord('u1')).toEqual({ answered: 0, correct: 0 });
    expect(await repo.creditsEarned('u1')).toBe(0);
  });

  it('records gold accuracy from voted gold rows only', async () => {
    await castVote('u1', { isGold: true, goldCorrect: true });
    await castVote('u1', { isGold: true, goldCorrect: false });
    await castVote('u1');
    expect(await repo.goldRecord('u1')).toEqual({ answered: 2, correct: 1 });
  });

  it('keeps too-fast gold answers out of gold standing', async () => {
    await castVote('u1', { isGold: true, goldCorrect: true });
    await castVote('u1', { isGold: true, goldCorrect: true, rejectReason: 'too_fast' });
    expect(await repo.goldRecord('u1')).toEqual({ answered: 1, correct: 1 });
    expect(await repo.goldRaters()).toEqual([expect.objectContaining({ userId: 'u1', answered: 1, correct: 1 })]);
  });

  it('keeps too-fast clicks and gold questions out of the routing data', async () => {
    await castVote('u1', { choice: 'b' });
    await castVote('u1', { rejectReason: 'too_fast' });
    await castVote('u1', { isGold: true, goldCorrect: true });
    const rated = await repo.votesByRaters(['u1']);
    expect(rated).toHaveLength(1);
    expect(rated[0].choice).toBe('b');
  });
});

describe('arenaVoteRepository deleteUnclaimedServed', () => {
  const staleBefore = new Date('2026-03-02T09:59:00Z');

  it('deletes an unclaimed served row', async () => {
    const row = await repo.serve({ userId: 'u1', pairId: newPairId(), swapped: false, isGold: false });
    expect(await repo.deleteUnclaimedServed(row!.id, staleBefore)).toBe(true);
    expect(await ArenaVote.countDocuments({ userId: 'u1' })).toBe(0);
  });

  it('keeps a row under a live claim', async () => {
    const pairId = newPairId();
    const row = await repo.serve({ userId: 'u1', pairId, swapped: false, isGold: false });
    await repo.claim('u1', pairId, new Date('2026-03-02T10:00:00Z'), staleBefore);
    expect(await repo.deleteUnclaimedServed(row!.id, staleBefore)).toBe(false);
    expect(await ArenaVote.countDocuments({ userId: 'u1' })).toBe(1);
  });

  it('deletes a row whose claim went stale', async () => {
    const pairId = newPairId();
    const row = await repo.serve({ userId: 'u1', pairId, swapped: false, isGold: false });
    await repo.claim('u1', pairId, new Date('2026-03-02T09:00:00Z'), staleBefore);
    expect(await repo.deleteUnclaimedServed(row!.id, staleBefore)).toBe(true);
  });

  it('never deletes a voted row', async () => {
    const voted = await castVote('u1');
    expect(await repo.deleteUnclaimedServed(voted!.id, new Date())).toBe(false);
    expect(await ArenaVote.countDocuments({ userId: 'u1' })).toBe(1);
  });
});
