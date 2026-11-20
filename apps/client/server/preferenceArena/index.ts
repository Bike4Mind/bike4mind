import { type PreferenceArenaSettings, resolvePreferenceArenaSettings } from '@bike4mind/common';
import {
  adminSettingsRepository,
  arenaPairRepository,
  arenaVoteRepository,
  creditTransactionRepository,
  heldCreditRewardRepository,
  User,
} from '@bike4mind/database';
import type { Logger } from '@bike4mind/observability';
import { creditService } from '@bike4mind/services';
import { buildCreditRewardAdapters } from '@bike4mind/server-utils/credits/creditRewardAdapters';
import { getSettingsMap } from '@bike4mind/utils';
import { createArenaService, type ArenaUser } from './arenaService';

export { createArenaService } from './arenaService';
export type { ArenaService, AdminArenaPairRow } from './arenaService';

const SETTING_NAMES = [
  'preferenceArenaEnabled',
  'preferenceArenaCreditsPerVote',
  'preferenceArenaDailyVoteCap',
  'preferenceArenaLifetimeCreditCap',
  'preferenceArenaMinResponseMs',
  'preferenceArenaGoldRatePercent',
  'preferenceArenaMinGoldVotes',
  'preferenceArenaMinGoldAccuracyPercent',
] as const;

/** Bypasses the settings cache: the flag gates a money path and must reflect an admin write at once. */
export async function loadArenaSettings(): Promise<PreferenceArenaSettings> {
  const settings = await getSettingsMap(
    { adminSettings: adminSettingsRepository },
    { names: [...SETTING_NAMES], skipCache: true }
  );
  return resolvePreferenceArenaSettings(settings);
}

export async function loadArenaUser(userId: string): Promise<ArenaUser | null> {
  const user = await User.findById(userId)
    .select(
      'emailVerified isSynthetic deletedAt signupGrant isBanned disputePending moderation.status isModerated riskScore.reviewState'
    )
    .lean<ArenaUser>();
  return user ?? null;
}

/** The ledger's credits, else a queued or paused reward's (both can still pay); a voided reward owes nothing. */
export async function findOwedArenaCredits(
  transactionId: string
): Promise<{ credits: number; queued: boolean } | null> {
  const paid = await creditTransactionRepository.findOne({ transactionId });
  if (paid) return { credits: paid.credits, queued: false };
  const [held] = await heldCreditRewardRepository.findByTransactionIds([transactionId]);
  return held && (held.status === 'held' || held.status === 'paused') ? { credits: held.credits, queued: true } : null;
}

export function getArenaService(logger: Pick<Logger, 'error' | 'warn'>) {
  return createArenaService({
    pairs: arenaPairRepository,
    votes: arenaVoteRepository,
    loadUser: loadArenaUser,
    loadSettings: loadArenaSettings,
    findOwedCredits: findOwedArenaCredits,
    payReward: reward => creditService.payCreditReward(reward, buildCreditRewardAdapters()),
    logger,
  });
}
