import { userLimitEventRepository, type RecordUserLimitEventInput } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';

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
