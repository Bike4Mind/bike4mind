import type { IAdminSettingsRepository } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import {
  getSettingsMap,
  getSettingsValue,
  MUSIC_GENERATION_TIMEOUT_MS,
  SOUND_GENERATION_TIMEOUT_MS,
} from '@bike4mind/utils';
import { type ProviderSlotStore, runWithProviderCapacity } from './runWithProviderCapacity';

export type ElevenLabsOperation = 'music' | 'sound';

// The budget is the generator's own fetch deadline, which is already sized under the 60s serving
// cap (see MUSIC_GENERATION_TIMEOUT_MS) - waiting for capacity spends it rather than extending it.
// minAttemptMs is the shortest provider call worth starting: a track needs longer than a clip.
// The budgets are getters so the utils constants are read per call, not at module load: this module is
// re-exported from @bike4mind/services, and suites that partially mock @bike4mind/utils would fail to load.
const OPERATIONS = {
  music: {
    limitSetting: 'elevenLabsMusicConcurrencyLimit',
    get budgetMs() {
      return MUSIC_GENERATION_TIMEOUT_MS;
    },
    minAttemptMs: 25_000,
  },
  sound: {
    limitSetting: 'elevenLabsSoundConcurrencyLimit',
    get budgetMs() {
      return SOUND_GENERATION_TIMEOUT_MS;
    },
    minAttemptMs: 15_000,
  },
} as const;

const MAX_SLOT_WAIT_MS = 15_000;
const MAX_RATE_LIMIT_RETRIES = 2;

export type ElevenLabsCapacityArgs = {
  operation: ElevenLabsOperation;
  /** The key the call will use, as resolved by getEffectiveApiKey. */
  apiKey: string;
  db: {
    adminSettings: Pick<IAdminSettingsRepository, 'findAll' | 'findBySettingNames'>;
    /** Absent on hosts that do not wire the semaphore: the call then runs unslotted, still retrying 429s. */
    caches?: ProviderSlotStore;
  };
  logger: Logger;
};

/**
 * Slots synchronous ElevenLabs music/sound calls on the shared server key, so the account's
 * concurrency cap is shared across users instead of surfacing as a provider 429. A personal key is
 * the user's own account and is not counted. Callers: /api/ai/music, /api/ai/sound-effects and the
 * audio_generation tool. Not slotted: the async music generation jobs (which retry 429 per job) and
 * text-to-speech, so these pools bound only the calls routed here.
 */
export async function runElevenLabsWithCapacity<T>(
  { operation, apiKey, db, logger }: ElevenLabsCapacityArgs,
  attempt: (call: { timeoutMs: number }) => Promise<T>
): Promise<T> {
  const config = OPERATIONS[operation];
  // Uncached, like getEffectiveApiKey's read of the same key: a cached copy would miss a rotated server
  // key for the cache TTL and silently run every shared-key call unslotted until it expired.
  const settings = await getSettingsMap(db, {
    names: ['elevenLabsServerApiKey', config.limitSetting],
    skipCache: true,
  });
  const usesServerKey = Boolean(settings.elevenLabsServerApiKey) && settings.elevenLabsServerApiKey === apiKey;
  const slots =
    usesServerKey && db.caches
      ? {
          store: db.caches,
          key: `provider-slots:elevenlabs:${operation}`,
          // The schema already prefaults to the plan default; `?? 1` only narrows the type, conservatively.
          limit: getSettingsValue(config.limitSetting, settings) ?? 1,
        }
      : undefined;

  return runWithProviderCapacity(
    {
      provider: 'elevenlabs',
      logger,
      slots,
      budgetMs: config.budgetMs,
      maxSlotWaitMs: MAX_SLOT_WAIT_MS,
      minAttemptMs: config.minAttemptMs,
      maxRetries: MAX_RATE_LIMIT_RETRIES,
    },
    attempt
  );
}
