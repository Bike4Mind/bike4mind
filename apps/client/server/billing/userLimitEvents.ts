import { userLimitEventRepository, type RecordUserLimitEventInput } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { isModelRequiresSubscriptionError } from '@bike4mind/services/llm/modelAdmission';

/**
 * Records a limit hit for the admin user timeline (see UserLimitEventModel). Called on refusal paths,
 * so it never throws: a failed write is logged and the refusal goes ahead unchanged.
 */
export const recordUserLimitEvent = async (input: RecordUserLimitEventInput): Promise<void> => {
  try {
    await userLimitEventRepository.record(input);
  } catch (error) {
    Logger.warn('[USER_LIMIT_EVENT] failed to record limit hit', {
      userId: input.userId,
      kind: input.kind,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

/** The CreditHoldAdapters.onInsufficientCredits every hold path in the apps passes. */
export const recordInsufficientCredits = async (event: {
  userId: string;
  reason: string;
  featureLabel: string;
  requiredCredits: number;
  availableCredits?: number;
}): Promise<void> =>
  recordUserLimitEvent({
    userId: event.userId,
    kind: 'insufficient_credits',
    details: {
      reason: event.reason,
      feature: event.featureLabel,
      requiredCredits: Math.ceil(event.requiredCredits),
      ...(event.availableCredits === undefined ? {} : { availableCredits: Math.floor(event.availableCredits) }),
    },
  });

/**
 * Records a model admission refusal when it is the paid-plan one. Classifying the error sits inside
 * the best-effort guard too, so nothing here can replace the refusal the caller rethrows.
 */
export const recordPaidPlanRefusal = async (userId: string, modelId: string, error: unknown): Promise<void> => {
  try {
    if (!isModelRequiresSubscriptionError(error)) return;
  } catch (classifyError) {
    Logger.warn('[USER_LIMIT_EVENT] could not classify model refusal', {
      userId,
      error: classifyError instanceof Error ? classifyError.message : String(classifyError),
    });
    return;
  }
  await recordUserLimitEvent({ userId, kind: 'model_requires_paid_plan', model: modelId });
};
