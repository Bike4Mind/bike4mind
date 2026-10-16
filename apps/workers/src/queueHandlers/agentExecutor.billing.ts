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
import { getTurnsCost, reservationOutputTokens, usdToCredits, type ModelInfo, type TurnUsage } from '@bike4mind/common';
import type { IIterationBilling } from '@bike4mind/database';
import type { UsageEventStatus } from '@bike4mind/common';
import { buildEarlyStopStamp } from '@bike4mind/services/llm';

/** Input tokens (cached or not) the last provider request of a run sent; 0 before the first. */
export function lastRequestInputTokens(turns: readonly TurnUsage[] | undefined): number {
  const last = turns?.at(-1);
  return last ? last.inputTokens + (last.cacheReadInputTokens ?? 0) + (last.cacheCreationInputTokens ?? 0) : 0;
}

/**
 * Credits the next iteration can cost: a request as large as the last one the run sent, priced
 * uncached, plus a reservation-sized reply. The executor checks the payer's live balance against
 * it before every iteration (and at admission), so a run stops before an iteration it cannot pay
 * for instead of settling the balance below zero.
 */
export function nextIterationCredits(modelInfo: ModelInfo, inputTokens: number): number {
  const outputTokens = reservationOutputTokens(modelInfo.max_tokens);
  return usdToCredits(getTurnsCost(modelInfo, [{ inputTokens, outputTokens }]));
}

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
  /** Provider stop reason for this iteration's completion, e.g. from `AgentCheckpoint.finishReason`. */
  finishReason?: string;
  /** `AgentCheckpoint.turnUsage`: the same totals per provider request (see unbilledTurns). */
  turnUsage?: readonly TurnUsage[];
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
 * Which generative tools have their provider media cost folded into the iteration bill, keyed
 * by the callback phase that folds them. Image and audio both settle on finish: the tools'
 * failure paths return before onFinish, so an undelivered image or clip is never billed. The
 * start phase owns nothing today; it stays so a tool can opt into it explicitly.
 * video_generation and music_generation bill in their job instead. Must stay in sync with the
 * tool implementations in b4m-core/services.
 */
const MEDIA_COST_TOOLS_BY_PHASE = {
  start: [],
  finish: ['image_generation', 'edit_image', 'audio_generation'],
} as const satisfies Record<'start' | 'finish', readonly string[]>;

export type MediaCostPhase = keyof typeof MEDIA_COST_TOOLS_BY_PHASE;

export type FoldGeneratedMediaUsdParams = {
  phase: MediaCostPhase;
  toolName: string;
  data: unknown;
  models: ModelInfo[];
  /** Mutated in place when a positive media cost is folded in. */
  pending: PendingToolUsage;
  /** The pure USD estimator (b4m-core `estimateGeneratedMediaUsd`); injected to keep this module services-free and testable. */
  estimateUsd: (toolName: string, data: unknown, models: ModelInfo[]) => number;
  /** Called when the estimator throws so the caller can log; the iteration is still billed, just without this tool's media cost. */
  onError?: (err: unknown) => void;
};

/**
 * Fold a generative tool's provider media cost (USD) into the per-iteration accumulator, on the
 * phase that owns that tool (see MEDIA_COST_TOOLS_BY_PHASE). Agent mode bills LLM tokens
 * per-iteration; a tool's media cost is NOT LLM spend, so classic chat's per-tool toolCreditsMap
 * drain never runs here - without this fold, agent-mode generation would be free. No-op for a
 * tool not owned by this phase, or when the estimate is <= 0. Never throws: an estimator error
 * is routed to `onError` and this iteration is billed without the media cost.
 */
