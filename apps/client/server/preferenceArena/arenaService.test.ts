import { describe, it, expect, vi } from 'vitest';
import { ForbiddenError, NotFoundError, type PreferenceArenaSettings } from '@bike4mind/common';
import type { IArenaPairDocument, IArenaVoteDocument } from '@bike4mind/database';
import { createArenaService, type ArenaServiceDeps, type ArenaUser } from './arenaService';

const settings: PreferenceArenaSettings = {
  enabled: true,
  creditsPerVote: 2,
  dailyVoteCap: 10,
  lifetimeCreditCap: 100,
  minResponseMs: 1000,
  goldRatePercent: 0,
  minGoldVotes: 1,
  minGoldAccuracyPercent: 50,
};

const verifiedUser: ArenaUser = {
  emailVerified: true,
  signupGrant: { stage: 'unlocked', unlockedBy: 'github_verified' },
};

const pair = (over: Partial<IArenaPairDocument> = {}): IArenaPairDocument =>
  ({
    id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
    prompt: 'p',
    taskType: 'code',
    source: 'synthetic',
    answers: [
      { modelId: 'model-1', text: 'first' },
      { modelId: 'model-2', text: 'second' },
    ],
    active: true,
    createdBy: 'admin',
    ...over,
  }) as IArenaPairDocument;

const servedRow = (over: Partial<IArenaVoteDocument> = {}): IArenaVoteDocument =>
  ({
    id: 'vote1',
    userId: 'u1',
    pairId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
    swapped: false,
    status: 'served',
    servedAt: new Date('2026-01-01T00:00:00Z'),
    isGold: false,
    goldCorrect: null,
    credited: false,
    creditsAwarded: 0,
    ...over,
  }) as IArenaVoteDocument;

function build(over: { user?: ArenaUser | null; settings?: Partial<PreferenceArenaSettings>; random?: number } = {}) {
  const votes = {
    findOutstanding: vi.fn().mockResolvedValue(null),
    findForPair: vi.fn().mockResolvedValue(servedRow()),
    seenPairIds: vi.fn().mockResolvedValue([]),
    serve: vi.fn().mockImplementation(async data => servedRow(data)),
    recordVote: vi.fn().mockImplementation(async (_u, _p, outcome) => servedRow({ ...outcome, status: 'voted' })),
    goldRecord: vi.fn().mockResolvedValue({ answered: 3, correct: 3 }),
    countCreditedSince: vi.fn().mockResolvedValue(0),
    creditsEarned: vi.fn().mockResolvedValue(0),
    totals: vi.fn(),
    rejectionCounts: vi.fn(),
    goldRaters: vi.fn(),
    distinctRaterCount: vi.fn(),
    votesByRaters: vi.fn(),
    delete: vi.fn(),
  };
  const pairs = {
    findById: vi.fn().mockResolvedValue(pair()),
    insertMany: vi.fn(),
    sampleUnseen: vi.fn().mockResolvedValue(pair()),
    listPage: vi.fn(),
    setActive: vi.fn(),
    countsForStats: vi.fn(),
    findByIds: vi.fn(),
  };
  const addCredits = vi.fn().mockResolvedValue({ creditTransactionId: 'tx1' });
  const creditAdapters = { db: { creditLots: 'lots' }, creditHolderMethods: 'holder' } as never;
  const logger = { error: vi.fn() };
  const deps: ArenaServiceDeps = {
    pairs,
    votes,
    loadUser: async () => (over.user === undefined ? verifiedUser : over.user),
    loadSettings: async () => ({ ...settings, ...over.settings }),
    addCredits,
    creditAdapters,
    logger,
    now: () => new Date('2026-01-01T00:00:10Z'),
    random: () => over.random ?? 0.9,
  };
  return { service: createArenaService(deps), votes, pairs, addCredits, creditAdapters, logger };
}

const vote = { pairId: 'AAAAAAAAAAAAAAAAAAAAAAAA', choice: 'a' as const };

