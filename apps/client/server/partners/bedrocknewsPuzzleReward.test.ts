// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockFindById, mockFindOne, mockAggregate, mockAddCredits, mockGetSettingsMap } = vi.hoisted(() => ({
  mockFindById: vi.fn(),
  mockFindOne: vi.fn(),
  mockAggregate: vi.fn(),
  mockAddCredits: vi.fn(),
  mockGetSettingsMap: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  creditLotRepository: {},
  creditTransactionRepository: {},
  userRepository: {},
  CreditTransaction: { findOne: mockFindOne, aggregate: mockAggregate },
  User: { findById: mockFindById },
}));
vi.mock('@bike4mind/services', () => ({ creditService: { addCreditsWithLedgerRow: mockAddCredits } }));
// Real getSettingsValue, so an unstored setting resolves to its schema default.
vi.mock('@bike4mind/utils', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  getSettingsMap: mockGetSettingsMap,
}));

import {
  BEDROCKNEWS_FIRST_SOLVE_REASON,
  BEDROCKNEWS_PUZZLE_REASON,
  grantPuzzleReward,
} from './bedrocknewsPuzzleReward';

const USER_ID = 'a1b2c3d4e5f6a1b2c3d4e5f6';
const DATE = '2026-11-02';
const INPUT = { userId: USER_ID, puzzleDate: DATE, tier: 5, hard: false } as const;
const PUZZLE_KEY = `bedrocknews-puzzle:${USER_ID}:${DATE}:5`;
const FIRST_SOLVE_KEY = `bedrocknews-first-solve:${USER_ID}`;
const DAY_MS = 24 * 60 * 60 * 1000;

const lean = (value: unknown) => ({ select: () => ({ lean: () => Promise.resolve(value) }) });
const eligibleUser = { emailVerified: true, currentCredits: 1000 };

const givenUser = (user: unknown) => mockFindById.mockReturnValue(lean(user));
const givenSettings = (settings: Record<string, string>) => mockGetSettingsMap.mockResolvedValue(settings);
// The per-user cap and the global budget are the two aggregates; only the cap matches on puzzleDate.
const givenSpend = ({ onDate = 0, last24h = 0 }: { onDate?: number; last24h?: number }) =>
  mockAggregate.mockImplementation(([{ $match }]: [{ $match: Record<string, unknown> }]) => {
    const total = 'metadata.puzzleDate' in $match ? onDate : last24h;
    return Promise.resolve(total ? [{ _id: null, total }] : []);
  });
const matches = () => mockAggregate.mock.calls.map(([pipeline]) => pipeline[0].$match as Record<string, unknown>);
const capMatch = () => matches().find(match => 'metadata.puzzleDate' in match);
const budgetMatch = () => matches().find(match => !('metadata.puzzleDate' in match));
const writeFor = (reason: string) => mockAddCredits.mock.calls.find(([params]) => params.reason === reason)?.[0];
const rungWrite = () => writeFor(BEDROCKNEWS_PUZZLE_REASON);
const bonusWrite = () => writeFor(BEDROCKNEWS_FIRST_SOLVE_REASON);
// Answers each ledger lookup by its transactionId; unlisted keys find no row.
const givenRows = (rows: Record<string, unknown>) =>
  mockFindOne.mockImplementation(({ transactionId }: { transactionId: string }) => lean(rows[transactionId] ?? null));

beforeEach(() => {
  vi.clearAllMocks();
  givenUser(eligibleUser);
  givenSettings({});
  givenSpend({});
  mockFindOne.mockReturnValue(lean(null));
  mockAddCredits.mockResolvedValue({ creditTransactionId: 'tx1' });
});

