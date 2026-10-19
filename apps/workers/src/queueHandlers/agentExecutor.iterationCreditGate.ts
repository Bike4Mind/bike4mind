import type { AgentStep } from '@bike4mind/agents';
import type { ModelInfo } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import { uncoveredIterationCredits } from './agentExecutor.billing';
import type { AggregationGraceReason } from './agentExecutorUtils/truncatedReply';

export function aggregationGraceReasonOf(
  policy: UnrunnableModelPolicy & { isOverCap: boolean }
): AggregationGraceReason | undefined {
  if (!policy.isAggregationOnlyWake) return undefined;
  if (policy.hasModel && !policy.isRunnable) return 'model-unavailable';
  return policy.isOverCap ? 'credit-cap' : undefined;
}

/**
 * The loop belongs to `processExecution`, whose balance read and side effects are injected so
 * the policy below can be unit-tested without the executor's Mongo and AWS imports.
 */

/**
 * The first loop iteration of an aggregation-only wake, which returns already-paid-for child
 * results and is exempt from the per-iteration gate. -1 everywhere else.
 */
export function aggregationWakeStartIteration(isAggregationOnlyWake: boolean, iterationIndex: number): number {
  return isAggregationOnlyWake ? iterationIndex : -1;
}

export interface IterationGatePolicy {
  enforceCredits: boolean;
  /** Without a resolved model the next iteration cannot be priced. */
  hasModel: boolean;
  iterationIndex: number;
  wakeStartIteration: number;
}

/** Whether the loop re-checks the payer's balance before this iteration. */
export function shouldGateIteration(policy: IterationGatePolicy): boolean {
  return policy.enforceCredits && policy.hasModel && policy.iterationIndex !== policy.wakeStartIteration;
}

export interface UnrunnableModelPolicy {
  hasModel: boolean;
  isRunnable: boolean;
  isAggregationOnlyWake: boolean;
}

/**
 * Whether the run must be refused because its model is disabled or no longer entitled. An
 * aggregation-only wake is exempt: its children have already been paid for.
 */
export function refusesUnrunnableModel(policy: UnrunnableModelPolicy): boolean {
  return policy.hasModel && !policy.isRunnable && !policy.isAggregationOnlyWake;
}

export interface IterationCreditGateArgs {
  executionId: string;
  iterationIndex: number;
  modelInfo: ModelInfo;
  /** Input tokens the run's last request sent; the next iteration is priced at that size. */
  lastInputTokens: number;
  /** Live balance of whoever pays for the run, re-read so a snapshot cannot go stale. */
  readBalance: () => Promise<number>;
  /** Only read when the gate stops the run, so a live iteration never pays for a snapshot. */
  snapshot: () => { steps: AgentStep[]; partialAnswer: string | undefined };
}

export interface IterationCreditGateDeps {
  markFailed(executionId: string, error: { message: string }): Promise<void>;
  sendWs(action: string, payload: Record<string, unknown>): Promise<void>;
  persistRunAsQuest(executionId: string, message: string): Promise<void>;
  logger: Pick<Logger, 'warn'>;
}

/**
 * Stops the run when the payer's live balance cannot cover the next iteration. Returns true
 * when it stopped, so the caller can leave the loop.
 */
export async function stopUnfundedIteration(
  args: IterationCreditGateArgs,
  deps: IterationCreditGateDeps
): Promise<boolean> {
  const balance = await args.readBalance();
  const uncoveredCredits = uncoveredIterationCredits(balance, args.modelInfo, args.lastInputTokens);
  if (uncoveredCredits === undefined) return false;

  deps.logger.warn('[Credits] Balance cannot cover the next iteration; stopping execution', {
    balance,
    requiredCredits: uncoveredCredits,
    iterationIndex: args.iterationIndex,
  });
  const { steps, partialAnswer } = args.snapshot();
  await deps.markFailed(args.executionId, {
    message: 'Insufficient credits to continue agent execution',
  });
  await deps.sendWs('failed', { executionId: args.executionId, reason: 'insufficient_credits', partialResult: steps });
  await deps.persistRunAsQuest(
    args.executionId,
    partialAnswer ? `Stopped: out of credits. Partial response:\n\n${partialAnswer}` : 'Stopped: out of credits.'
  );
  return true;
}
