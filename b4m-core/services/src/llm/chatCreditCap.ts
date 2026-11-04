import {
  CREDITS_PER_USD_COST,
  estimateStreamedOutputTokens,
  getTextModelCost,
  getTurnsCost,
  type IMessage,
  type ModelInfo,
  type PromptCacheTtl,
  type TurnUsage,
  withRequestTtlWrites,
} from '@bike4mind/common';
import type { ICompletionOptions } from '@bike4mind/llm-adapters';
import { MIN_AFFORDABLE_OUTPUT_TOKENS, affordableRoundBudget, type RoundBudget } from '../completionCreditBudget';

/**
 * Credit cap for one ChatCompletionProcess turn (web chat, /api/chat, Slack, voice proxy). The turn
 * may spend at most its hold, the payer's balance after the hold, and the overdraft allowance. Three
 * places enforce it: each provider round's output budget is lowered to what is left (beginRound,
 * applied through gateEveryRound so tool-loop rounds are covered too), the stream is stopped once
 * its streamed output alone has crossed the limit (recordStreamed), and settlement floors the
 * text charge at -allowance (settlementFloorCredits). Tool charges are billed in full. The CLI/API
 * wire path does the same in cliCompletions.ts with the helpers in completionCreditBudget.ts.
 */

/**
 * Shown under a reply that was cut short because the payer ran out of credits. An org member cannot
 * buy org credits, so the org copy points at the administrator (as buildInsufficientCreditsMessage).
 */
export function outOfCreditsNotice(organizationName?: string): string {
  return organizationName
    ? `_This answer was cut short because your organization "${organizationName}" ran out of credits. Contact your organization administrator to add more credits._`
    : '_This answer was cut short because your credit balance ran out. Add credits to continue._';
}

/**
 * How far past its balance one turn may run. Only a personal account on a paid plan gets the
 * configured allowance: an account without one is held to what it has, and an organization's
 * balance stays a hard stop (computeSettlementDelta floors it at zero already).
 */
export function completionOverdraftAllowance(params: {
  billedToOrganization: boolean;
  hasPaidPlan: boolean;
  allowanceCredits: number;
}): number {
  if (params.billedToOrganization || !params.hasPaidPlan) return 0;
  return Number.isFinite(params.allowanceCredits) ? Math.max(0, Math.floor(params.allowanceCredits)) : 0;
}

/**
 * The input side of a round priced at the dearest rate the provider can bill it at: uncached, or
 * written to the prompt cache (5-minute writes cost more than plain input, 1-hour writes more
 * still). The hold prices input at the plain rate, which is fine for an estimate but not for a cap.
 */
export function conservativeRoundInputUsd(modelInfo: ModelInfo, inputTokens: number, cacheTtl: PromptCacheTtl): number {
  if (!(inputTokens > 0)) return 0;
  const uncached = getTextModelCost(modelInfo, inputTokens, 0);
  const cacheWrite = getTextModelCost(
    modelInfo,
    0,
    0,
    0,
    inputTokens,
    inputTokens,
    cacheTtl === '1h' ? inputTokens : 0
  );
  return Math.max(uncached, cacheWrite);
}

/** Same heuristic as cliCompletions' estimateInputTokens (2.5 chars/token, deliberately high). */
export function estimateAddedInputTokens(messages: IMessage[]): number {
  const chars = messages.reduce(
    (sum, message) =>
      sum + (typeof message.content === 'string' ? message.content.length : JSON.stringify(message.content).length),
    0
  );
  return Math.ceil(chars / 2.5);
}

/** USD the rounds before this one cost, from the usage the adapter carries in `_internal` between rounds. */
export function accumulatedRoundsUsd(modelInfo: ModelInfo, internal: ICompletionOptions['_internal']): number {
  if (!internal) return 0;
  if (internal.accumTurnUsage?.length) return getTurnsCost(modelInfo, internal.accumTurnUsage);
  const input = internal.accumInputTokens ?? 0;
  const cacheRead = internal.accumCacheReadTokens ?? 0;
  const cacheWrite = internal.accumCacheWriteTokens ?? 0;
  return getTextModelCost(
    modelInfo,
    input,
    internal.accumOutputTokens ?? 0,
    cacheRead,
    cacheWrite,
    input + cacheRead + cacheWrite
  );
}

/** The token counts a turn settles on; ChatCompletionProcess's actualTokenUsage. */
export type SettledUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  turnUsage?: TurnUsage[];
};

/**
 * Takes the usage an adapter carried between rounds (`_internal.accum*`) into `usage` when a turn is
 * stopped before its terminal round, the only one that reports it. Never lowers a count already
 * reported, so a stop can only make settlement match what the provider billed, never undercut it.
 * Same rule as adoptAccumulatedUsage in cliCompletions.ts.
 */
export function adoptAccumulatedUsage(
  usage: SettledUsage,
  internal: ICompletionOptions['_internal'],
  cacheTtl: PromptCacheTtl
): void {
  if (!internal) return;
  const turns = internal.accumTurnUsage;
  if (turns?.length) {
    if (turns.length <= (usage.turnUsage?.length ?? 0)) return;
    usage.turnUsage = withRequestTtlWrites(turns, cacheTtl);
    // Turns are split cache-exclusive; Gemini's raw accumInputTokens includes cache reads.
    usage.inputTokens = turns.reduce((sum, turn) => sum + turn.inputTokens, 0);
    usage.outputTokens = turns.reduce((sum, turn) => sum + turn.outputTokens, 0);
    usage.cacheReadInputTokens = turns.reduce((sum, turn) => sum + (turn.cacheReadInputTokens ?? 0), 0);
    usage.cacheCreationInputTokens = turns.reduce((sum, turn) => sum + (turn.cacheCreationInputTokens ?? 0), 0);
    return;
  }
  usage.inputTokens = Math.max(usage.inputTokens ?? 0, internal.accumInputTokens ?? 0);
  usage.outputTokens = Math.max(usage.outputTokens ?? 0, internal.accumOutputTokens ?? 0);
  usage.cacheReadInputTokens = Math.max(usage.cacheReadInputTokens ?? 0, internal.accumCacheReadTokens ?? 0);
  usage.cacheCreationInputTokens = Math.max(usage.cacheCreationInputTokens ?? 0, internal.accumCacheWriteTokens ?? 0);
}

