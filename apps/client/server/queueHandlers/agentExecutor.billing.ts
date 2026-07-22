/**
 * Per-iteration credit billing for the agent executor.
 *
 * Extracted from `processExecution`'s inline `billIterationIfNeeded` closure so
 * the delta math + the #657 context-window guard can be unit-tested without
 * dragging in this file's server-only dependency graph (Mongo, AWS SDK,
 * ReActAgent, etc.) - the guard previously had zero coverage. All side effects
 * (credit deduction, usage-event recording, billing-record persistence, WS
 * progress) are injected as `effects` so tests can assert exactly which fire on
 * each path with `vi.fn()` doubles.
 *
 * Billing is delta-based: `counters` carries the last-billed cumulative and is
 * mutated in place as each iteration settles, so the running total is visible to
 * the caller across iterations (mirrors the in-place-mutation contract the call
 * site relies on).
 */
import { getTextModelCost, type ModelInfo } from '@bike4mind/common';
import type { IIterationBilling } from '@bike4mind/database';
import type { UsageEventStatus } from '@bike4mind/common';

/** Last-billed cumulative totals; mutated in place as iterations settle. */
export type BillingCounters = {
  cumulativeCost: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

/** Cumulative totals at the end of the iteration being billed. */
export type BillingCheckpoint = {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
};

/** Per-iteration token deltas (this iteration's contribution). */
export type IterationTokenDeltas = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

/**
 * Injected side effects. The call site binds the fixed context (user, org,
 * session, db wiring, WS convention) into each closure so this module only
 * decides the amounts.
 */
export type IterationBillingEffects = {
  deductCredits: (deltas: IterationTokenDeltas & { credits: number }) => Promise<void>;
  recordUsageEvent: (event: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    cacheWriteTokens: number;
    costUsd: number;
    creditsCharged: number;
    status: UsageEventStatus;
    latencyMs: number;
  }) => void;
  addIterationBilling: (billing: IIterationBilling) => Promise<void>;
  sendProgress: (creditsUsed: number, iterationIndex: number) => Promise<void>;
  logGuardTrip: (details: { inputTokensDelta: number; contextWindow: number }) => void;
  usdToCredits: (usd: number) => number;
  now: () => number;
};

export type BillIterationParams = {
  iterationIndex: number;
  checkpoint: BillingCheckpoint;
  counters: BillingCounters;
  modelInfo: ModelInfo;
  model: string;
  startTime: number;
  effects: IterationBillingEffects;
};

/** Advance `counters` to the checkpoint. Used on both the bill and guard-trip paths. */
function advanceCounters(counters: BillingCounters, checkpoint: BillingCheckpoint, cumulativeCost: number): void {
  counters.cumulativeCost = cumulativeCost;
  counters.inputTokens = checkpoint.totalInputTokens;
  counters.outputTokens = checkpoint.totalOutputTokens;
  counters.cacheReadTokens = checkpoint.totalCacheReadTokens;
  counters.cacheWriteTokens = checkpoint.totalCacheWriteTokens;
}

/**
 * Bill one completed iteration against the model's cumulative cost, advancing
 * `counters` in place. No-op unless the cost has grown since the last billed
 * iteration.
 */
