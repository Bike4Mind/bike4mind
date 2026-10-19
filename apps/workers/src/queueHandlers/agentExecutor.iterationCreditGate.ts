/**
 * The per-iteration credit gate of `processExecution`'s loop.
 *
 * Extracted from the loop body so its stop condition and terminal side effects can be
 * unit-tested without a harness for the whole 3,500-line executor: the balance is re-read
 * from the live holder before every iteration, and a run the balance cannot carry is failed
 * with its partial answer instead of being allowed to settle below zero.
 */
import type { AgentStep } from '@bike4mind/agents';
import type { ModelInfo } from '@bike4mind/common';
import { organizationRepository, userRepository } from '@bike4mind/database';
import type { Logger } from '@bike4mind/observability';
import { uncoveredIterationCredits } from './agentExecutor.billing';

export interface IterationCreditGateArgs {
  executionId: string;
  iterationIndex: number;
  userId: string;
  /** The run's billing organization, or null when the user pays. */
  organization: { id: string } | null;
  modelInfo: ModelInfo;
  /** Input tokens the run's last request sent; the next iteration is priced at that size. */
  lastInputTokens: number;
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
  const holder = args.organization
    ? await organizationRepository.findById(args.organization.id)
    : await userRepository.findById(args.userId);
  const balance = holder?.currentCredits ?? 0;
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
