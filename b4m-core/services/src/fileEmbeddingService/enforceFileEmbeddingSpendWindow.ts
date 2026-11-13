import {
  FILE_EMBEDDING_USER_BUDGET_PER_WINDOW_USD_DEFAULT,
  FILE_EMBEDDING_USER_BUDGET_PER_WINDOW_USD_MAX,
  FILE_EMBEDDING_USER_TOKENS_PER_WINDOW_DEFAULT,
  FILE_EMBEDDING_USER_TOKENS_PER_WINDOW_MAX,
  FILE_EMBEDDING_USER_WINDOW_HOURS_DEFAULT,
  FILE_EMBEDDING_USER_WINDOW_HOURS_MAX,
  IAdminSettingsRepository,
  ICacheRepository,
  SettingKey,
} from '@bike4mind/common';
import { getSettingsByNames } from '@bike4mind/utils';
import { z } from 'zod';
import { Logger } from '@bike4mind/observability';
import { parseNumericSetting } from '../settings/parseNumericSetting';

const HOUR_MS = 3_600_000;
const MICRO_USD_PER_USD = 1_000_000;

export const FILE_EMBEDDING_LIMIT_KEYS = [
  'fileEmbeddingUserBudgetPerWindowUsd',
  'fileEmbeddingUserTokensPerWindow',
  'fileEmbeddingUserWindowHours',
] as const satisfies readonly SettingKey[];

export const fileEmbeddingWindowCacheKeys = (userId: string) => ({
  microUsd: `fileEmbeddingSpend:user:${userId}:microUsd`,
  tokens: `fileEmbeddingSpend:user:${userId}:tokens`,
});

const fileEmbeddingHoldCacheKey = (userId: string, reservationId: string) =>
  `fileEmbeddingSpend:user:${userId}:hold:${reservationId}`;

/** What one reservation took from each window, kept so a redelivery of the same work reuses it. */
const HoldSchema = z.object({
  tokens: z.number(),
  microUsd: z.number(),
  tokensWindowExpiresAt: z.coerce.date(),
  microUsdWindowExpiresAt: z.coerce.date(),
});
type Hold = z.infer<typeof HoldSchema>;

export interface FileEmbeddingLimits {
  budgetPerWindowMicroUsd: number;
  tokensPerWindow: number;
  windowHours: number;
}

export interface FileEmbeddingWindowDb {
  adminSettings: Pick<IAdminSettingsRepository, 'findBySettingNames' | 'findAll'>;
  cache: Pick<
    ICacheRepository,
    | 'tryAddWithinLimitFixedWindow'
    | 'releaseFromFixedWindow'
    | 'claimDedup'
    | 'readDedup'
    | 'deleteByKey'
    | 'deleteByKeyAndReturn'
  >;
}

/** The settings could not be read or hold an invalid value. Not a denial: the caller retries. */
export class FileEmbeddingLimitResolutionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'FileEmbeddingLimitResolutionError';
  }
}

export interface FileEmbeddingWindowGrant {
  release: () => Promise<void>;
}

export type FileEmbeddingDenialReason = 'paused' | 'exhausted' | 'oversized';

/**
 * A deterministic refusal: retrying inside the same window cannot succeed, so a queue consumer
 * should mark the file failed with this message (it is written for the file's owner) and consume.
 */
export class FileEmbeddingSpendDeniedError extends Error {
  readonly reason: FileEmbeddingDenialReason;
  /** When the user's window closes. Set only for `exhausted`, the one reason that clears on its own. */
  readonly resetsAt?: Date;

  constructor(reason: FileEmbeddingDenialReason, windowHours: number, resetsAt?: Date) {
    super(denialMessage(reason, windowHours, resetsAt));
    this.name = 'FileEmbeddingSpendDeniedError';
    this.reason = reason;
    this.resetsAt = reason === 'exhausted' ? resetsAt : undefined;
  }
}

// The message is stored on the file and read by its owner, so it carries a readable UTC time
// rather than an ISO timestamp.
const RESET_TIME_FORMAT = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'UTC',
});
const formatResetTime = (at: Date) => `${RESET_TIME_FORMAT.format(at)} UTC`;

function denialMessage(reason: FileEmbeddingDenialReason, windowHours: number, resetsAt?: Date): string {
  switch (reason) {
    case 'paused':
      return 'File indexing was not run: indexing files outside a data lake is paused by an administrator.';
    case 'oversized':
      return (
        `File indexing was not run: this file needs more embedding than one account may use in a ` +
        `${windowHours}-hour window. Split the file, or ask an administrator to raise the file indexing limit.`
      );
    case 'exhausted':
      return (
        `File indexing was not run: this account reached its file indexing limit for the current ` +
        `${windowHours}-hour window. Re-index the file after ${resetsAt ? formatResetTime(resetsAt) : 'the window resets'}.`
      );
  }
}

