import {
  REASONING_EFFORT_INCOMPATIBLE_WITH_TOOLS_MODELS,
  REASONING_SUPPORTED_MODELS,
  type ModelInfo,
} from '@bike4mind/common';

/**
 * Does this OpenAI model take `reasoning_effort`? The catalog answers for a model the id
 * set never heard of; an unstated catalog falls back to REASONING_SUPPORTED_MODELS, which
 * is exactly today's behavior. Never inferred from max_completion_tokens plus can_think.
 */
export function supportsOpenAIReasoningEffort(info: ModelInfo | undefined, modelId: string): boolean {
  return info?.openaiReasoningEffort === true || REASONING_SUPPORTED_MODELS.has(modelId);
}

/** Catalog first, so an explicit row wins; unstated falls back to the id set. */
export function openAIEffortIncompatibleWithTools(
  info: Pick<ModelInfo, 'effortIncompatibleWithTools'> | undefined,
  modelId: string
): boolean {
  return info?.effortIncompatibleWithTools ?? REASONING_EFFORT_INCOMPATIBLE_WITH_TOOLS_MODELS.has(modelId);
}
