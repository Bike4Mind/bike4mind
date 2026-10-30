import type { ToolContext } from '../base/types';
import { isModelRequiresSubscriptionError, type ModelAdmission } from '../../modelAdmission';

/**
 * A free-tier refusal is the caller's plan, not a fault: it becomes the tool result (logged at warn) for the
 * model to relay. Anything else is rethrown, and the backend's tool loop logs it at error.
 */
export function paidPlanRefusalOrRethrow(
  context: Pick<ToolContext, 'logger'>,
  error: unknown,
  modelId: string,
  toolName: string
): string {
  if (!isModelRequiresSubscriptionError(error)) throw error;
  context.logger.warn(`[${toolName}] model requires a paid plan; returning the refusal to the model`, { modelId });
  return `Error: ${error.message}`;
}

/** Asserts a tool's model is admitted; null when it is, the refusal text per paidPlanRefusalOrRethrow when not. */
export async function toolModelRefusal(
  context: Pick<ToolContext, 'logger'>,
  admission: Pick<ModelAdmission, 'assert'>,
  modelId: string,
  toolName: string
): Promise<string | null> {
  try {
    await admission.assert(modelId);
    return null;
  } catch (error) {
    return paidPlanRefusalOrRethrow(context, error, modelId, toolName);
  }
}
