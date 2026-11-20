import { isClaudeModelId, type ModelInfo, type ReasoningEffort } from '@bike4mind/common';
import { chatReasoningEffortFor, type ICompletionOptions } from '@bike4mind/llm-adapters';

/** Reconciles the saved chat preference with this attempt's Thinking control. */
export function chatReasoningOptionsFor(
  model: ModelInfo,
  explicit: ReasoningEffort | undefined,
  thinking: ICompletionOptions['thinking']
): Pick<ICompletionOptions, 'reasoningEffort' | 'thinking'> {
  const reasoningEffort = chatReasoningEffortFor(model, explicit);
  return {
    reasoningEffort,
    thinking:
      isClaudeModelId(model.id) && model.thinkingStyle === 'adaptive' && reasoningEffort === 'none' && thinking?.enabled
        ? { ...thinking, enabled: false }
        : thinking,
  };
}