export type BeginRoundParams = {
  /** The model the credits are priced on (the ledger model). */
  modelInfo: ModelInfo;
  /** This round's whole prompt, for the long-context tier. */
  inputTokens: number;
  /** This round's input at its dearest rate (conservativeRoundInputUsd). */
  inputUsd: number;
  /** What the turn's earlier rounds cost (accumulatedRoundsUsd); 0 on the first. */
  spentUsd: number;
  /** The output ceiling the round would otherwise be sent with. */
  maxOutputTokens: number;
};

/**
 * Tracks one turn's spend against its limit. Not shared across turns: ChatCompletionProcess makes
 * one per turn once the hold is placed.
 */
export class TurnCreditLimiter {
  /** Set once the turn was stopped (a round it could not afford, or a stream that ran past the limit). */
  stoppedForCredits = false;

  private roundModel: ModelInfo | null = null;
  private roundCommittedCredits = 0;
  private roundStreamedChars = 0;
  private roundInputTokens = 0;

  constructor(
    /** The most the turn may spend in all: hold + balance after the hold + allowance. */
    readonly limitCredits: number,
    readonly allowanceCredits: number
  ) {}

  /**
   * Prices the next round and returns the output budget it can afford, or an unaffordable result
   * (which also marks the turn stopped). The budget never asks for less than
   * MIN_AFFORDABLE_OUTPUT_TOKENS (or the round's own ceiling, if smaller): below that a call is not worth making.
   */
  beginRound(params: BeginRoundParams): RoundBudget {
    const spentCredits = params.spentUsd * CREDITS_PER_USD_COST;
    this.roundModel = params.modelInfo;
    this.roundInputTokens = params.inputTokens;
    this.roundCommittedCredits = spentCredits + params.inputUsd * CREDITS_PER_USD_COST;
    this.roundStreamedChars = 0;
    const budget = affordableRoundBudget({
      modelInfo: params.modelInfo,
      inputUsd: params.inputUsd,
      inputTokens: params.inputTokens,
      availableCredits: this.limitCredits - spentCredits,
      minimumOutputTokens: Math.max(1, Math.min(MIN_AFFORDABLE_OUTPUT_TOKENS, params.maxOutputTokens)),
    });
    if (!budget.affordable) this.stoppedForCredits = true;
    return budget;
  }

  /**
   * Counts streamed output (hidden reasoning included) for the current round and returns true once
   * it has run the turn past its limit. The output is estimated with estimateStreamedOutputTokens, a
   * lower bound, so a stream is never stopped before it has really spent the limit; the per-round
   * output cap is what normally binds, and this only catches a round that overshot it.
   */
  recordStreamed(chars: number): boolean {
    if (this.stoppedForCredits) return true;
    if (!this.roundModel || !(chars > 0)) return false;
    this.roundStreamedChars += chars;
    const outputTokens = estimateStreamedOutputTokens(this.roundStreamedChars, this.roundModel.id);
    const outputCredits =
      getTextModelCost(this.roundModel, 0, outputTokens, 0, 0, this.roundInputTokens) * CREDITS_PER_USD_COST;
    if (this.roundCommittedCredits + outputCredits > this.limitCredits) {
      this.stoppedForCredits = true;
      return true;
    }
    return false;
  }

  /**
   * The lowest balance settlement may leave: -allowance. A text charge that would go below it (the
   * estimates above drift from the provider's counts) is floored there and reported as written off,
   * so the cap holds even then. Never raises a charge: actual usage below the floor is billed in full,
   * and tool charges are never floored.
   * Per turn only: the floor is applied to the hold-time balance snapshot, so concurrent turns of one
   * payer can together leave it lower.
   */
  settlementFloorCredits(): number {
    return -this.allowanceCredits;
  }
}

/**
 * The reconciliation delta for a capped turn: the full difference between hold and actual usage,
 * except that `cappedCredits` may not take the balance below `floorCredits` (see
 * settlementFloorCredits). `uncappedCredits` (tool charges) are billed in full on top and never
 * written off. Mirrors computeSettlementDelta, which is this with a floor of zero and no uncapped part.
 */
export function cappedSettlementDelta(
  reservedCredits: number,
  cappedCredits: number,
  balanceAfterHold: number,
  floorCredits: number,
  uncappedCredits = 0
): { delta: number; writtenOffCredits: number } {
  const delta = reservedCredits - cappedCredits;
  if (delta >= 0) return { delta: delta - uncappedCredits, writtenOffCredits: 0 };
  const collectable = Math.max(0, balanceAfterHold - floorCredits);
  if (-delta <= collectable) return { delta: delta - uncappedCredits, writtenOffCredits: 0 };
  return { delta: (collectable > 0 ? -collectable : 0) - uncappedCredits, writtenOffCredits: -delta - collectable };
}
