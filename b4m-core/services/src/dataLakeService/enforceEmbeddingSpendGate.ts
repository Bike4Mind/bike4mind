import type {
  IAdminSettingsRepository,
  ICacheRepository,
  IDataLakeBatchRepository,
  IDataLakeRepository,
} from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { resolveSpendLevers } from './resolveSpendLevers';

/** Cache keys for the platform-wide meters. One period window, one rate window. */
export const EMBEDDING_SPEND_PERIOD_KEY = 'dataLakeEmbeddingSpend:period';
export const EMBEDDING_SPEND_RATE_KEY = 'dataLakeEmbeddingSpend:rate';

const MINUTE_MS = 60_000;
/**
 * Total wall-clock budget for waiting out a saturated rate window, across all attempts.
 * Deliberately small relative to the handler's 5-minute Lambda timeout: the vectorize
 * subscription runs on RESERVED concurrency, so during saturation every waiting slot is
 * asleep-but-billed simultaneously, and whatever we sleep here is subtracted from the time
 * left to embed the actual chunks. Beyond this budget the denial is retryable and the wait
 * moves to SQS redelivery, which costs no compute.
 */
const RATE_WAIT_TOTAL_MS = 30_000;

/**
 * Thrown when the spend gate denies a provider embedding call. The message is user-safe:
 * the vectorize handler stores it on the failed file, where a lake owner reads it.
 */
export class EmbeddingSpendDeniedError extends Error {
  /**
   * A retryable denial can be granted on a later delivery (a saturated rate window drains
   * on its own). A non-retryable one is deterministic - a budget does not regrow and the
   * switch does not flip itself - so redelivering the message only re-reserves spend from
   * the wider meters; the caller should account the failure once and consume the message.
   */
  readonly retryable: boolean;

  constructor(reason: string, options?: { retryable?: boolean }) {
    super(
      `Embedding was not run because data-lake cost governance denied it: ${reason}. ` +
        'An admin can adjust the spend levers under Data Lake Cost Governance, then re-index this file.'
    );
    this.name = 'EmbeddingSpendDeniedError';
    this.retryable = options?.retryable ?? false;
  }
}

export interface SpendGateDb {
  adminSettings: Pick<IAdminSettingsRepository, 'findBySettingNames' | 'findAll'>;
  cache: Pick<ICacheRepository, 'tryAddWithinLimitFixedWindow'>;
  dataLakes: Pick<IDataLakeRepository, 'tryAddEmbeddingSpend'>;
  dataLakeBatches: Pick<IDataLakeBatchRepository, 'tryAddEmbeddingSpend'>;
}

/**
 * The single money gate for data-lake embedding work. Called by the vectorize handler
 * immediately before a provider embedding call - downstream of the embedding cache, so
 * cache hits cost nothing against any budget. Every lever it reads is the one registered
 * in the admin panel; this function existing is what keeps them from being levers with
 * no consumer.
 *
 * Checks, in order:
 *  1. resolveSpendLevers  - throws SpendLeverResolutionError on unusable values (fail closed)
 *  2. master switch       - denies everything when off
 *  3. rate limit          - fixed one-minute window, one unit per provider call; waits out
 *                           the window in-handler up to a few attempts before denying, so a
 *                           brief burst does not burn SQS delivery attempts
 *  4. per-run budget      - reserve-first against the batch's meter
 *  5. per-lake budget     - reserve-first against the lake's meter
 *  6. per-period budget   - reserve-first against the platform-wide fixed window
 *
 * Reservations are made narrowest-first and NOT rolled back when a later check denies: a
 * denial fails the file anyway, so a stranded reservation only makes the wider meters read
 * slightly high - never low. Bounded by one message's cost, and overcounting is the safe
 * direction for a spend meter.
 *
 * That non-rollback argument covers DENIALS only. A granted reservation whose provider call
 * then FAILS is a different case: the money was never spent, and under SQS redelivery the
 * next attempt reserves again - on the per-lake LIFETIME meter that would accumulate forever.
 * The caller therefore owns the compensation: fabFileVectorize releases the run and lake
 * reservations (releaseEmbeddingSpend) when exactly the provider call throws. The release is
 * best-effort - a hard crash between reserve and release still leaks - which is why the
 * per-lake meter also has an admin reset (resetEmbeddingSpend). The estimate itself is
 * Math.ceil'd upward by design and never reconciled against the provider invoice; that bias
 * is noise on the windowed meters and one more reason the lifetime meter needs the reset.
 *
 * Throws EmbeddingSpendDeniedError on any denial; returns void when the call may proceed.
 */
