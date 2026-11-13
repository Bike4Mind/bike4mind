import type { ToolContext } from '../base/types';
import { isModelRequiresSubscriptionError, isOrgModelNotAllowedError, type ModelAdmission } from '../../modelAdmission';

/**
 * A free-tier or org-policy refusal is the caller's plan or org choice, not a fault: it becomes the tool result
 * (logged at warn) for the model to relay. Anything else is rethrown, and the backend's tool loop logs it at error.
 */
export function paidPlanRefusalOrRethrow(
  context: Pick<ToolContext, 'logger'>,
  error: unknown,
  modelId: string,
  toolName: string
): string {
  if (isOrgModelNotAllowedError(error)) {
    context.logger.warn(`[${toolName}] model not allowed by the organization; returning the refusal to the model`, {
      modelId,
    });
    return `Error: ${error.message}`;
  }
  if (!isModelRequiresSubscriptionError(error)) throw error;
  context.logger.warn(`[${toolName}] model requires a paid plan; returning the refusal to the model`, { modelId });
  return `Error: ${error.message}`;
}

/**
 * Appended to a toolModelRefusal refusal. Its callers take the model from the user's settings or a default,
 * never from a tool argument, so "choose a free-tier model" is not something the calling model can do:
 * without this it retries the same call until the failure guard (toolFailureGuard.ts) blocks the tool.
 */
const SETTINGS_MODEL_NOTE =
  " This model is set by the user's settings or the tool's default, not by this tool call, so calling the tool " +
  'again will be refused the same way. Do not retry it this turn: tell the user, who can upgrade their plan or ' +
  'pick a free-tier model in their settings.';

const ORG_POLICY_MODEL_NOTE =
  " This model is set by the user's settings or the tool's default, not by this tool call, so calling the tool " +
  'again will be refused the same way. Do not retry it this turn: tell the user, who can pick a model their ' +
  'organization allows in their settings.';

/**
 * Asserts a tool's model is admitted; null when it is, the refusal text per paidPlanRefusalOrRethrow when not.
 * For tools whose model is not a tool argument (see SETTINGS_MODEL_NOTE).
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
    const note = isOrgModelNotAllowedError(error) ? ORG_POLICY_MODEL_NOTE : SETTINGS_MODEL_NOTE;
    return paidPlanRefusalOrRethrow(context, error, modelId, toolName) + note;
  }
}