describe('serveNextPair', () => {
  it('refuses ineligible users with a reason', async () => {
    expect((await build({ settings: { enabled: false } }).service.serveNextPair('u1')).status).toBe('ineligible');
    expect(await build({ user: { emailVerified: true } }).service.serveNextPair('u1')).toEqual({
      status: 'ineligible',
      reason: 'unverified',
    });
    expect(await build({ user: { ...verifiedUser, isBanned: true } }).service.serveNextPair('u1')).toEqual({
      status: 'ineligible',
      reason: 'blocked',
    });
    expect(
      await build({ user: { ...verifiedUser, moderation: { status: 'suspend_pending' } } }).service.serveNextPair('u1')
    ).toEqual({ status: 'ineligible', reason: 'blocked' });
  });

  it('returns the outstanding pair without serving another', async () => {
    const { service, votes, pairs } = build();
    votes.findOutstanding.mockResolvedValue(servedRow({ swapped: true }));
    const result = await service.serveNextPair('u1');
    expect(result).toEqual({
      status: 'ready',
      pair: { pairId: 'aaaaaaaaaaaaaaaaaaaaaaaa', prompt: 'p', taskType: 'code', answerA: 'second', answerB: 'first' },
    });
    expect(votes.serve).not.toHaveBeenCalled();
    expect(pairs.sampleUnseen).not.toHaveBeenCalled();
  });

  it('serves a fresh pair in the rater order and never exposes model ids or the gold answer', async () => {
    const { service, pairs } = build({ random: 0.9 });
    pairs.sampleUnseen.mockResolvedValue(pair({ goldChoice: 'a' }));
    const result = await service.serveNextPair('u1');
    expect(JSON.stringify(result)).not.toMatch(/model-|goldChoice/);
    expect(result).toMatchObject({ status: 'ready', pair: { answerA: 'first', answerB: 'second' } });
  });

  it('falls back to the other pool and reports empty when both are exhausted', async () => {
    const { service, pairs } = build();
    pairs.sampleUnseen.mockResolvedValue(null);
    expect(await service.serveNextPair('u1')).toEqual({ status: 'empty' });
    expect(pairs.sampleUnseen.mock.calls.map(call => call[0])).toEqual(['regular', 'gold']);
  });

  it('drops an outstanding pair that was retired and serves a fresh one', async () => {
    const { service, votes, pairs } = build();
    votes.findOutstanding.mockResolvedValue(servedRow({ id: 'stale' }));
    pairs.findById.mockResolvedValue(pair({ active: false }));
    pairs.sampleUnseen.mockResolvedValue(pair({ id: 'bbbbbbbbbbbbbbbbbbbbbbbb' }));
    expect(await service.serveNextPair('u1')).toMatchObject({
      status: 'ready',
      pair: { pairId: 'bbbbbbbbbbbbbbbbbbbbbbbb' },
    });
    expect(votes.delete).toHaveBeenCalledWith('stale');
  });

  it('shows the winner of a serve race', async () => {
    const { service, votes } = build();
    votes.serve.mockResolvedValue(null);
    votes.findOutstanding.mockResolvedValueOnce(null).mockResolvedValueOnce(servedRow());
    expect((await service.serveNextPair('u1')).status).toBe('ready');
  });
});