export async function enforceEmbeddingSpendGate(params: {
  /** Estimated provider cost of the call about to be made, integer micro-USD (>= 0). */
  estimatedMicroUsd: number;
  batchId?: string;
  dataLakeId?: string;
  db: SpendGateDb;
  logger?: Logger;
  /** Injectable for tests; defaults to a real setTimeout sleep. */
  sleep?: (ms: number) => Promise<void>;
}): Promise<void> {
  const { estimatedMicroUsd, batchId, dataLakeId, db, logger } = params;
  const sleep = params.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));

  const levers = await resolveSpendLevers(db, logger);

  if (!levers.spendEnabled) {
    throw new EmbeddingSpendDeniedError('the embedding spend switch is off');
  }

  // Rate limit: metered per provider call (a batch of chunks is one call), and 0 is a stop.
  // On a full window, wait briefly for it to close rather than immediately failing the
  // message - the SQS retry budget is only 3 deliveries and must be kept for real errors.
  // The wait is bounded by RATE_WAIT_TOTAL_MS across ALL attempts (see its comment for why
  // sleeping on reserved concurrency is itself a cost); past that the denial is retryable
  // and the remaining wait happens on the queue instead.
  for (let waitedMs = 0; ;) {
    const rate = await db.cache.tryAddWithinLimitFixedWindow(
      EMBEDDING_SPEND_RATE_KEY,
      1,
      levers.maxCallsPerMinute,
      MINUTE_MS
    );
    if (rate.success) break;
    if (levers.maxCallsPerMinute <= 0) {
      throw new EmbeddingSpendDeniedError('the embedding rate limit is 0 (stopped)');
    }
    const waitMs = Math.min(Math.max(rate.expiresAt.getTime() - Date.now(), 250), MINUTE_MS);
    if (waitedMs + waitMs > RATE_WAIT_TOTAL_MS) {
      // Retryable: the window drains on its own, so a later SQS delivery can be granted.
      throw new EmbeddingSpendDeniedError(
        `the embedding rate limit (${levers.maxCallsPerMinute}/min) stayed exhausted after waiting ${waitedMs}ms`,
        { retryable: true }
      );
    }
    logger?.log?.(`[spendGate] rate window full (${rate.count}); waiting ${waitMs}ms (${waitedMs}ms waited so far)`);
    await sleep(waitMs);
    waitedMs += waitMs;
  }

  if (batchId) {
    const ok = await db.dataLakeBatches.tryAddEmbeddingSpend(batchId, estimatedMicroUsd, levers.perRunBudgetMicroUsd);
    if (!ok) {
      throw new EmbeddingSpendDeniedError(
        `the per-run embedding budget ($${levers.perRunBudgetMicroUsd / 1e6}) is exhausted for this upload batch`
      );
    }
  }

  if (dataLakeId) {
    const ok = await db.dataLakes.tryAddEmbeddingSpend(dataLakeId, estimatedMicroUsd, levers.perLakeBudgetMicroUsd);
    if (!ok) {
      throw new EmbeddingSpendDeniedError(
        `the per-lake embedding budget ($${levers.perLakeBudgetMicroUsd / 1e6}) is exhausted for this data lake`
      );
    }
  }

  const period = await db.cache.tryAddWithinLimitFixedWindow(
    EMBEDDING_SPEND_PERIOD_KEY,
    estimatedMicroUsd,
    levers.perPeriodBudgetMicroUsd,
    levers.periodHours * 3_600_000
  );
  if (!period.success) {
    throw new EmbeddingSpendDeniedError(
      `the platform-wide embedding budget ($${levers.perPeriodBudgetMicroUsd / 1e6} per ${levers.periodHours}h) is exhausted`
    );
  }
}
