import { z } from 'zod';
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

/** Only these unlocks prove a human behind the account; activity, org-invite and admin unlocks do not. */
export const ARENA_VERIFIED_UNLOCK_REASONS: readonly SignupGrantUnlockReason[] = [
  'card_verified',
  'phone_verified',
  'github_verified',
  'work_email_verified',
];

export type ArenaIneligibleReason = 'disabled' | 'unverified' | 'blocked';

export type ArenaRejectReason =
  'rewards_off' | 'too_fast' | 'gold_missed' | 'unqualified' | 'low_gold_accuracy' | 'daily_cap' | 'lifetime_cap';

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

/** Unset or malformed values resolve to disabled/0; a 0 cap earns nothing rather than everything. */
export function resolvePreferenceArenaSettings(adminSettings: Record<string, unknown>): PreferenceArenaSettings {
  return {
    enabled: parseFlag(adminSettings.preferenceArenaEnabled),
    creditsPerVote: parseNonNegativeInt(adminSettings.preferenceArenaCreditsPerVote),
    dailyVoteCap: parseNonNegativeInt(adminSettings.preferenceArenaDailyVoteCap),
    lifetimeCreditCap: parseNonNegativeInt(adminSettings.preferenceArenaLifetimeCreditCap),
    minResponseMs: parseNonNegativeInt(adminSettings.preferenceArenaMinResponseMs),
    goldRatePercent: parsePercent(adminSettings.preferenceArenaGoldRatePercent),
    minGoldVotes: parseNonNegativeInt(adminSettings.preferenceArenaMinGoldVotes),
    minGoldAccuracyPercent: parsePercent(adminSettings.preferenceArenaMinGoldAccuracyPercent),
  };
}

export interface ArenaEligibilityFields {
  emailVerified?: boolean | null;
  isSynthetic?: boolean | null;
  deletedAt?: Date | null;
  signupGrant?: Pick<SignupGrant, 'stage' | 'unlockedBy'> | null;
}

/** Account-block checks (ban, dispute, suspension) are the caller's, via `accountBlockReasons`. */
export function isArenaVerifiedUser(user: ArenaEligibilityFields): boolean {
  if (!user.emailVerified || user.isSynthetic || user.deletedAt) return false;
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

/** Pure: decides whether a recorded vote earns. The vote is kept for routing data either way. */
export function judgeArenaVote(context: ArenaVoteContext): ArenaVoteJudgement {
  const { settings } = context;
  if (settings.creditsPerVote <= 0) return { accepted: false, reason: 'rewards_off' };
  if (context.responseMs < settings.minResponseMs) return { accepted: false, reason: 'too_fast' };
  if (context.goldCorrect === false) return { accepted: false, reason: 'gold_missed' };
  if (settings.minGoldVotes <= 0 || context.goldAnswered < settings.minGoldVotes) {
    return { accepted: false, reason: 'unqualified' };
  }
  const accuracyPercent = (context.goldCorrectTotal / context.goldAnswered) * 100;
  if (accuracyPercent < settings.minGoldAccuracyPercent) return { accepted: false, reason: 'low_gold_accuracy' };
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
