import type {
  IAdminSettingsRepository,
  ICacheRepository,
  IDataLakeBatchRepository,
  IDataLakeRepository,
} from '@bike4mind/common';
import { EMBEDDING_SPEND_NOTIFY_THRESHOLD_PCT } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { resolveSpendLevers } from './resolveSpendLevers';
import {
  periodKeyForClock,
  periodKeyForLakeBudget,
  periodKeyForRun,
  periodKeyForWindow,
} from './spendNotificationKeys';
import type { DataLakeSpendNotificationEvent } from './sendDataLakeSpendNotification';

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
 * Bounds how long a single notify() call (SMTP send + its awaited Slack mirror) can block
 * the ingestion critical path. Without this, a hung mail server can consume the whole
 * Lambda timeout for the one message that wins the notification claim - the file fails to
 * index and burns an SQS delivery attempt over a mail-server problem, not a real error.
 */
const DEFAULT_NOTIFY_TIMEOUT_MS = 3_000;

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
  dataLakes: Pick<IDataLakeRepository, 'tryAddEmbeddingSpendMetered'>;
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
  /**
   * Optional notification PORT (never a db/mailer handle - keeps this gate free of those
   * dependencies). Called and AWAITED (not fire-and-forget - a floating promise is dropped
   * when a Lambda container freezes) at every denial site before the throw, and once after
   * every reservation succeeds to check the approaching-cap threshold. A `notify` failure is
   * caught and logged; it never changes the gate's own grant/deny decision.
   */
  notify?: (event: DataLakeSpendNotificationEvent) => Promise<unknown>;
  /** Injectable for tests; defaults to DEFAULT_NOTIFY_TIMEOUT_MS. */
  notifyTimeoutMs?: number;
}): Promise<void> {
  const { estimatedMicroUsd, batchId, dataLakeId, db, logger, notify } = params;
  const sleep = params.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const notifyTimeoutMs = params.notifyTimeoutMs ?? DEFAULT_NOTIFY_TIMEOUT_MS;

  const fire = async (event: Omit<DataLakeSpendNotificationEvent, 'dataLakeId'>): Promise<void> => {
    if (!notify || !dataLakeId) return;
    // Clear the timer on the fast (common) path - an uncleared setTimeout keeps a Lambda's
    // event loop non-empty for the full notifyTimeoutMs even after notify() already resolved.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        notify({ dataLakeId, ...event }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`notify exceeded ${notifyTimeoutMs}ms`)), notifyTimeoutMs);
        }),
      ]);
    } catch (err) {
      logger?.warn?.(`[spendGate] spend notification failed: ${err}`);
    } finally {
      clearTimeout(timer);
    }
  };

  const levers = await resolveSpendLevers(db, logger);

  if (!levers.spendEnabled) {
    await fire({
      kind: 'stopped',
      scope: 'switch',
      periodKey: periodKeyForClock(new Date()),
      detail: { reason: 'the embedding spend switch is off' },
    });
    throw new EmbeddingSpendDeniedError('the embedding spend switch is off');
  }

  // Rate limit: metered per provider call (a batch of chunks is one call), and 0 is a stop.
  // On a full window, wait briefly for it to close rather than immediately failing the
  // message - the SQS retry budget is only 3 deliveries and must be kept for real errors.
  // The wait is bounded by RATE_WAIT_TOTAL_MS across ALL attempts (see its comment for why
  // sleeping on reserved concurrency is itself a cost); past that the denial is retryable
  // and the remaining wait happens on the queue instead. A wait that resolves on its own
  // (grant after sleeping) is the rate limiter working as designed - deliberately no
  // notification on that path, only on the two throws below.
  for (let waitedMs = 0; ;) {
    const rate = await db.cache.tryAddWithinLimitFixedWindow(
      EMBEDDING_SPEND_RATE_KEY,
      1,
      levers.maxCallsPerMinute,
      MINUTE_MS
    );
    if (rate.success) break;
    if (levers.maxCallsPerMinute <= 0) {
      await fire({
        kind: 'stopped',
        scope: 'rate',
        periodKey: periodKeyForClock(new Date()),
        detail: { reason: 'the embedding rate limit is 0 (stopped)' },
      });
      throw new EmbeddingSpendDeniedError('the embedding rate limit is 0 (stopped)');
    }
    const waitMs = Math.min(Math.max(rate.expiresAt.getTime() - Date.now(), 250), MINUTE_MS);
    if (waitedMs + waitMs > RATE_WAIT_TOTAL_MS) {
      const reason = `the embedding rate limit (${levers.maxCallsPerMinute}/min) stayed exhausted after waiting ${waitedMs}ms`;
      // Retryable: the window drains on its own, so a later SQS delivery can be granted.
      await fire({
        kind: 'throttled',
        scope: 'rate',
        periodKey: periodKeyForClock(new Date()),
        detail: { reason, retryable: true },
      });
      throw new EmbeddingSpendDeniedError(reason, { retryable: true });
    }
    logger?.log?.(`[spendGate] rate window full (${rate.count}); waiting ${waitMs}ms (${waitedMs}ms waited so far)`);
    await sleep(waitMs);
    waitedMs += waitMs;
  }

  if (batchId) {
    const ok = await db.dataLakeBatches.tryAddEmbeddingSpend(batchId, estimatedMicroUsd, levers.perRunBudgetMicroUsd);
    if (!ok) {
      await fire({
        kind: 'budget_exhausted',
        scope: 'run',
        periodKey: periodKeyForRun(batchId),
        detail: { batchId, budgetMicroUsd: levers.perRunBudgetMicroUsd },
      });
      throw new EmbeddingSpendDeniedError(
        `the per-run embedding budget ($${levers.perRunBudgetMicroUsd / 1e6}) is exhausted for this upload batch`
      );
    }
  }

  let lakeSpendMicroUsd: number | null = null;
  if (dataLakeId) {
    const result = await db.dataLakes.tryAddEmbeddingSpendMetered(
      dataLakeId,
      estimatedMicroUsd,
      levers.perLakeBudgetMicroUsd
    );
    if (!result.granted) {
      await fire({
        kind: 'budget_exhausted',
        scope: 'lake',
        periodKey: periodKeyForLakeBudget(levers.perLakeBudgetMicroUsd),
        detail: { budgetMicroUsd: levers.perLakeBudgetMicroUsd },
      });
      throw new EmbeddingSpendDeniedError(
        `the per-lake embedding budget ($${levers.perLakeBudgetMicroUsd / 1e6}) is exhausted for this data lake`
      );
    }
    lakeSpendMicroUsd = result.spendMicroUsd;
  }

  const period = await db.cache.tryAddWithinLimitFixedWindow(
    EMBEDDING_SPEND_PERIOD_KEY,
    estimatedMicroUsd,
    levers.perPeriodBudgetMicroUsd,
    levers.periodHours * 3_600_000
  );
  if (!period.success) {
    // The cache layer never seeds a window doc when a single call's amount alone exceeds the
    // limit (levers.perPeriodBudgetMicroUsd <= 0, or one message's own estimate is already
    // over budget) - every such deny falls through to a SYNTHESIZED expiresAt (now + ttl),
    // which is millisecond-unique per call. Keying the dedup on that would mean the exact
    // deny an operator triggers by pulling the stop lever to 0 never dedupes at all: one
    // notification claim (and up to MAX_LAKE_SPEND_ADDRESSEES emails) per denied message.
    // Fall back to the same hour-bucketed clock key the switch/rate stop notices already use.
    const periodKey =
      levers.perPeriodBudgetMicroUsd <= 0 || estimatedMicroUsd > levers.perPeriodBudgetMicroUsd
        ? periodKeyForClock(new Date())
        : periodKeyForWindow(period.expiresAt);
    await fire({
      kind: 'budget_exhausted',
      scope: 'period',
      periodKey,
      detail: {
        budgetMicroUsd: levers.perPeriodBudgetMicroUsd,
        periodHours: levers.periodHours,
        windowEndsAt: period.expiresAt,
      },
    });
    throw new EmbeddingSpendDeniedError(
      `the platform-wide embedding budget ($${levers.perPeriodBudgetMicroUsd / 1e6} per ${levers.periodHours}h) is exhausted`
    );
  }

  // Every reservation succeeded - check the approaching-cap threshold. Computed AFTER every
  // reservation grants (never mid-way): a run about to be denied should not also produce an
  // "approaching" notice. No check-then-write race here for either meter: the ONLY
  // race-safety is the atomic claim inside `notify`'s send service - N concurrent workers may
  // all attempt to fire, and exactly one's claim wins.
  //
  // Fire only on the message that CROSSES the threshold, not every message after it: both
  // sides of the crossing are already in hand (this call's own reservation amount), so a
  // before/after comparison avoids paying a findById + claim upsert on every remaining
  // message in the window once a lake or the platform period is past 80%.
  if (dataLakeId && lakeSpendMicroUsd !== null && levers.perLakeBudgetMicroUsd > 0) {
    const thresholdMicroUsd = levers.perLakeBudgetMicroUsd * EMBEDDING_SPEND_NOTIFY_THRESHOLD_PCT;
    const spendBeforeMicroUsd = lakeSpendMicroUsd - estimatedMicroUsd;
    if (spendBeforeMicroUsd < thresholdMicroUsd && lakeSpendMicroUsd >= thresholdMicroUsd) {
      await fire({
        kind: 'approaching_cap',
        scope: 'lake',
        periodKey: periodKeyForLakeBudget(levers.perLakeBudgetMicroUsd),
        thresholdPct: EMBEDDING_SPEND_NOTIFY_THRESHOLD_PCT,
        detail: { spentMicroUsd: lakeSpendMicroUsd, budgetMicroUsd: levers.perLakeBudgetMicroUsd },
      });
    }
  }
  // Deliberately no approaching_cap/period notice: period.count is ONE global counter, so its
  // crossing test is true for exactly one message platform-wide, and that message belongs to
  // one arbitrary lake - its owner/org-admins would get "platform budget approaching" while
  // every other affected lake hears nothing, and no platform admin (the only party who can
  // actually act on it) is reached at all. budget_exhausted/period does not have this problem -
  // it fires on every denial, so it correctly reaches every affected lake once per window.
}