describe('submitVote', () => {
  it('refuses ineligible users', async () => {
    const { service, votes } = build({ settings: { enabled: false } });
    await expect(service.submitVote('u1', vote)).rejects.toBeInstanceOf(ForbiddenError);
    expect(votes.recordVote).not.toHaveBeenCalled();
  });

  it('answers NotFound when no pair was served', async () => {
    const { service, votes } = build();
    votes.findForPair.mockResolvedValue(null);
    await expect(service.submitVote('u1', vote)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('maps a swapped choice back to canonical order', async () => {
    const { service, votes } = build();
    votes.findForPair.mockResolvedValue(servedRow({ swapped: true }));
    await service.submitVote('u1', { ...vote, choice: 'a' });
    expect(votes.recordVote).toHaveBeenCalledWith(
      'u1',
      'aaaaaaaaaaaaaaaaaaaaaaaa',
      expect.objectContaining({ choice: 'b', responseMs: 10_000 })
    );
    await service.submitVote('u1', { ...vote, choice: 'tie' });
    expect(votes.recordVote).toHaveBeenLastCalledWith(
      'u1',
      expect.any(String),
      expect.objectContaining({ choice: 'tie' })
    );
  });

  it('grants credits as a promo lot with a stable transaction id and records the award', async () => {
    const { service, votes, addCredits, creditAdapters } = build();
    expect(await service.submitVote('u1', vote)).toEqual({ creditsAwarded: 2 });
    expect(addCredits).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: 'u1',
        credits: 2,
        type: 'generic_add',
        transactionId: 'arena-vote:vote1',
        reason: 'preference_arena_vote',
        metadata: { voteId: 'vote1', pairId: 'aaaaaaaaaaaaaaaaaaaaaaaa' },
      }),
      creditAdapters
    );
    expect(votes.recordVote).toHaveBeenCalledWith(
      'u1',
      'aaaaaaaaaaaaaaaaaaaaaaaa',
      expect.objectContaining({ credited: true, creditsAwarded: 2 })
    );
  });

  it('judges and pays while the row is still served, so a second pair cannot slip past the caps', async () => {
    const { service, votes, addCredits } = build();
    await service.submitVote('u1', vote);
    const flippedAt = votes.recordVote.mock.invocationCallOrder[0];
    expect(votes.countCreditedSince.mock.invocationCallOrder[0]).toBeLessThan(flippedAt);
    expect(votes.creditsEarned.mock.invocationCallOrder[0]).toBeLessThan(flippedAt);
    expect(addCredits.mock.invocationCallOrder[0]).toBeLessThan(flippedAt);
    expect(votes.countCreditedSince).toHaveBeenCalledWith('u1', new Date('2026-01-01T00:00:00Z'));
  });

  it('counts this gold answer toward qualification', async () => {
    const { service, votes, pairs } = build();
    votes.goldRecord.mockResolvedValue({ answered: 0, correct: 0 });
    pairs.findById.mockResolvedValue(pair({ goldChoice: 'a' }));
    expect(await service.submitVote('u1', vote)).toEqual({ creditsAwarded: 2 });
  });

  it('refuses and releases a retired pair without paying', async () => {
    const { service, votes, pairs, addCredits } = build();
    pairs.findById.mockResolvedValue(pair({ active: false }));
    await expect(service.submitVote('u1', vote)).rejects.toBeInstanceOf(NotFoundError);
    expect(votes.delete).toHaveBeenCalledWith('vote1');
    expect(addCredits).not.toHaveBeenCalled();
    expect(votes.recordVote).not.toHaveBeenCalled();
  });

  it('does not credit a missed gold question and records the reason', async () => {
    const { service, votes, pairs, addCredits } = build();
    pairs.findById.mockResolvedValue(pair({ goldChoice: 'b' }));
    expect(await service.submitVote('u1', { ...vote, choice: 'a' })).toEqual({ creditsAwarded: 0 });
    expect(addCredits).not.toHaveBeenCalled();
    expect(votes.recordVote).toHaveBeenCalledWith(
      'u1',
      expect.any(String),
      expect.objectContaining({ goldCorrect: false, credited: false, rejectReason: 'gold_missed' })
    );
  });

  it('is idempotent for a pair that was already voted', async () => {
    const { service, votes, addCredits } = build();
    votes.findForPair.mockResolvedValue(servedRow({ status: 'voted', creditsAwarded: 2 }));
    expect(await service.submitVote('u1', vote)).toEqual({ creditsAwarded: 2 });
    expect(votes.recordVote).not.toHaveBeenCalled();
    expect(addCredits).not.toHaveBeenCalled();
  });

  it('returns the settled award when a concurrent submit of the same vote won the race', async () => {
    const { service, votes, addCredits } = build();
    votes.recordVote.mockResolvedValue(null);
    votes.findForPair
      .mockResolvedValueOnce(servedRow())
      .mockResolvedValueOnce(servedRow({ status: 'voted', creditsAwarded: 2 }));
    expect(await service.submitVote('u1', vote)).toEqual({ creditsAwarded: 2 });
    // The losing grant reuses the winner's transaction id, which the ledger turns into a no-op.
    expect(addCredits).toHaveBeenCalledWith(
      expect.objectContaining({ transactionId: 'arena-vote:vote1' }),
      expect.anything()
    );
  });

  it('swallows a grant failure, logs it and awards nothing', async () => {
    const { service, votes, addCredits, logger } = build();
    addCredits.mockRejectedValue(new Error('db down'));
    expect(await service.submitVote('u1', vote)).toEqual({ creditsAwarded: 0 });
    expect(logger.error).toHaveBeenCalled();
    expect(votes.recordVote).toHaveBeenCalledWith(
      'u1',
      expect.any(String),
      expect.objectContaining({ credited: false, rejectReason: 'grant_failed' })
    );
  });
});

describe('getArenaStats', () => {
  it('builds win rates only from raters the vote judge would also qualify', async () => {
    const { service, votes, pairs } = build({ settings: { minGoldVotes: 2, minGoldAccuracyPercent: 75 } });
    pairs.countsForStats.mockResolvedValue({ total: 1, gold: 0, active: 1 });
    votes.totals.mockResolvedValue({ votes: 3, credited: 1, creditsAwarded: 2 });
    votes.rejectionCounts.mockResolvedValue({});
    votes.distinctRaterCount.mockResolvedValue(3);
    votes.goldRaters.mockResolvedValue([
      { userId: 'good', answered: 4, correct: 4 },
      { userId: 'bad', answered: 4, correct: 1 },
      { userId: 'new', answered: 1, correct: 1 },
    ]);
    votes.votesByRaters.mockResolvedValue([{ userId: 'good', pairId: 'aaaaaaaaaaaaaaaaaaaaaaaa', choice: 'b' }]);
    pairs.findByIds.mockResolvedValue([pair()]);

    const stats = await service.getArenaStats();

    expect(stats.raters).toEqual({ total: 3, qualified: 1, flagged: 1 });
    expect(votes.votesByRaters).toHaveBeenCalledWith(['good']);
    expect(stats.winRates).toEqual([
      { taskType: 'code', modelId: 'model-2', wins: 1, losses: 0, ties: 0 },
      { taskType: 'code', modelId: 'model-1', wins: 0, losses: 1, ties: 0 },
    ]);
  });
});
