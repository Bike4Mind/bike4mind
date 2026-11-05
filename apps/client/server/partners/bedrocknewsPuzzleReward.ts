import { CreditHolderType, isSignupGrantBlocked, settingsMap, type SettingKey } from '@bike4mind/common';
import {
  adminSettingsRepository,
  CreditTransaction,
  creditLotRepository,
  creditTransactionRepository,
  User,
  userRepository,
} from '@bike4mind/database';
import { creditService } from '@bike4mind/services';
import { accountBlockReasons, type AccountStateFields } from '@bike4mind/services/userService/accountState';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';

export const BEDROCKNEWS_PUZZLE_REASON = 'bedrocknews_puzzle_reward';
export const BEDROCKNEWS_FIRST_SOLVE_REASON = 'bedrocknews_first_solve';

const DAY_MS = 24 * 60 * 60 * 1000;

export type PuzzleTier = 5 | 6 | 7;

export interface GrantPuzzleRewardInput {
  userId: string;
  puzzleDate: string;
  tier: PuzzleTier;
  hard: boolean;
}

export type GrantPuzzleRewardResult =
  | { ok: true; granted: boolean; credits: number; balance: number; firstSolveCredits: number }
  | { ok: false; status: 404 | 403; code: 'USER_NOT_FOUND' | 'USER_NOT_ELIGIBLE' | 'DAILY_CAP' | 'BUDGET_EXHAUSTED' };

const TIER_CREDITS_SETTING = {
  5: 'BedrockNewsPuzzleCredits5',
  6: 'BedrockNewsPuzzleCredits6',
  7: 'BedrockNewsPuzzleCredits7',
} as const satisfies Record<PuzzleTier, SettingKey>;

const SETTING_NAMES = [
  ...Object.values(TIER_CREDITS_SETTING),
  'BedrockNewsPuzzleHardMultiplier',
  'BedrockNewsFirstSolveCredits',
  'BedrockNewsPuzzleDailyCap',
  'BedrockNewsRewardsDailyBudget',
] as const satisfies readonly SettingKey[];

type RewardSettingKey = (typeof SETTING_NAMES)[number];

type RewardUser = {
  emailVerified?: boolean | null;
  isSynthetic?: boolean | null;
  deletedAt?: Date | null;
  currentCredits?: number | null;
  signupGrant?: { blocked?: { at: Date } } | null;
} & AccountStateFields;

// suspend_pending is not an accountBlockReason; a money path refuses it too.
const isPayable = (user: RewardUser) =>
  !!user.emailVerified &&
  !user.isSynthetic &&
  !user.deletedAt &&
  accountBlockReasons(user).length === 0 &&
  !isSignupGrantBlocked(user) &&
  user.moderation?.status !== 'suspend_pending';

const LEDGER_ADAPTERS = {
  db: { creditTransactions: creditTransactionRepository, creditLots: creditLotRepository },
  creditHolderMethods: userRepository,
};

async function sumCredits(match: Record<string, unknown>): Promise<number> {
  const [row] = await CreditTransaction.aggregate<{ total: number }>([
    { $match: { ownerType: CreditHolderType.User, type: 'generic_add', ...match } },
    { $group: { _id: null, total: { $sum: '$credits' } } },
  ]);
  return row?.total ?? 0;
}

async function storedCredits(transactionId: string): Promise<number> {
  const row = await CreditTransaction.findOne({ transactionId }).select('credits').lean<{ credits: number }>();
  return row?.credits ?? 0;
}

async function currentBalance(userId: string): Promise<number> {
  const user = await User.findById(userId).select('currentCredits').lean<RewardUser>();
  return user?.currentCredits ?? 0;
}

/**
 * The ledger row's transactionId is the only idempotency gate. A replay is answered before the
 * eligibility check and the caps, so neither a later account block nor a cap the first payout already
 * consumed can turn a retry of a paid rung into a refusal.
 */