describe('grantPuzzleReward', () => {
  it.each([
    [5, false, 40],
    [6, false, 60],
    [7, false, 100],
    [5, true, 60],
    [6, true, 90],
    [7, true, 150],
  ] as const)('pays tier %i (hard: %s) %i credits under a stable per-rung key', async (tier, hard, amount) => {
    const result = await grantPuzzleReward({ ...INPUT, tier, hard });

    expect(result).toEqual({ ok: true, granted: true, credits: amount, balance: 1000, firstSolveCredits: 500 });
    expect(rungWrite()).toEqual({
      ownerId: USER_ID,
      ownerType: 'User',
      type: 'generic_add',
      credits: amount,
      reason: BEDROCKNEWS_PUZZLE_REASON,
      transactionId: `bedrocknews-puzzle:${USER_ID}:${DATE}:${tier}`,
      description: `Headword: solved the ${tier}-letter word on ${DATE}`,
      metadata: { product: 'bedrocknews', game: 'headword', puzzleDate: DATE, tier, hard },
    });
    expect(mockAddCredits.mock.calls[0][1].db.creditLots).toBeDefined();
    expect(mockAddCredits.mock.calls[1][1].db.creditLots).toBeDefined();
  });

  it('reads the seven settings uncached and falls back to their defaults when none is stored', async () => {
    await grantPuzzleReward(INPUT);

    expect(mockGetSettingsMap.mock.calls[0][1]).toEqual({
      names: [
        'BedrockNewsPuzzleCredits5',
        'BedrockNewsPuzzleCredits6',
        'BedrockNewsPuzzleCredits7',
        'BedrockNewsPuzzleHardMultiplier',
        'BedrockNewsFirstSolveCredits',
        'BedrockNewsPuzzleDailyCap',
        'BedrockNewsRewardsDailyBudget',
      ],
      skipCache: true,
    });
    expect(rungWrite()?.credits).toBe(40);
  });

  it('uses the stored multiplier for hard mode only, rounding a fractional amount', async () => {
    givenSettings({ BedrockNewsPuzzleHardMultiplier: '1.33' });

    await expect(grantPuzzleReward({ ...INPUT, hard: true })).resolves.toMatchObject({ credits: 53 });
    await expect(grantPuzzleReward(INPUT)).resolves.toMatchObject({ credits: 40 });
  });

  describe('replay', () => {
    it('answers the stored amount with granted false before any cap or write', async () => {
      mockFindOne.mockReturnValue(lean({ credits: 40 }));
      givenSpend({ onDate: 10_000, last24h: 10_000_000 });

      const result = await grantPuzzleReward(INPUT);

      expect(result).toEqual({ ok: true, granted: false, credits: 40, balance: 1000, firstSolveCredits: 0 });
      expect(mockFindOne).toHaveBeenCalledWith({ transactionId: PUZZLE_KEY });
      expect(mockAggregate).not.toHaveBeenCalled();
      expect(mockAddCredits).not.toHaveBeenCalled();
    });

    it('answers the stored amount, not the current one, when the setting changed since', async () => {
      mockFindOne.mockReturnValue(lean({ credits: 40 }));
      givenSettings({ BedrockNewsPuzzleCredits5: '999' });

      await expect(grantPuzzleReward(INPUT)).resolves.toMatchObject({ granted: false, credits: 40 });
    });

    it('answers a paid rung even after the account was blocked, so the caller can still record it', async () => {
      givenUser({ ...eligibleUser, isBanned: true });
      mockFindOne.mockReturnValue(lean({ credits: 40 }));

      await expect(grantPuzzleReward(INPUT)).resolves.toMatchObject({ ok: true, granted: false, credits: 40 });
      expect(mockAddCredits).not.toHaveBeenCalled();
    });

    it('treats a concurrent duplicate as a replay: stored amount', async () => {
      mockFindOne
        .mockReturnValueOnce(lean(null))
        .mockReturnValueOnce(lean({ _id: 'bonus' }))
        .mockReturnValueOnce(lean({ credits: 40 }));
      mockAddCredits.mockResolvedValue({ creditTransactionId: undefined });
      mockFindById.mockReturnValueOnce(lean(eligibleUser)).mockReturnValueOnce(lean({ currentCredits: 1040 }));

      const result = await grantPuzzleReward(INPUT);

      expect(result).toEqual({ ok: true, granted: false, credits: 40, balance: 1040, firstSolveCredits: 0 });
      expect(mockAddCredits).toHaveBeenCalledTimes(1);
    });
  });

  describe('first-solve bonus', () => {
    it('is written once with its own key, reason and the configured amount', async () => {
      const result = await grantPuzzleReward(INPUT);

      expect(mockAddCredits).toHaveBeenCalledTimes(2);
      expect(mockFindOne).toHaveBeenCalledWith({ transactionId: FIRST_SOLVE_KEY });
      expect(bonusWrite()).toMatchObject({
        ownerId: USER_ID,
        ownerType: 'User',
        type: 'generic_add',
        credits: 500,
        reason: BEDROCKNEWS_FIRST_SOLVE_REASON,
        transactionId: FIRST_SOLVE_KEY,
      });
      expect(result).toMatchObject({ granted: true, credits: 40, firstSolveCredits: 500 });
    });

    // Bonus first: a rung write that fails after it leaves the rung unpaid, so the retry pays the rung.
    it('is written before the rung', async () => {
      await grantPuzzleReward(INPUT);

      expect(mockAddCredits.mock.calls.map(([params]) => params.reason)).toEqual([
        BEDROCKNEWS_FIRST_SOLVE_REASON,
        BEDROCKNEWS_PUZZLE_REASON,
      ]);
    });

    it('is neither written nor reserved against the budget once the player has it', async () => {
      givenRows({ [FIRST_SOLVE_KEY]: { _id: 'bonus' } });
      givenSpend({ last24h: 199_960 });

      const result = await grantPuzzleReward({ ...INPUT, puzzleDate: '2026-11-03' });

      expect(result).toMatchObject({ granted: true, credits: 40, firstSolveCredits: 0 });
      expect(mockAddCredits).toHaveBeenCalledTimes(1);
      expect(bonusWrite()).toBeUndefined();
    });

    it('answers firstSolveCredits 0 when a concurrent grant wrote the bonus first', async () => {
      mockAddCredits.mockImplementation(({ transactionId }: { transactionId: string }) =>
        Promise.resolve({ creditTransactionId: transactionId === FIRST_SOLVE_KEY ? undefined : 'tx1' })
      );

      const result = await grantPuzzleReward({ ...INPUT, puzzleDate: '2026-11-03' });

      expect(result).toMatchObject({ granted: true, credits: 40, firstSolveCredits: 0 });
    });

    it('is skipped while the setting is 0', async () => {
      givenSettings({ BedrockNewsFirstSolveCredits: '0' });

      const result = await grantPuzzleReward(INPUT);

      expect(mockAddCredits).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ granted: true, firstSolveCredits: 0 });
    });

    it('reports the balance read after both writes', async () => {
      mockFindById.mockReturnValueOnce(lean(eligibleUser)).mockReturnValueOnce(lean({ currentCredits: 1540 }));

      await expect(grantPuzzleReward(INPUT)).resolves.toMatchObject({ balance: 1540 });
    });
  });

  describe('per-user daily cap', () => {
    it('sums only the puzzle-reward rows of this user for the puzzle date', async () => {
      await grantPuzzleReward(INPUT);

      expect(capMatch()).toEqual({
        ownerId: USER_ID,
        ownerType: 'User',
        type: 'generic_add',
        reason: BEDROCKNEWS_PUZZLE_REASON,
        'metadata.puzzleDate': DATE,
        createdAt: { $gte: new Date(`${DATE}T00:00:00.000Z`) },
      });
    });

    it.each([
      [260, true],
      [261, false],
      [300, false],
    ])('with %i already paid that date a 40 grant is allowed: %s', async (onDate, allowed) => {
      givenSpend({ onDate });

      const result = await grantPuzzleReward(INPUT);

      if (allowed) {
        expect(result).toMatchObject({ ok: true, granted: true });
      } else {
        expect(result).toEqual({ ok: false, status: 403, code: 'DAILY_CAP' });
        expect(mockAddCredits).not.toHaveBeenCalled();
      }
    });

    it('honours a lowered cap setting', async () => {
      givenSettings({ BedrockNewsPuzzleDailyCap: '30' });

      await expect(grantPuzzleReward(INPUT)).resolves.toEqual({ ok: false, status: 403, code: 'DAILY_CAP' });
    });
  });

  describe('global daily budget', () => {
    it('sums both reasons across all users over the trailing 24 hours', async () => {
      const before = Date.now();
      await grantPuzzleReward(INPUT);

      const match = budgetMatch() as {
        reason: { $in: string[] };
        createdAt: { $gte: Date };
        ownerId?: string;
      };
      expect(match).toMatchObject({ ownerType: 'User', type: 'generic_add' });
      expect(match.reason.$in).toEqual([BEDROCKNEWS_PUZZLE_REASON, BEDROCKNEWS_FIRST_SOLVE_REASON]);
      expect(match.ownerId).toBeUndefined();
      expect(match.createdAt.$gte.getTime()).toBeGreaterThanOrEqual(before - DAY_MS);
      expect(match.createdAt.$gte.getTime()).toBeLessThanOrEqual(Date.now() - DAY_MS);
    });

    // The check reserves room for the 500 first-solve bonus on top of the 40 rung while it is unpaid.
    it.each([
      [199_460, true],
      [199_461, false],
    ])('with %i paid in the window a 40 grant is allowed: %s', async (last24h, allowed) => {
      givenSpend({ last24h });

      const result = await grantPuzzleReward(INPUT);

      if (allowed) {
        expect(result).toMatchObject({ ok: true, granted: true });
      } else {
        expect(result).toEqual({ ok: false, status: 403, code: 'BUDGET_EXHAUSTED' });
        expect(mockAddCredits).not.toHaveBeenCalled();
      }
    });

    it('stops all payouts when the budget is 0', async () => {
      givenSettings({ BedrockNewsRewardsDailyBudget: '0' });

      await expect(grantPuzzleReward(INPUT)).resolves.toEqual({ ok: false, status: 403, code: 'BUDGET_EXHAUSTED' });
      expect(mockAddCredits).not.toHaveBeenCalled();
    });
  });

  describe('eligibility', () => {
    it('is 404 for a user that does not exist', async () => {
      givenUser(null);

      await expect(grantPuzzleReward(INPUT)).resolves.toEqual({ ok: false, status: 404, code: 'USER_NOT_FOUND' });
      expect(mockAddCredits).not.toHaveBeenCalled();
    });

    it.each([
      ['has no emailVerified field', { currentCredits: 5 }],
      ['has not verified the email', { emailVerified: false, currentCredits: 5 }],
      ['is synthetic', { ...eligibleUser, isSynthetic: true }],
      ['is deleted', { ...eligibleUser, deletedAt: new Date() }],
      ['is banned', { ...eligibleUser, isBanned: true }],
      ['has a chargeback pending', { ...eligibleUser, disputePending: true }],
      ['is suspended', { ...eligibleUser, moderation: { status: 'suspended' } }],
      ['is pending suspension', { ...eligibleUser, moderation: { status: 'suspend_pending' } }],
    ])('is 403 when the user %s', async (_label, user) => {
      givenUser(user);

      await expect(grantPuzzleReward(INPUT)).resolves.toEqual({ ok: false, status: 403, code: 'USER_NOT_ELIGIBLE' });
      expect(mockGetSettingsMap).not.toHaveBeenCalled();
      expect(mockAddCredits).not.toHaveBeenCalled();
    });

    it('still pays a throttled user', async () => {
      givenUser({ ...eligibleUser, moderation: { status: 'throttled' } });

      await expect(grantPuzzleReward(INPUT)).resolves.toMatchObject({ granted: true });
    });
  });

  it('answers granted true with 0 credits and writes nothing when the rung pays 0', async () => {
    givenSettings({ BedrockNewsPuzzleCredits5: '0' });

    const result = await grantPuzzleReward(INPUT);

    expect(result).toEqual({ ok: true, granted: true, credits: 0, balance: 1000, firstSolveCredits: 0 });
    expect(mockAddCredits).not.toHaveBeenCalled();
  });
});
