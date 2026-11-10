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

export interface FileEmbeddingLimits {
  budgetPerWindowMicroUsd: number;
  tokensPerWindow: number;
  windowHours: number;
}

export interface FileEmbeddingWindowDb {
  adminSettings: Pick<IAdminSettingsRepository, 'findBySettingNames' | 'findAll'>;
  cache: Pick<ICacheRepository, 'tryAddWithinLimitFixedWindow' | 'releaseFromFixedWindow'>;
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
        `${windowHours}-hour window. Re-index the file after ${resetsAt?.toISOString() ?? 'the window resets'}.`
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
 * Returns a grant whose `release` gives both reservations back; the caller releases when a failure
 * is caught before the provider returns, so a retry does not reserve twice. A crash or timeout
 * mid-call, or a throw after the embed, skips the release and can reserve again on redelivery.
 * When the tokens window grants and the USD window denies, the token reservation is given back here.
 */
export async function enforceFileEmbeddingSpendWindow(params: {
  userId: string;
  estimatedMicroUsd: number;
  estimatedTokens: number;
  db: FileEmbeddingWindowDb;
  logger?: Logger;
}): Promise<FileEmbeddingWindowGrant> {
  const { userId, estimatedMicroUsd, estimatedTokens, db, logger } = params;
  const limits = await resolveFileEmbeddingLimits(db, logger);
  const deny = (reason: FileEmbeddingDenialReason, resetsAt?: Date): never => {
    logger?.warn?.('file-embedding-window-denied', { userId, reason, estimatedTokens, estimatedMicroUsd });
    throw new FileEmbeddingSpendDeniedError(reason, limits.windowHours, resetsAt);
  };

  if (limits.tokensPerWindow <= 0 || limits.budgetPerWindowMicroUsd <= 0) deny('paused');
  if (estimatedTokens > limits.tokensPerWindow || estimatedMicroUsd > limits.budgetPerWindowMicroUsd) {
    deny('oversized');
  }

  const keys = fileEmbeddingWindowCacheKeys(userId);
  const ttlMs = limits.windowHours * HOUR_MS;
  const tokens = await db.cache.tryAddWithinLimitFixedWindow(
    keys.tokens,
    estimatedTokens,
    limits.tokensPerWindow,
    ttlMs
  );
  if (!tokens.success) deny('exhausted', tokens.expiresAt);
  const spend = await db.cache.tryAddWithinLimitFixedWindow(
    keys.microUsd,
    estimatedMicroUsd,
    limits.budgetPerWindowMicroUsd,
    ttlMs
  );
  if (!spend.success) {
    await db.cache.releaseFromFixedWindow(keys.tokens, estimatedTokens, tokens.expiresAt);
    deny('exhausted', spend.expiresAt);
  }

  return {
    release: async () => {
      await db.cache.releaseFromFixedWindow(keys.tokens, estimatedTokens, tokens.expiresAt);
      await db.cache.releaseFromFixedWindow(keys.microUsd, estimatedMicroUsd, spend.expiresAt);
    },
  };
}