export async function grantPuzzleReward({
  userId,
  puzzleDate,
  tier,
  hard,
}: GrantPuzzleRewardInput): Promise<GrantPuzzleRewardResult> {
  const user = await User.findById(userId)
    .select(
      'emailVerified isSynthetic deletedAt isBanned disputePending moderation.status currentCredits signupGrant.blocked'
    )
    .lean<RewardUser>();
  if (!user) return { ok: false, status: 404, code: 'USER_NOT_FOUND' };

  const transactionId = `bedrocknews-puzzle:${userId}:${puzzleDate}:${tier}`;
  const replayed = await CreditTransaction.findOne({ transactionId }).select('credits').lean<{ credits: number }>();
  if (replayed) {
    return {
      ok: true,
      granted: false,
      credits: replayed.credits,
      balance: user.currentCredits ?? 0,
      firstSolveCredits: 0,
    };
  }
  if (!isPayable(user)) return { ok: false, status: 403, code: 'USER_NOT_ELIGIBLE' };

  const settings = await getSettingsMap(
    { adminSettings: adminSettingsRepository },
    { names: [...SETTING_NAMES], skipCache: true }
  );
  const setting = (key: RewardSettingKey) => getSettingsValue(key, settings, settingsMap[key].schema.parse(undefined));
  const tierCredits = setting(TIER_CREDITS_SETTING[tier]);
  const multiplier = setting('BedrockNewsPuzzleHardMultiplier');
  const amount = Math.round(tierCredits * (hard ? multiplier : 1));
  if (amount <= 0) {
    return { ok: true, granted: true, credits: 0, balance: user.currentCredits ?? 0, firstSolveCredits: 0 };
  }

  // A row for puzzleDate cannot predate that UTC day; the bound keeps the scan off older ledger rows.
  const paidOnDate = await sumCredits({
    ownerId: userId,
    reason: BEDROCKNEWS_PUZZLE_REASON,
    'metadata.puzzleDate': puzzleDate,
    createdAt: { $gte: new Date(`${puzzleDate}T00:00:00.000Z`) },
  });
  if (paidOnDate + amount > setting('BedrockNewsPuzzleDailyCap')) {
    return { ok: false, status: 403, code: 'DAILY_CAP' };
  }

  // The bonus counts toward the budget too, but only for a player who has not been paid it yet.
  const firstSolveTransactionId = `bedrocknews-first-solve:${userId}`;
  const bonusPaid = await CreditTransaction.findOne({ transactionId: firstSolveTransactionId }).select('_id').lean();
  const bonus = bonusPaid ? 0 : setting('BedrockNewsFirstSolveCredits');
  const paidInWindow = await sumCredits({
    reason: { $in: [BEDROCKNEWS_PUZZLE_REASON, BEDROCKNEWS_FIRST_SOLVE_REASON] },
    createdAt: { $gte: new Date(Date.now() - DAY_MS) },
  });
  if (paidInWindow + amount + bonus > setting('BedrockNewsRewardsDailyBudget')) {
    return { ok: false, status: 403, code: 'BUDGET_EXHAUSTED' };
  }

  // The bonus is written before the rung: a failed rung write leaves the rung unpaid, so the caller's
  // retry pays it, whereas a bonus written after a paid rung would be lost to the replay branch.
  let firstSolveCredits = 0;
  if (bonus > 0) {
    const bonusWrite = await creditService.addCreditsWithLedgerRow(
      {
        ownerId: userId,
        ownerType: CreditHolderType.User,
        type: 'generic_add',
        credits: bonus,
        reason: BEDROCKNEWS_FIRST_SOLVE_REASON,
        transactionId: firstSolveTransactionId,
        description: 'Headword: first solved word bonus',
        metadata: { product: 'bedrocknews', game: 'headword', puzzleDate, tier },
      },
      LEDGER_ADAPTERS
    );
    if (bonusWrite.creditTransactionId) firstSolveCredits = bonus;
  }

  const puzzleWrite = await creditService.addCreditsWithLedgerRow(
    {
      ownerId: userId,
      ownerType: CreditHolderType.User,
      type: 'generic_add',
      credits: amount,
      reason: BEDROCKNEWS_PUZZLE_REASON,
      transactionId,
      description: `Headword: solved the ${tier}-letter word on ${puzzleDate}`,
      metadata: { product: 'bedrocknews', game: 'headword', puzzleDate, tier, hard },
    },
    LEDGER_ADAPTERS
  );
  if (!puzzleWrite.creditTransactionId) {
    return {
      ok: true,
      granted: false,
      credits: await storedCredits(transactionId),
      balance: await currentBalance(userId),
      firstSolveCredits,
    };
  }

  return { ok: true, granted: true, credits: amount, balance: await currentBalance(userId), firstSolveCredits };
}
