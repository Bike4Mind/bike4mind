import type {
  IAdminSettingsRepository,
  ICacheRepository,
  IDataLakeBatchRepository,
  IDataLakeRepository,
  SettingOwnerType,
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
import { scopeForLake } from '../settings/resolveScopedSetting';

/** Cache keys for the platform-wide meters. One period window, two throughput windows. */
export const EMBEDDING_SPEND_PERIOD_KEY = 'dataLakeEmbeddingSpend:period';
export const EMBEDDING_SPEND_RATE_KEY = 'dataLakeEmbeddingSpend:rate';
/** The TPM window. Separate key from the call window: the two meter different quantities of the
 *  same call and must drain independently. */
export const EMBEDDING_SPEND_TOKEN_RATE_KEY = 'dataLakeEmbeddingSpend:tokenRate';

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
  dataLakes: Pick<IDataLakeRepository, 'tryAddEmbeddingSpendMetered' | 'findById'>;
  dataLakeBatches: Pick<IDataLakeBatchRepository, 'tryAddEmbeddingSpend'>;
}

/**
 * The single money and throughput gate for data-lake embedding work. Called by the vectorize
 * handler immediately before a provider embedding call - downstream of the embedding cache, so
 * cache hits cost nothing against any budget. Every lever it reads is the one registered
 * in the admin panel; this function existing is what keeps them from being levers with
 * no consumer.
 *
 * INGEST ONLY, deliberately. Query-side embedding (semanticDataLakeSearch, alternateModelAnn)
 * does NOT pass through here: it is one small, latency-critical call on an interactive path, and
 * putting it behind a window a bulk backfill can saturate would make search wait on maintenance
 * work - the starvation this gate exists to prevent, inflicted from the other direction. The
 * consequence is that query traffic spends provider quota this gate cannot see, which is why the
 * TPM lever's default is set BELOW the provider tier rather than at it (see
 * DATA_LAKE_EMBEDDING_MAX_TOKENS_PER_MINUTE_DEFAULT); the headroom is the query lane.
 *
 * Applies to every data-lake ingest door - upload batch, per-file reprocess, Rebuild Passages,
 * and convergence - because they all funnel into the one vectorize handler that calls this.
 *
 * The per-run and per-lake budgets are TIERED by lake ownership (#1675): an individual-owned lake
 * and an organization-owned one are different economic cases, so the gate resolves which one this
 * lake is (via scopeForLake, the single place that derivation lives) and the levers scale
 * accordingly. Where ownership is genuinely absent - no lake in scope, or the row is gone - the
 * levers fall to the more restrictive tier rather than guessing (see pickTierMultiplier); where the
 * lake read ERRORS, the error propagates so the message is retried instead of billed on a tier
 * nobody chose (see resolveLakeOwnerType).
 *
 * That costs one indexed lake read, taken BEFORE the master switch is checked because the switch
 * and the tier come out of the same settings read. Accepted deliberately: the switch is on in
 * steady state, and when it is off this path is already failing the file either way.
 *
 * Checks, in order:
 *  1. resolveSpendLevers  - throws SpendLeverResolutionError on unusable values (fail closed)
 *  2. master switch       - denies everything when off
 *  3. throughput cap      - two fixed one-minute windows, calls/min and tokens/min, both of
 *                           which a call must fit; waits out a full window in-handler up to a
 *                           few attempts before denying, so a brief burst does not burn SQS
 *                           delivery attempts
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
  /**
   * Tokens the call will send to the provider (>= 0), metered against the TPM window. Required
   * rather than optional on purpose: a caller that forgot it would silently spend the provider's
   * token quota unmetered, which is precisely the hole this window exists to close. Pass 0 only
   * when the call genuinely sends none.
   */
  estimatedTokens: number;
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
  const { estimatedMicroUsd, estimatedTokens, batchId, dataLakeId, db, logger, notify } = params;
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

  const ownerType = await resolveLakeOwnerType(dataLakeId, db, logger);
  const levers = await resolveSpendLevers(db, logger, ownerType);
  // The one line that shows the tier lever firing: without it, a budget denial gives no way to
  // tell which tier produced the number an operator is looking at.
  logger?.log?.(`[spendGate] cost tier ${ownerType ?? 'unresolved'} (x${levers.tierMultiplier})`);

  if (!levers.spendEnabled) {
    await fire({
      kind: 'stopped',
      scope: 'switch',
      periodKey: periodKeyForClock(new Date()),
      detail: { reason: 'the embedding spend switch is off' },
    });
    throw new EmbeddingSpendDeniedError('the embedding spend switch is off');
  }

  // Throughput cap: two fixed one-minute windows a call must fit BOTH of. calls/min bounds the
  // provider's RPM; tokens/min bounds its TPM, which is what providers actually meter and what a
  // call cap alone does not bound - one call carries a whole batch of passages, so the call cap
  // at its default permits several million tokens a minute.
  //
  // On a full window, wait briefly for it to close rather than immediately failing the
  // message - the SQS retry budget is only 3 deliveries and must be kept for real errors.
  // The wait is bounded by RATE_WAIT_TOTAL_MS across ALL attempts and BOTH windows (see its
  // comment for why sleeping on reserved concurrency is itself a cost); past that the denial is
  // retryable and the remaining wait happens on the queue instead. A wait that resolves on its
  // own (grant after sleeping) is the rate limiter working as designed - deliberately no
  // notification on that path, only on the throws below.
  //
  // A granted window is dropped from `pending` immediately, so waiting out the SECOND window
  // never re-charges the first. The reservations are not rolled back if the second then denies:
  // same direction as the budget reservations below - a stranded reservation makes a window read
  // slightly full, never slightly empty, and it drains within the minute either way.
  //
  // Both windows report under the `rate` notification scope. One saturated throughput cap is one
  // operator-visible condition, and sharing the scope means the (lake, kind, scope, periodKey)
  // dedup slot sends ONE notice per minute rather than two for the same stall; the `reason`
  // string is what names the window that actually denied.
  const throughputWindows = [
    {
      key: EMBEDDING_SPEND_RATE_KEY,
      amount: 1,
      limit: levers.maxCallsPerMinute,
      name: 'call rate limit',
      unit: '/min',
    },
    {
      key: EMBEDDING_SPEND_TOKEN_RATE_KEY,
      amount: estimatedTokens,
      limit: levers.maxTokensPerMinute,
      name: 'token rate limit',
      unit: ' tokens/min',
    },
  ];

  // A call bigger than the whole window can never be granted, however long we wait: the counter
  // denies `amount > limit` even against an empty window. Waiting it out would burn the whole
  // wait budget and then hand SQS a retry that is guaranteed to fail the same way, so it is
  // caught up front and thrown as terminal. Only reachable on the token window (calls cost 1).
  for (const limitWindow of throughputWindows) {
    if (limitWindow.amount > 0 && limitWindow.limit > 0 && limitWindow.amount > limitWindow.limit) {
      const reason =
        `a single embedding call of ${limitWindow.amount} tokens can never fit the embedding ` +
        `${limitWindow.name} (${limitWindow.limit}${limitWindow.unit})`;
      await fire({
        kind: 'stopped',
        scope: 'rate',
        periodKey: periodKeyForClock(new Date()),
        detail: { reason },
      });
      throw new EmbeddingSpendDeniedError(reason);
    }
  }

  const pending = [...throughputWindows];
  for (let waitedMs = 0; pending.length > 0;) {
    const limitWindow = pending[0];
    const rate = await db.cache.tryAddWithinLimitFixedWindow(
      limitWindow.key,
      limitWindow.amount,
      limitWindow.limit,
      MINUTE_MS
    );
    if (rate.success) {
      pending.shift();
      continue;
    }
    if (limitWindow.limit <= 0) {
      const reason = `the embedding ${limitWindow.name} is 0 (stopped)`;
      await fire({
        kind: 'stopped',
        scope: 'rate',
        periodKey: periodKeyForClock(new Date()),
        detail: { reason },
      });
      throw new EmbeddingSpendDeniedError(reason);
    }
    const waitMs = Math.min(Math.max(rate.expiresAt.getTime() - Date.now(), 250), MINUTE_MS);
    if (waitedMs + waitMs > RATE_WAIT_TOTAL_MS) {
      const reason =
        `the embedding ${limitWindow.name} (${limitWindow.limit}${limitWindow.unit}) ` +
        `stayed exhausted after waiting ${waitedMs}ms`;
      // Retryable: the window drains on its own, so a later SQS delivery can be granted.
      await fire({
        kind: 'throttled',
        scope: 'rate',
        periodKey: periodKeyForClock(new Date()),
        detail: { reason, retryable: true },
      });
      throw new EmbeddingSpendDeniedError(reason, { retryable: true });
    }
    logger?.log?.(
      `[spendGate] ${limitWindow.name} window full (${rate.count}); waiting ${waitMs}ms (${waitedMs}ms waited so far)`
    );
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
    // Same condition also marks a STUCK denial (the budget is 0, or this one message's own
    // estimate already exceeds the whole platform budget) - neither ever resolves within the
    // current window, so windowEndsAt is withheld rather than naming a time that will not help;
    // the renderer treats its absence as "do not promise automatic resumption".
    const periodIsStuck = levers.perPeriodBudgetMicroUsd <= 0 || estimatedMicroUsd > levers.perPeriodBudgetMicroUsd;
    const periodKey = periodIsStuck ? periodKeyForClock(new Date()) : periodKeyForWindow(period.expiresAt);
    await fire({
      kind: 'budget_exhausted',
      scope: 'period',
      periodKey,
      detail: {
        budgetMicroUsd: levers.perPeriodBudgetMicroUsd,
        periodHours: levers.periodHours,
        windowEndsAt: periodIsStuck ? undefined : period.expiresAt,
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

/**
 * Which cost tier this work belongs to: the OWNER of the lake being written, not the actor who
 * triggered the run - an individual uploading into an org lake spends on the org's tier.
 *
 * Returns undefined only where ownership is genuinely ABSENT - no lake in scope, or a lake whose
 * row no longer exists - which `pickTierMultiplier` reads as "apply the more restrictive tier".
 * Both are deterministic states, so denying on them is honest.
 *
 * A read that THROWS is a different thing and is deliberately NOT swallowed into that same
 * "undefined": unknown is not absent. Collapsing it would let a transient Mongo blip apply a tier
 * the operator never configured, and a budget denial here is NON-retryable - the vectorize handler
 * skips SQS redelivery on it and fails the file for good, with a "budget is exhausted" message that
 * would be a lie about what happened. Letting the error propagate keeps the message on the queue so
 * a later delivery can resolve the tier properly.
 */
async function resolveLakeOwnerType(
  dataLakeId: string | undefined,
  db: SpendGateDb,
  logger?: Logger
): Promise<SettingOwnerType | undefined> {
  if (!dataLakeId) return undefined;
  let lake: Awaited<ReturnType<SpendGateDb['dataLakes']['findById']>>;
  try {
    lake = await db.dataLakes.findById(dataLakeId);
  } catch (err) {
    logger?.warn?.(`[spendGate] could not read lake ${dataLakeId} to resolve its cost tier; retrying later`, err);
    throw err;
  }
  if (!lake) {
    logger?.warn?.(`[spendGate] lake ${dataLakeId} not found; applying the more restrictive cost tier`);
    return undefined;
  }
  return scopeForLake(lake).owner?.type;
}