export async function billIteration(params: BillIterationParams): Promise<void> {
  const { iterationIndex, checkpoint, counters, modelInfo, model, startTime, effects } = params;

  // Price cache tokens explicitly: totalInputTokens EXCLUDES cache-read/write (they're
  // tracked as separate counters), so passing them here bills cache-read at ~0.1x and
  // cache-write at ~1.25x rather than pricing them at zero. Mirrors the chat path.
  const cumulativeCost = getTextModelCost(
    modelInfo,
    checkpoint.totalInputTokens,
    checkpoint.totalOutputTokens,
    checkpoint.totalCacheReadTokens,
    checkpoint.totalCacheWriteTokens
  );
  const costDelta = cumulativeCost - counters.cumulativeCost;
  if (costDelta <= 0) return;

  const deltas: IterationTokenDeltas = {
    inputTokens: checkpoint.totalInputTokens - counters.inputTokens,
    outputTokens: checkpoint.totalOutputTokens - counters.outputTokens,
    cacheReadTokens: checkpoint.totalCacheReadTokens - counters.cacheReadTokens,
    cacheWriteTokens: checkpoint.totalCacheWriteTokens - counters.cacheWriteTokens,
  };

  // Sanity backstop (#657): one iteration is one completion call, so its input
  // tokens can never exceed the model's context window (totalInputTokens excludes
  // cache-read/write, so this compares like-for-like). A larger delta means an
  // upstream token-count corruption - a live agent run reported ~49M input tokens
  // on a ~72K-token prompt, which billed ~$148. Fail safe: alarm and skip the
  // credit charge rather than deduct a bogus amount.
  if (modelInfo.contextWindow > 0 && deltas.inputTokens > modelInfo.contextWindow) {
    effects.logGuardTrip({ inputTokensDelta: deltas.inputTokens, contextWindow: modelInfo.contextWindow });
    // Counters still advance to the checkpoint so later iterations settle cleanly
    // from here.
    advanceCounters(counters, checkpoint, cumulativeCost);
    // Persist a zero-credit billing record even though we skipped the charge.
    // updateCheckpoint (call site) persists the corrupt cumulative unconditionally,
    // and on a Lambda re-invoke `counters` reseed by summing persisted
    // iterationBilling deltas while the checkpoint is restored independently. Omit
    // this record and the two diverge: the reseeded counters miss this jump, so the
    // first legitimate iteration after every resume recomputes a huge delta and
    // re-trips this guard, silently dropping one real charge per resume boundary.
    // Writing the delta with credits:0 keeps `sum(iterationBilling) == checkpoint`
    // so resumes reconcile.
    await effects.addIterationBilling({
      iteration: iterationIndex,
      inputTokens: deltas.inputTokens,
      outputTokens: deltas.outputTokens,
      cacheReadTokens: deltas.cacheReadTokens,
      cacheWriteTokens: deltas.cacheWriteTokens,
      credits: 0,
      model,
      timestamp: new Date(effects.now()),
    });
    // Record an anomaly marker for COGS analytics (queryable, joinable by
    // session/model/time) WITHOUT poisoning margin sums: costUsd/creditsCharged and
    // the token fields are zeroed because the delta that tripped the guard is bogus,
    // and the aggregations $sum costUsd/tokens with no status filter. The real
    // corrupt magnitude lives in the guard-trip log for forensics.
    effects.recordUsageEvent({
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
      creditsCharged: 0,
      status: 'error',
      latencyMs: effects.now() - startTime,
    });
    return;
  }

  advanceCounters(counters, checkpoint, cumulativeCost);

  // Stochastic settlement: a sub-credit delta legitimately rounds to 0 (paid in
  // expectation across iterations), so only skip the ledger deduction - the usage
  // event below still records the COGS delta, otherwise margin reporting would
  // silently under-count cost.
  const credits = effects.usdToCredits(costDelta);
  if (credits > 0) {
    await effects.deductCredits({ ...deltas, credits });
  }
  // Dual-write usage event: analytics only, never billing. One per billed iteration.
  effects.recordUsageEvent({
    inputTokens: deltas.inputTokens,
    outputTokens: deltas.outputTokens,
    cachedInputTokens: deltas.cacheReadTokens,
    cacheWriteTokens: deltas.cacheWriteTokens,
    costUsd: costDelta,
    creditsCharged: credits,
    status: 'ok',
    latencyMs: effects.now() - startTime,
  });
  await effects.addIterationBilling({
    iteration: iterationIndex,
    inputTokens: deltas.inputTokens,
    outputTokens: deltas.outputTokens,
    cacheReadTokens: deltas.cacheReadTokens,
    cacheWriteTokens: deltas.cacheWriteTokens,
    credits,
    model,
    timestamp: new Date(effects.now()),
  });
  await effects.sendProgress(credits, iterationIndex);
}
