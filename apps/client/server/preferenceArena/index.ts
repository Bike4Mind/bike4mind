import {
  NO_CARD_UNLOCK_REASONS,
  noCardUnlockTransactionId,
  type NoCardUnlockReason,
  type PreferenceArenaSettings,
  resolvePreferenceArenaSettings,
} from '@bike4mind/common';
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

/** The no-card unlock proves GitHub or work email only through its ledger row; it never stamps signupGrant. */
async function loadNoCardUnlocks(userId: string): Promise<NoCardUnlockReason[]> {
  const rows = await Promise.all(
    NO_CARD_UNLOCK_REASONS.map(reason =>
      creditTransactionRepository.findOne({ transactionId: noCardUnlockTransactionId(reason, userId) })
    )
  );
  return NO_CARD_UNLOCK_REASONS.filter((_, index) => rows[index] !== null);
}

export async function loadArenaUser(userId: string): Promise<ArenaUser | null> {
  const [user, noCardUnlocks] = await Promise.all([
    User.findById(userId)
      .select('emailVerified isSynthetic deletedAt signupGrant isBanned disputePending moderation.status')
      .lean<ArenaUser>(),
    loadNoCardUnlocks(userId),
  ]);
  return user && { ...user, noCardUnlocks };
}

export function getArenaService(logger: Pick<Logger, 'error' | 'warn'>) {
  return createArenaService({
    pairs: arenaPairRepository,
    votes: arenaVoteRepository,
    loadUser: loadArenaUser,
    loadSettings: loadArenaSettings,
    findPaidCredits: async transactionId =>
      (await creditTransactionRepository.findOne({ transactionId }))?.credits ?? null,
    addCredits: creditService.addCreditsWithLedgerRow,
    creditAdapters: {
      db: { creditTransactions: creditTransactionRepository, creditLots: creditLotRepository },
      creditHolderMethods: userRepository,
    },
    logger,
  });
}
