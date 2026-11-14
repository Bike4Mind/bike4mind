import type { ModelInfo } from '@bike4mind/common';
import { sentBelowReasoningFloor } from '@bike4mind/llm-adapters/model-sizing';
import { DEFAULT_OUTPUT_MAX_TOKENS } from '@bike4mind/utils';

/**
 * LLM runtime knobs forwarded from the client are spread into the
 * `ReActAgent` constructor only when the client actually selected a value.
 * Passing `undefined` explicitly would clobber the agent's built-in defaults
 * (which rely on `?? default` fallbacks).
 *
 * `maxTokens` is the exception to that reasoning and is still spread conditionally for
 * shape consistency: the agent deliberately does NOT default it, because an absent budget
 * has to survive all the way to the provider call for the output ceiling to be sized for
 * the model (a fixed value starves models that reason inside that ceiling).
 *
 * `thinking` is forwarded whenever present, including `enabled: false`: the backends read
 * an explicit `enabled: false` as the off switch for adaptive-by-default models. It is
 * rebuilt as a plain object, never the persisted subdocument. Only `can_think` models get it,
 * so a non-thinking model never has a budget reserved. The gate and the 16000 default must stay
 * in sync with `chatThinking` in b4m-core/services/src/llm/ChatCompletionProcess.ts.
 */
export function buildReActAgentRuntimeConfig(
  execution: {
    temperature?: number;
    maxTokens?: number;
    thinking?: { enabled: boolean; budget_tokens?: number };
  },
  modelInfo: Pick<ModelInfo, 'can_think'> | undefined
): {
  temperature?: number;
  maxTokens?: number;
  thinking?: { enabled: boolean; budget_tokens: number };
} {
  return {
    ...(execution.temperature !== undefined && { temperature: execution.temperature }),
    ...(execution.maxTokens !== undefined && { maxTokens: execution.maxTokens }),
    ...(execution.thinking &&
      modelInfo?.can_think && {
        thinking: {
          enabled: execution.thinking.enabled,
          budget_tokens: execution.thinking.budget_tokens ?? 16000,
        },
      }),
  };
}

/**
 * The reasoning-floor shortfall to log for a run (see sentBelowReasoningFloor), measured with the
 * thinking the agent is actually built with. First invocation only: a continuation re-enters
 * processExecution with the same budget and would count the run twice.
 */
export function runReasoningShortfall(
  execution: Parameters<typeof buildReActAgentRuntimeConfig>[0],
  modelInfo: ModelInfo | undefined,
  isNewExecution: boolean
): { requested: number; floor: number } | undefined {
  if (!isNewExecution || !modelInfo) return undefined;
  return sentBelowReasoningFloor({
    requested: execution.maxTokens,
    fallback: DEFAULT_OUTPUT_MAX_TOKENS,
    modelInfo,
    modelMaxOutputTokens: modelInfo.max_tokens,
    thinking: buildReActAgentRuntimeConfig(execution, modelInfo).thinking,
  });
}
