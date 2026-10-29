import { type PreferenceArenaSettings, resolvePreferenceArenaSettings } from '@bike4mind/common';
import {
  adminSettingsRepository,
  arenaPairRepository,
  arenaVoteRepository,
  creditLotRepository,
  creditTransactionRepository,
  User,
  userRepository,
} from '@bike4mind/database';
import type { Logger } from '@bike4mind/observability';
import { creditService } from '@bike4mind/services';
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

async function loadArenaUser(userId: string): Promise<ArenaUser | null> {
  return User.findById(userId)
    .select('emailVerified isSynthetic deletedAt signupGrant isBanned disputePending moderation.status')
    .lean<ArenaUser>();
}

export function getArenaService(logger: Pick<Logger, 'error'>) {
  return createArenaService({
    pairs: arenaPairRepository,
    votes: arenaVoteRepository,
    loadUser: loadArenaUser,
    loadSettings: loadArenaSettings,
    addCredits: creditService.addCreditsWithLedgerRow,
    creditAdapters: {
      db: { creditTransactions: creditTransactionRepository, creditLots: creditLotRepository },
      creditHolderMethods: userRepository,
    },
    logger,
  });
}
