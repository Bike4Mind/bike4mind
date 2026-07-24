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
 * Tool-internal LLM spend accrued during the iteration, already priced per-tool (#630).
 * Field-compatible with `ToolLlmUsage` (b4m-core services tools/base/types.ts) minus the
 * model tag; each `onToolLlmUsage` callback is accumulated into this shape via `addToolUsage`.
 * `costUsd` is priced at the tool's OWN model, so it is folded into the iteration charge as
 * USD - never re-priced against the agent model's token rate.
 */
export type ToolUsageTotals = {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

/**
 * Mutable accumulator the executor advances as `onToolLlmUsage` callbacks fire during an
 * iteration; the call site snapshots-and-clears it into `BillIterationParams.toolUsage`
 * before each `billIteration`. Same shape as a settled `ToolUsageTotals`.
 */
export type PendingToolUsage = ToolUsageTotals;

/** Fold one tool-internal usage report into the pending accumulator. Mutates `pending`. */
export function addToolUsage(pending: PendingToolUsage, usage: ToolUsageTotals): void {
  pending.costUsd += usage.costUsd;
  pending.inputTokens += usage.inputTokens;
  pending.outputTokens += usage.outputTokens;
  pending.cacheReadTokens += usage.cacheReadTokens;
  pending.cacheWriteTokens += usage.cacheWriteTokens;
}

/**
 * Snapshot the accumulated tool spend and reset the accumulator to zero in one step, so a
 * repeat call can't double-count the same spend (a second take returns all-zeros). Mutates
 * `pending`. Call once per iteration, just before `billIteration` consumes the snapshot.
 */
export function takeToolUsage(pending: PendingToolUsage): ToolUsageTotals {
  const snapshot: ToolUsageTotals = {
    costUsd: pending.costUsd,
    inputTokens: pending.inputTokens,
    outputTokens: pending.outputTokens,
    cacheReadTokens: pending.cacheReadTokens,
    cacheWriteTokens: pending.cacheWriteTokens,
  };
  pending.costUsd = 0;
  pending.inputTokens = 0;
  pending.outputTokens = 0;
  pending.cacheReadTokens = 0;
  pending.cacheWriteTokens = 0;
  return snapshot;
}

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
  /**
   * Tool-internal LLM spend accrued this iteration (#630). Already snapshotted-and-cleared
   * by the caller, so it is consumed exactly once. Priced per-tool, so it folds into the
   * customer charge as USD and its tokens feed the analytics usage event; it is NEVER added
   * to the resume-critical `iterationBilling` token deltas (those must stay agent-only - see
   * `billIteration`). Defaults to zero for callers that bill tools up front.
   */
  toolUsage?: ToolUsageTotals;
  effects: IterationBillingEffects;
};

const ZERO_TOOL_USAGE: ToolUsageTotals = {
  costUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
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
  const toolUsage = params.toolUsage ?? ZERO_TOOL_USAGE;

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
  // Settle the agent's own cost growth plus any tool-internal spend (#630). Tool spend is
  // already priced per-tool, so it adds directly as USD. Both terms are >= 0, so an
  // iteration with tool usage is always billable (never hits the no-op return below).
  const costDelta = cumulativeCost - counters.cumulativeCost + toolUsage.costUsd;
  if (costDelta <= 0) return;

  // Agent-only per-iteration token deltas (checkpoint totals are agent-loop only). These
  // are the resume-critical values summed to rebuild cumulative agent cost, so tool tokens
  // (a different model) must never enter them.
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
  // Guard on the AGENT input delta only (tool spend is a different, smaller model and is
  // not part of this sanity bound). On a trip we skip the whole iteration charge - the
  // snapshotted tool spend goes with it, consistent with dropping the agent charge; the
  // token counts that produced it were corrupt anyway.
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

  // Charge + analytics reflect agent AND tool spend (the customer paid for both). The
  // iterationBilling record below stays agent-only.
  const chargedInputTokens = deltas.inputTokens + toolUsage.inputTokens;
  const chargedOutputTokens = deltas.outputTokens + toolUsage.outputTokens;
  const chargedCacheReadTokens = deltas.cacheReadTokens + toolUsage.cacheReadTokens;
  const chargedCacheWriteTokens = deltas.cacheWriteTokens + toolUsage.cacheWriteTokens;

  // Stochastic settlement: a sub-credit delta legitimately rounds to 0 (paid in
  // expectation across iterations), so only skip the ledger deduction - the usage
  // event below still records the COGS delta, otherwise margin reporting would
  // silently under-count cost.
  const credits = effects.usdToCredits(costDelta);
  if (credits > 0) {
    await effects.deductCredits({
      inputTokens: chargedInputTokens,
      outputTokens: chargedOutputTokens,
      cacheReadTokens: chargedCacheReadTokens,
      cacheWriteTokens: chargedCacheWriteTokens,
      credits,
    });
  }
  // Dual-write usage event: analytics only, never billing. One per billed iteration.
  // Tokens + cost include the tool spend so margin reporting sees true COGS.
  effects.recordUsageEvent({
    inputTokens: chargedInputTokens,
    outputTokens: chargedOutputTokens,
    cachedInputTokens: chargedCacheReadTokens,
    cacheWriteTokens: chargedCacheWriteTokens,
    costUsd: costDelta,
    creditsCharged: credits,
    status: 'ok',
    latencyMs: effects.now() - startTime,
  });
  // Persist AGENT-ONLY token deltas: these are summed on resume to rebuild cumulative
  // agent cost, so folding tool tokens (a different model) in here would drive the
  // post-resume costDelta negative and silently skip billing. `credits` still reflects
  // the full charge (agent + tool).
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
