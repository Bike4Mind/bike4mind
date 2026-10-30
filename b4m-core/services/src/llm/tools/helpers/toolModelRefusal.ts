import type { ToolContext } from '../base/types';
import { isModelRequiresSubscriptionError, type ModelAdmission } from '../../modelAdmission';

/**
 * Asserts a tool's model is admitted. A free-tier refusal is the caller's plan, not a fault, so it comes
 * back as the tool result (logged at warn) for the model to relay; any other refusal still throws, and the
 * backend's tool loop logs it at error. Returns null when the model is admitted.
 */
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
    if (!isModelRequiresSubscriptionError(error)) throw error;
    context.logger.warn(`[${toolName}] model requires a paid plan; returning the refusal to the model`, { modelId });
    return `Error: ${error.message}`;
  }
}
