import { z } from 'zod';
import type { NoCardUnlockReason } from './noCardUnlock';
import type { SignupGrant, SignupGrantUnlockReason } from './signupGrant';

/**
 * Preference arena: verified users judge which of two model answers is better and earn a small,
 * capped promotional reward per accepted vote. The mechanism is open; the gold-question set and the
 * thresholds live in the database and admin settings, never in this repo.
 */

export const ARENA_CHOICES = ['a', 'b', 'tie'] as const;
export type ArenaChoice = (typeof ARENA_CHOICES)[number];

export const ARENA_PAIR_SOURCES = ['synthetic', 'opt_in'] as const;
export type ArenaPairSource = (typeof ARENA_PAIR_SOURCES)[number];

/**
 * Signup-grant unlocks that prove a human behind the account; activity, org-invite and admin unlocks
 * do not. GitHub and work-email proof comes from the no-card unlock's ledger row instead, which never
 * stamps the signup grant (see `grantNoCardUnlock` in services/userService/noCardUnlock.ts).
 */
export const ARENA_VERIFIED_UNLOCK_REASONS: readonly SignupGrantUnlockReason[] = ['card_verified', 'phone_verified'];

export type ArenaIneligibleReason = 'disabled' | 'unverified' | 'blocked';

export type ArenaRejectReason =
  | 'rewards_off'
  | 'too_fast'
  | 'gold_missed'
  | 'unqualified'
  | 'low_gold_accuracy'
  | 'daily_cap'
  | 'lifetime_cap'
  /** The vote earned but the credit write threw; kept countable so it can be reconciled. */
  | 'grant_failed';

export const PREFERENCE_ARENA_REWARD_REASON = 'preference_arena_vote';

export function arenaVoteTransactionId(voteId: string): string {
  return `arena-vote:${voteId}`;
}

export interface PreferenceArenaSettings {
  enabled: boolean;
  /** 0 keeps the arena collecting votes with rewards dormant. */
  creditsPerVote: number;
  dailyVoteCap: number;
  lifetimeCreditCap: number;
  minResponseMs: number;
  /** Percent of served pairs drawn from the gold set. */
  goldRatePercent: number;
  /** Gold answers a rater must give before any vote can earn. */
  minGoldVotes: number;
  minGoldAccuracyPercent: number;
}

/**
 * Defaults for the quality gates, applied when an admin has never set them. The admin settings
 * schema reads these too, so the value an admin sees is the value the judge uses. Money settings
 * (credits per vote, caps) have no default here: unset means rewards off.
 */
export const ARENA_QUALITY_DEFAULTS = {
  minResponseMs: 4000,
  goldRatePercent: 20,
  minGoldVotes: 3,
  minGoldAccuracyPercent: 80,
} as const;

function isUnset(raw: unknown): boolean {
  return raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '');
}

function parseNonNegativeInt(raw: unknown): number {
  const n = typeof raw === 'string' ? (raw.trim() === '' ? NaN : Number(raw)) : raw;
  return typeof n === 'number' && Number.isSafeInteger(n) && n > 0 ? n : 0;
}

function parsePercent(raw: unknown): number {
  return Math.min(100, parseNonNegativeInt(raw));
}

function parseFlag(raw: unknown): boolean {
  return raw === true || (typeof raw === 'string' && raw.trim().toLowerCase() === 'true');
}

/** Unset quality gates take ARENA_QUALITY_DEFAULTS; malformed values resolve to 0, which keeps rewards off. */
export function resolvePreferenceArenaSettings(adminSettings: Record<string, unknown>): PreferenceArenaSettings {
  return {
    enabled: parseFlag(adminSettings.preferenceArenaEnabled),
    creditsPerVote: parseNonNegativeInt(adminSettings.preferenceArenaCreditsPerVote),
    dailyVoteCap: parseNonNegativeInt(adminSettings.preferenceArenaDailyVoteCap),
    lifetimeCreditCap: parseNonNegativeInt(adminSettings.preferenceArenaLifetimeCreditCap),
    minResponseMs: isUnset(adminSettings.preferenceArenaMinResponseMs)
      ? ARENA_QUALITY_DEFAULTS.minResponseMs
      : parseNonNegativeInt(adminSettings.preferenceArenaMinResponseMs),
    goldRatePercent: isUnset(adminSettings.preferenceArenaGoldRatePercent)
      ? ARENA_QUALITY_DEFAULTS.goldRatePercent
      : parsePercent(adminSettings.preferenceArenaGoldRatePercent),
    minGoldVotes: isUnset(adminSettings.preferenceArenaMinGoldVotes)
      ? ARENA_QUALITY_DEFAULTS.minGoldVotes
      : parseNonNegativeInt(adminSettings.preferenceArenaMinGoldVotes),
    minGoldAccuracyPercent: isUnset(adminSettings.preferenceArenaMinGoldAccuracyPercent)
      ? ARENA_QUALITY_DEFAULTS.minGoldAccuracyPercent
      : parsePercent(adminSettings.preferenceArenaMinGoldAccuracyPercent),
  };
}

export interface ArenaEligibilityFields {
  emailVerified?: boolean | null;
  isSynthetic?: boolean | null;
  deletedAt?: Date | null;
  signupGrant?: Pick<SignupGrant, 'stage' | 'unlockedBy'> | null;
  /** No-card unlocks this user holds a ledger row for. */
  noCardUnlocks?: readonly NoCardUnlockReason[];
}