export async function resolveFileEmbeddingLimits(
  db: Pick<FileEmbeddingWindowDb, 'adminSettings'>,
  logger?: Logger
): Promise<FileEmbeddingLimits> {
  try {
    const values = await getSettingsByNames([...FILE_EMBEDDING_LIMIT_KEYS], db, { logger });
    const budgetUsd = parseNumericSetting(
      values.fileEmbeddingUserBudgetPerWindowUsd,
      {
        key: 'fileEmbeddingUserBudgetPerWindowUsd',
        fallback: FILE_EMBEDDING_USER_BUDGET_PER_WINDOW_USD_DEFAULT,
        min: 0,
        max: FILE_EMBEDDING_USER_BUDGET_PER_WINDOW_USD_MAX,
      },
      logger
    );
    return {
      budgetPerWindowMicroUsd: Math.floor(budgetUsd * MICRO_USD_PER_USD),
      tokensPerWindow: parseNumericSetting(
        values.fileEmbeddingUserTokensPerWindow,
        {
          key: 'fileEmbeddingUserTokensPerWindow',
          fallback: FILE_EMBEDDING_USER_TOKENS_PER_WINDOW_DEFAULT,
          min: 0,
          max: FILE_EMBEDDING_USER_TOKENS_PER_WINDOW_MAX,
          int: true,
        },
        logger
      ),
      windowHours: parseNumericSetting(
        values.fileEmbeddingUserWindowHours,
        {
          key: 'fileEmbeddingUserWindowHours',
          fallback: FILE_EMBEDDING_USER_WINDOW_HOURS_DEFAULT,
          min: 1,
          max: FILE_EMBEDDING_USER_WINDOW_HOURS_MAX,
          int: true,
        },
        logger
      ),
    };
  } catch (err) {
    throw new FileEmbeddingLimitResolutionError('could not resolve file embedding limits; halting (fail closed)', {
      cause: err,
    });
  }
}

/**
 * Reserve one user's non-lake file embedding against two per-user windows (tokens and micro-USD),
 * or throw {@link FileEmbeddingSpendDeniedError}. Reserve-first through the cache's atomic
 * fixed-window counter, so concurrent messages for one user cannot jointly overshoot. Applies
 * whether or not the embedding is billed to the user; the lake path has its own gate
 * (`dataLakeService.enforceEmbeddingSpendGate`).
 *
 * `reservationId` names the work (e.g. the file plus its uncached content). A later call with the
 * same id inside the window reuses the earlier reservation instead of taking a second one, so a
 * redelivery after a crash between reserve and release does not pay twice and is never refused
 * for the window it already paid into.
 *
 * Returns a grant whose `release` gives the reservation back; the caller releases only when the
 * embedding it was reserved for never ran (a provider or pre-embed failure). When the tokens
 * window grants and the USD window denies, the token reservation is given back here.
 */
