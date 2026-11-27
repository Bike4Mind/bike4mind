import type { ICompletionOptions } from './backend';

type EvaluationTransport = NonNullable<NonNullable<ICompletionOptions['_internal']>['evaluation']>;
type EvaluationUsage = Parameters<EvaluationTransport['reconcile']>[0];

/**
 * Settles an evaluation receipt once the provider has answered. The provider has already billed
 * the call, so a failure here must not propagate: the completion's catch would refund the platform
 * credits for spend that really happened. Instead the receipt is marked unknown, which keeps its
 * full reservation and blocks further admission until it is recovered, and the error is logged.
 */
export async function reconcileAfterDispatch(
  evaluation: EvaluationTransport,
  readUsage: () => EvaluationUsage,
  logger: { error(...args: unknown[]): void }
): Promise<void> {
  try {
    await evaluation.reconcile(readUsage());
  } catch (error) {
    logger.error('Evaluation reconcile failed after provider dispatch; receipt left unknown', error);
    try {
      await evaluation.unknown();
    } catch (unknownError) {
      logger.error('Evaluation receipt could not be marked unknown', unknownError);
    }
  }
}