export function foldGeneratedMediaUsd(params: FoldGeneratedMediaUsdParams): void {
  const { phase, toolName, data, models, pending, estimateUsd, onError } = params;
  // Cast widens the readonly literal tuple so `includes` accepts an arbitrary tool name.
  if (!(MEDIA_COST_TOOLS_BY_PHASE[phase] as readonly string[]).includes(toolName)) return;
  try {
    const usd = estimateUsd(toolName, data, models);
    if (usd > 0) {
      addToolUsage(pending, {
        costUsd: usd,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      });
    }
  } catch (err) {
    onError?.(err);
  }
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
  logGuardTrip: (details: { requestInputTokens: number; contextWindow: number }) => void;
  logNegativeDelta: (details: {
    costDelta: number;
    toolCostUsd: number;
    cumulativeCost: number;
    previousCumulativeCost: number;
  }) => void;
  /** The checkpoint's turns did not reconcile with its totals and counters (see unbilledTurns). */
  logTurnsFallback: (details: { turnSum: IterationTokenDeltas; totals: IterationTokenDeltas }) => void;
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

type IterationTokenRecord = Pick<
  IIterationBilling,
  'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'
>;

/**
 * One iteration's agent usage as a single provider request: ReActAgent calls the model with
 * executeTools: false, so an iteration is normally one request, and that request's own prompt
 * picks its long-context tier. Pricing the run's cumulative totals instead tiers every iteration
 * on the whole run (and on cache-exclusive input).
 */
function iterationTurn(tokens: IterationTokenRecord): TurnUsage {
  return {
    inputTokens: tokens.inputTokens,
    outputTokens: tokens.outputTokens,
    cacheReadInputTokens: tokens.cacheReadTokens,
    cacheCreationInputTokens: tokens.cacheWriteTokens,
  };
}

type TokenSums = IterationTokenDeltas;

const sameTokens = (a: TokenSums, b: TokenSums): boolean =>
  a.inputTokens === b.inputTokens &&
  a.outputTokens === b.outputTokens &&
  a.cacheReadTokens === b.cacheReadTokens &&
  a.cacheWriteTokens === b.cacheWriteTokens;

/**
 * The provider requests this bill covers: the checkpoint's turns after the prefix that sums to
 * `counters` (already billed). One bill can cover more than one request - a call aborted at the
 * iteration deadline leaves its partial usage in the checkpoint the continuation resumes from, and
 * a Lambda lost between the checkpoint write and the billing record leaves an unbilled iteration -
 * and pricing those as one request would tier them on their combined prompt. Falls back to
 * `deltas` as one request when there are no turns or they do not reconcile with the totals; the
 * latter warns via `logTurnsFallback`, since the #657 guard in billIteration relies on it.
 */
function unbilledTurns(
  checkpoint: BillingCheckpoint,
  counters: BillingCounters,
  deltas: TokenSums,
  effects: IterationBillingEffects
): TurnUsage[] {
  const turns = checkpoint.turnUsage;
  if (turns?.length) {
    const sum: TokenSums = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    let billedCount = -1;
    for (let i = 0; ; i++) {
      if (billedCount < 0 && sameTokens(sum, counters)) billedCount = i;
      if (i === turns.length) break;
      sum.inputTokens += turns[i].inputTokens;
      sum.outputTokens += turns[i].outputTokens;
      sum.cacheReadTokens += turns[i].cacheReadInputTokens ?? 0;
      sum.cacheWriteTokens += turns[i].cacheCreationInputTokens ?? 0;
    }
    const totals: TokenSums = {
      inputTokens: checkpoint.totalInputTokens,
      outputTokens: checkpoint.totalOutputTokens,
      cacheReadTokens: checkpoint.totalCacheReadTokens,
      cacheWriteTokens: checkpoint.totalCacheWriteTokens,
    };
    if (billedCount >= 0 && sameTokens(sum, totals)) return turns.slice(billedCount);
    effects.logTurnsFallback({ turnSum: sum, totals });
  }
  return [iterationTurn(deltas)];
}

/**
 * Rebuild `counters` on resume from the persisted per-iteration token deltas. `cumulativeCost`
 * is re-priced iteration by iteration with this invocation's `modelInfo` (the rate and tiering
 * `billIteration` uses), never carried over. Unlike the live running total, the reseeded figure
 * prices each persisted iteration record as one request, so the two can differ when one bill
 * covered several requests. Billing reads only the token counters; the cost is the reference
 * the negative-delta warning reports against.
 */
export function reseedCounters(
  iterationBilling: readonly IterationTokenRecord[],
  modelInfo: ModelInfo | undefined
): BillingCounters {
  const counters: BillingCounters = {
    cumulativeCost: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  for (const billing of iterationBilling) {
    counters.inputTokens += billing.inputTokens;
    counters.outputTokens += billing.outputTokens;
    counters.cacheReadTokens += billing.cacheReadTokens;
    counters.cacheWriteTokens += billing.cacheWriteTokens;
  }
  if (iterationBilling.length > 0 && modelInfo) {
    counters.cumulativeCost = getTurnsCost(modelInfo, iterationBilling.map(iterationTurn));
  }
  return counters;
}

/**
 * Bill one completed iteration against the model's cumulative cost, advancing
 * `counters` in place. No-op unless the cost has grown since the last billed
 * iteration; a shrinking agent cost is surfaced with a warn (`logNegativeDelta`).
 */
export async function billIteration(params: BillIterationParams): Promise<void> {
  const { iterationIndex, checkpoint, counters, modelInfo, model, startTime, effects } = params;
  const toolUsage = params.toolUsage ?? ZERO_TOOL_USAGE;

  // Agent-only per-iteration token deltas (checkpoint totals are agent-loop only). These
  // are the resume-critical values summed to rebuild cumulative agent cost, so tool tokens
  // (a different model) must never enter them.
  const deltas: IterationTokenDeltas = {
    inputTokens: checkpoint.totalInputTokens - counters.inputTokens,
    outputTokens: checkpoint.totalOutputTokens - counters.outputTokens,
    cacheReadTokens: checkpoint.totalCacheReadTokens - counters.cacheReadTokens,
    cacheWriteTokens: checkpoint.totalCacheWriteTokens - counters.cacheWriteTokens,
  };

  // Price each request this bill covers on its own tier (see unbilledTurns), cache tokens at
  // their own rates: totalInputTokens EXCLUDES cache-read/write. Mirrors the chat path.
  const turns = unbilledTurns(checkpoint, counters, deltas, effects);
  const agentCostDelta = getTurnsCost(modelInfo, turns);
  const cumulativeCost = counters.cumulativeCost + agentCostDelta;
  // Settle the agent's own cost growth plus any tool-internal spend (#630). Tool spend is
  // already priced per-tool, so it adds directly as USD. Both terms are >= 0, so an
  // iteration with tool usage is always billable (never hits the no-op return below).
  const costDelta = agentCostDelta + toolUsage.costUsd;
  // Should be unreachable: a negative agent delta means the checkpoint totals fell behind
  // `counters` (resume reseeds them from the persisted deltas), i.e. the two have diverged.
  // Checked on the agent term alone so positive tool spend cannot mask it; the settle below is
  // unchanged (net <= 0 skips with counters left put, net > 0 charges the net).
  if (agentCostDelta < 0) {
    effects.logNegativeDelta({
      costDelta: agentCostDelta,
      toolCostUsd: toolUsage.costUsd,
      cumulativeCost,
      previousCumulativeCost: counters.cumulativeCost,
    });
  }
  if (costDelta <= 0) return;

  // Sanity backstop (#657): one provider request's input tokens can never exceed the
  // model's context window (totalInputTokens excludes cache-read/write, so this compares
  // like-for-like). A larger request means an upstream token-count corruption - a live agent
  // run reported ~49M input tokens on a ~72K-token prompt, which billed ~$148. Fail safe:
  // alarm and skip the credit charge rather than deduct a bogus amount.
  // Checked per request (the same turns priced above), so a bill legitimately covering two
  // requests cannot trip it on their sum. Corrupt totals stop reconciling with the adapter's
  // turns, so unbilledTurns falls back to the whole delta as one request (warning via
  // logTurnsFallback) and it still trips.
  // Guard on the AGENT input delta only (tool spend is a different, smaller model and is
  // not part of this sanity bound). On a trip we skip the whole iteration charge - the
  // snapshotted tool spend goes with it, consistent with dropping the agent charge; the
  // token counts that produced it were corrupt anyway.
  const requestInputTokens = Math.max(0, ...turns.map(turn => turn.inputTokens));
  if (modelInfo.contextWindow > 0 && requestInputTokens > modelInfo.contextWindow) {
    effects.logGuardTrip({ requestInputTokens, contextWindow: modelInfo.contextWindow });
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
  // iterationBilling record below stays agent-only. The ledger row and usage event carry the
  // agent model, but these token counts include tool tokens priced at the tools' own models,
  // so read credits/costUsd - never re-price tokens x model.
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
  // Same refund key the chat/CLI completion paths record: an iteration that ended
  // truncated or degenerate still bills normally (the provider tokens were spent) but
  // must not read as a clean, fully-valued success. See buildEarlyStopStamp.
  effects.recordUsageEvent({
    inputTokens: chargedInputTokens,
    outputTokens: chargedOutputTokens,
    cachedInputTokens: chargedCacheReadTokens,
    cacheWriteTokens: chargedCacheWriteTokens,
    costUsd: costDelta,
    creditsCharged: credits,
    status: buildEarlyStopStamp(checkpoint.finishReason)?.usageEventStatus ?? 'ok',
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

export type SubagentMediaSettlementEffects = {
  usdToCredits: (usd: number) => number;
  deductCredits: (credits: number) => Promise<void>;
  /** Mirrors the charge onto the child's `totalCreditsUsed` audit counter. */
  recordAuditCredits: (credits: number) => Promise<void>;
  /** Analytics dual-write, same shape as `billIteration`'s, so margin reporting sees this COGS. */
  recordUsageEvent: (event: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    cacheWriteTokens: number;
    costUsd: number;
    creditsCharged: number;
  }) => void;
};

/**
 * Charges the generated-media USD a dispatched subagent accrued via `foldGeneratedMediaUsd`.
 * That path has no per-iteration loop (and no token deduction yet), so media settles once,
 * after the run, on every exit: the provider cost was paid whether the run completed, was
 * aborted or threw. Drains `pending` so a second call cannot double-charge. Returns the
 * credits charged.
 */
export async function settleSubagentMediaUsage(
  pending: PendingToolUsage,
  effects: SubagentMediaSettlementEffects
): Promise<number> {
  const usage = takeToolUsage(pending);
  if (usage.costUsd <= 0) return 0;
  const credits = effects.usdToCredits(usage.costUsd);
  if (credits <= 0) return 0;
  await effects.deductCredits(credits);
  effects.recordUsageEvent({
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedInputTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    costUsd: usage.costUsd,
    creditsCharged: credits,
  });
  await effects.recordAuditCredits(credits);
  return credits;
}