export async function enforceFileEmbeddingSpendWindow(params: {
  userId: string;
  reservationId: string;
  estimatedMicroUsd: number;
  estimatedTokens: number;
  db: FileEmbeddingWindowDb;
  logger?: Logger;
}): Promise<FileEmbeddingWindowGrant> {
  const { userId, reservationId, estimatedMicroUsd, estimatedTokens, db, logger } = params;
  const limits = await resolveFileEmbeddingLimits(db, logger);
  const deny = (reason: FileEmbeddingDenialReason, resetsAt?: Date): never => {
    logger?.warn?.('file-embedding-window-denied', { userId, reason, estimatedTokens, estimatedMicroUsd });
    throw new FileEmbeddingSpendDeniedError(reason, limits.windowHours, resetsAt);
  };

  if (limits.tokensPerWindow <= 0 || limits.budgetPerWindowMicroUsd <= 0) deny('paused');

  const keys = fileEmbeddingWindowCacheKeys(userId);
  const holdKey = fileEmbeddingHoldCacheKey(userId, reservationId);
  const grantFor = (): FileEmbeddingWindowGrant => ({
    release: async () => {
      // Redeliveries and the loser of a concurrent claim hold a grant over the same hold; taking it
      // atomically first means only one of them gives the windows back.
      const taken = await db.cache.deleteByKeyAndReturn(holdKey);
      if (!taken) return;
      const parsed = HoldSchema.safeParse(taken.result);
      if (!parsed.success) return;
      const hold = parsed.data;
      // Both releases are attempted even when one fails; on a failure the hold is put back, so a
      // redelivery after a failed release still reuses it rather than reserving again.
      const results = await Promise.allSettled([
        db.cache.releaseFromFixedWindow(keys.tokens, hold.tokens, hold.tokensWindowExpiresAt),
        db.cache.releaseFromFixedWindow(keys.microUsd, hold.microUsd, hold.microUsdWindowExpiresAt),
      ]);
      const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (failed) {
        const remainingMs = taken.expiresAt.getTime() - Date.now();
        if (remainingMs > 0) {
          await db.cache
            .claimDedup(holdKey, hold, remainingMs)
            .catch(restoreErr =>
              logger?.warn?.('file-embedding-window-hold-restore-failed', { userId, error: String(restoreErr) })
            );
        }
        throw failed.reason;
      }
    },
  });

  const prior = HoldSchema.safeParse(await db.cache.readDedup(holdKey));
  if (prior.success) {
    logger?.log?.('file-embedding-window-reused', { userId, reservationId });
    return grantFor();
  }

  if (estimatedTokens > limits.tokensPerWindow || estimatedMicroUsd > limits.budgetPerWindowMicroUsd) {
    deny('oversized');
  }

  const ttlMs = limits.windowHours * HOUR_MS;
  const tokens = await db.cache.tryAddWithinLimitFixedWindow(
    keys.tokens,
    estimatedTokens,
    limits.tokensPerWindow,
    ttlMs
  );
  if (!tokens.success) deny('exhausted', tokens.expiresAt);
  const releaseTokens = () => db.cache.releaseFromFixedWindow(keys.tokens, estimatedTokens, tokens.expiresAt);
  let spend: Awaited<ReturnType<typeof db.cache.tryAddWithinLimitFixedWindow>>;
  try {
    spend = await db.cache.tryAddWithinLimitFixedWindow(
      keys.microUsd,
      estimatedMicroUsd,
      limits.budgetPerWindowMicroUsd,
      ttlMs
    );
  } catch (err) {
    await releaseTokens().catch(releaseErr =>
      logger?.warn?.('file-embedding-window-release-failed', { userId, error: String(releaseErr) })
    );
    throw err;
  }
  if (!spend.success) {
    // A failed rollback must not replace the terminal denial with a retried database error.
    await releaseTokens().catch(releaseErr =>
      logger?.warn?.('file-embedding-window-release-failed', { userId, error: String(releaseErr) })
    );
    deny('exhausted', spend.expiresAt);
  }

  const hold: Hold = {
    tokens: estimatedTokens,
    microUsd: estimatedMicroUsd,
    tokensWindowExpiresAt: tokens.expiresAt,
    microUsdWindowExpiresAt: spend.expiresAt,
  };
  const claim = await db.cache.claimDedup(holdKey, hold, ttlMs);
  if (claim.claimed) return grantFor();

  // A concurrent delivery of the same work recorded its reservation first: keep that one only.
  await releaseTokens();
  await db.cache.releaseFromFixedWindow(keys.microUsd, estimatedMicroUsd, spend.expiresAt);
  const winner = HoldSchema.safeParse(claim.existingData);
  return winner.success ? grantFor() : { release: async () => db.cache.deleteByKey(holdKey) };
}

/**
 * Admin remedy: empty one user's file embedding windows so indexing resumes before the window
 * rolls over. Returns what the windows held. Outstanding holds stay; releasing one after a reset
 * is a no-op, because a release only applies to the window that granted it.
 */
export async function resetFileEmbeddingSpendWindow(
  userId: string,
  db: { cache: Pick<ICacheRepository, 'findByKey' | 'deleteByKey'> }
): Promise<{ tokens: number; microUsd: number }> {
  const keys = fileEmbeddingWindowCacheKeys(userId);
  const countOf = async (key: string) => {
    const doc = await db.cache.findByKey(key);
    const live = doc != null && doc.expiresAt > new Date();
    const count = (doc?.result as { count?: unknown } | undefined)?.count;
    return live && typeof count === 'number' ? count : 0;
  };
  const before = { tokens: await countOf(keys.tokens), microUsd: await countOf(keys.microUsd) };
  await db.cache.deleteByKey(keys.tokens);
  await db.cache.deleteByKey(keys.microUsd);
  return before;
}
