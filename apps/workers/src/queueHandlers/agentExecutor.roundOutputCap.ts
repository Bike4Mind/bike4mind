import type { ModelInfo } from '@bike4mind/common';
import type { ICompletionBackend } from '@bike4mind/llm-adapters';
import type { Logger } from '@bike4mind/observability';
import { estimateInputTokens, estimateToolTokens } from '@bike4mind/services/cliCompletions';
import {
  MIN_AFFORDABLE_OUTPUT_TOKENS,
  affordableRoundBudget,
  capRoundOutput,
  conservativeRoundInputUsd,
  gateEveryRound,
} from '@bike4mind/services/llm';

/**
 * Per-round output cap for an agent run, the executor's counterpart of the chat turn cap
 * (ChatCompletionProcess creditOutputCap) and the CLI round budget (cliCompletions.ts). The
 * per-iteration gate (agentExecutor.iterationCreditGate.ts) only checks that the balance covers a
 * reservation-sized iteration; this bounds what the round can actually cost, so one long answer
 * cannot settle past the payer's balance.
 */

/** Thrown from inside the agent's model call when the balance cannot buy even a short answer. */
export class UnaffordableRoundError extends Error {
  constructor(
    readonly balance: number,
    readonly minimumCredits: number
  ) {
    super('Insufficient credits to continue agent execution');
    this.name = 'UnaffordableRoundError';
  }
}

/**
 * Turns the refusal into an outcome the iteration loop branches on, next to the deadline guard's;
 * anything else is rethrown.
 */
export function outOfCreditsOutcome(error: unknown): { kind: 'out-of-credits'; error: UnaffordableRoundError } {
  if (error instanceof UnaffordableRoundError) return { kind: 'out-of-credits', error };
  throw error;
}

/**
 * Only a personal account without a paid plan is held to its balance. An organization's balance is a
 * hard stop at settlement already. Unlike chat, which caps a paid personal account at its balance plus
 * paidCompletionOverdraftCredits, a paid plan's agent rounds are left uncapped.
 */
export async function capsRoundOutput(payer: {
  enforceCredits: boolean;
  billedToOrganization: boolean;
  readHasPaidPlan: () => Promise<boolean>;
}): Promise<boolean> {
  if (!payer.enforceCredits || payer.billedToOrganization) return false;
  // Unknown plan: cap it. A paid account capped at its balance loses nothing it paid for.
  const hasPaidPlan = await payer.readHasPaidPlan().catch(() => false);
  return !hasPaidPlan;
}

export interface RoundOutputCapArgs {
  /** The model the run is billed at (the requested one, also on substituted runs). */
  modelInfo: ModelInfo;
  /** Live balance of the payer, re-read per round since each iteration settles before the next. */
  readBalance: () => Promise<number>;
  /** Input tokens of the run's last request; a floor under the character estimate. */
  lastInputTokens: () => number;
  /** False on an iteration the credit gate exempts (an aggregation-only wake's first). */
  isActive: () => boolean;
  logger: Pick<Logger, 'info'>;
}

/**
 * Wraps the agent's backend so each of its model calls has its output budget lowered to what the
 * payer's live balance can pay for once the round's input is priced, and throws
 * UnaffordableRoundError when that is below a short answer. Agent rounds run with
 * `executeTools: false`, so each call is one provider round.
 */
export function capAgentRoundOutput(llm: ICompletionBackend, args: RoundOutputCapArgs): ICompletionBackend {
  return gateEveryRound(llm, async (messages, options) => {
    if (!args.isActive()) return options;

    const inputTokens = Math.max(
      args.lastInputTokens(),
      estimateInputTokens(messages) + estimateToolTokens(options.tools ?? [])
    );
    const balance = await args.readBalance();
    const budget = affordableRoundBudget({
      modelInfo: args.modelInfo,
      // ReActAgent caches with a 5-minute TTL (buildCacheStrategy).
      inputUsd: conservativeRoundInputUsd(args.modelInfo, inputTokens, '5m'),
      inputTokens,
      availableCredits: balance,
      minimumOutputTokens: Math.max(1, Math.min(MIN_AFFORDABLE_OUTPUT_TOKENS, options.maxTokens ?? Infinity)),
    });
    if (!budget.affordable) throw new UnaffordableRoundError(balance, budget.minimumCredits);

    // A run without its own maxTokens leaves the budget to the adapter's default, which never
    // exceeds the model's output limit; the cap only needs setting when it is lower than that.
    if (options.maxTokens === undefined && budget.outputTokens >= args.modelInfo.max_tokens) return options;
    if (budget.outputTokens < (options.maxTokens ?? args.modelInfo.max_tokens)) {
      args.logger.info('[CREDIT_CAP] Agent round output budget lowered to what the balance can pay for', {
        model: args.modelInfo.id,
        maxTokens: options.maxTokens,
        affordableOutputTokens: budget.outputTokens,
      });
    }
    return capRoundOutput(options, budget.outputTokens);
  });
}