/** Account-block checks (ban, dispute, suspension) are the caller's, via `accountBlockReasons`. */
export function isArenaVerifiedUser(user: ArenaEligibilityFields): boolean {
  if (!user.emailVerified || user.isSynthetic || user.deletedAt) return false;
  if ((user.noCardUnlocks?.length ?? 0) > 0) return true;
  const grant = user.signupGrant;
  return grant?.stage === 'unlocked' && !!grant.unlockedBy && ARENA_VERIFIED_UNLOCK_REASONS.includes(grant.unlockedBy);
}

export interface ArenaVoteContext {
  settings: PreferenceArenaSettings;
  responseMs: number;
  /** null when the pair is not a gold question. */
  goldCorrect: boolean | null;
  /** The rater's gold record, including this vote. */
  goldAnswered: number;
  goldCorrectTotal: number;
  /** Credited votes today and credits earned so far, excluding this vote. */
  creditedVotesToday: number;
  creditsEarnedLifetime: number;
}

export type ArenaVoteJudgement = { accepted: true; credits: number } | { accepted: false; reason: ArenaRejectReason };

/**
 * Every quality gate must be set before any vote earns: a 0 response floor or accuracy bar would
 * otherwise wave bots through, so an unset gate keeps rewards off instead of opening them.
 */
export function arenaRewardsConfigured(settings: PreferenceArenaSettings): boolean {
  return (
    settings.creditsPerVote > 0 &&
    settings.dailyVoteCap > 0 &&
    settings.lifetimeCreditCap > 0 &&
    settings.minResponseMs > 0 &&
    settings.minGoldVotes > 0 &&
    settings.minGoldAccuracyPercent > 0
  );
}

export interface ArenaGoldRecord {
  answered: number;
  correct: number;
}

export type ArenaRaterStanding = 'unqualified' | 'qualified' | 'flagged';

/** The one definition of a rater's standing, shared by the vote judge and the routing stats. */
export function arenaRaterStanding(gold: ArenaGoldRecord, settings: PreferenceArenaSettings): ArenaRaterStanding {
  if (settings.minGoldVotes <= 0 || gold.answered < settings.minGoldVotes) return 'unqualified';
  return (gold.correct / gold.answered) * 100 >= settings.minGoldAccuracyPercent ? 'qualified' : 'flagged';
}

/** Pure: decides whether a recorded vote earns. The vote is kept for routing data either way. */
export function judgeArenaVote(context: ArenaVoteContext): ArenaVoteJudgement {
  const { settings } = context;
  if (!arenaRewardsConfigured(settings)) return { accepted: false, reason: 'rewards_off' };
  if (context.responseMs < settings.minResponseMs) return { accepted: false, reason: 'too_fast' };
  if (context.goldCorrect === false) return { accepted: false, reason: 'gold_missed' };
  const standing = arenaRaterStanding({ answered: context.goldAnswered, correct: context.goldCorrectTotal }, settings);
  if (standing === 'unqualified') return { accepted: false, reason: 'unqualified' };
  if (standing === 'flagged') return { accepted: false, reason: 'low_gold_accuracy' };
  if (context.creditedVotesToday >= settings.dailyVoteCap) return { accepted: false, reason: 'daily_cap' };
  const credits = Math.min(settings.creditsPerVote, settings.lifetimeCreditCap - context.creditsEarnedLifetime);
  if (credits <= 0) return { accepted: false, reason: 'lifetime_cap' };
  return { accepted: true, credits };
}

/** A served pair as the rater sees it: blind (no model ids) and already in the rater's A/B order. */
export interface ArenaPairView {
  pairId: string;
  prompt: string;
  taskType: string;
  answerA: string;
  answerB: string;
}

export type ArenaNextResponse =
  | { status: 'ready'; pair: ArenaPairView }
  | { status: 'empty' }
  | { status: 'ineligible'; reason: ArenaIneligibleReason };

export const arenaVoteRequestSchema = z.object({
  pairId: z.string().regex(/^[0-9a-f]{24}$/i),
  choice: z.enum(ARENA_CHOICES),
});
export type ArenaVoteRequest = z.infer<typeof arenaVoteRequestSchema>;

/** Rejection reasons are deliberately absent: low-quality raters are dropped silently. */
export interface ArenaVoteResponse {
  creditsAwarded: number;
}

const arenaAnswerSchema = z.object({
  modelId: z.string().trim().min(1).max(200),
  text: z.string().trim().min(1).max(20_000),
});

export const arenaPairImportSchema = z.object({
  prompt: z.string().trim().min(1).max(10_000),
  taskType: z.string().trim().min(1).max(64),
  source: z.enum(ARENA_PAIR_SOURCES),
  answers: z.tuple([arenaAnswerSchema, arenaAnswerSchema]),
  /** Present only for gold questions: the answer a careful human picks. */
  goldChoice: z.enum(['a', 'b']).optional(),
});
export type ArenaPairImport = z.infer<typeof arenaPairImportSchema>;

export const arenaPairImportRequestSchema = z.object({
  pairs: z.array(arenaPairImportSchema).min(1).max(500),
});

export interface ArenaModelWinRate {
  taskType: string;
  modelId: string;
  wins: number;
  losses: number;
  ties: number;
}

export interface ArenaStats {
  pairs: { total: number; gold: number; active: number };
  votes: { total: number; credited: number; creditsAwarded: number };
  raters: { total: number; qualified: number; flagged: number };
  rejections: Partial<Record<ArenaRejectReason, number>>;
  winRates: ArenaModelWinRate[];
}
