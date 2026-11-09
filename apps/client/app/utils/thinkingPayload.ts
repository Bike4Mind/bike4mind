import { REASONING_SUPPORTED_MODELS, type ModelInfo } from '@bike4mind/common';

type ThinkingToggle = { enabled: boolean; budget_tokens: number } | undefined;
type ThinkingInfo = Pick<ModelInfo, 'thinkingAlwaysOn' | 'thinkingStyle'> | undefined;

/**
 * The `thinking` a send carries. A model whose thinking cannot be switched off gets none, so a
 * stored toggle cannot pin its effort: the server then plans it from the Reasoning Effort
 * preference or the query complexity.
 */
export function thinkingForSend(thinking: ThinkingToggle, info: ThinkingInfo): ThinkingToggle {
  return info?.thinkingAlwaysOn ? undefined : thinking;
}

export function isThinkingShownActive(thinking: ThinkingToggle, info: ThinkingInfo): boolean {
  return info?.thinkingAlwaysOn === true || thinking?.enabled === true;
}

/** Whether the Reasoning Effort preference applies to `model` and so has a control in Advanced Settings. */
export function offersReasoningEffort(model: string, info: ThinkingInfo): boolean {
  return (
    REASONING_SUPPORTED_MODELS.has(model) || (info?.thinkingAlwaysOn === true && info.thinkingStyle === 'adaptive')
  );
}
