import { ModelBackend, type ModelInfo } from '@bike4mind/common';
import type { ICompletionOptions } from '@bike4mind/llm-adapters';

type ThinkingOption = ICompletionOptions['thinking'];

/**
 * Ollama turns thinking ON for a thinking-capable model (qwen3 and the like) sent no `think`
 * flag, so a turn with the Thinking toggle off still reasons at length. For an Ollama can_think
 * model with no thinking option this returns an explicit `enabled: false`, which OllamaBackend
 * sends as `think: false`. Every other model keeps the option as given: DeepSeek and Kimi map
 * `enabled: false` to an explicit "disabled" request, which is not what an absent flag means
 * there. Shared by cliCompletions and ChatCompletionProcess.
 */
export function withOllamaThinkingDefault(
  thinking: ThinkingOption,
  modelInfo: Pick<ModelInfo, 'backend' | 'can_think'> | undefined
): ThinkingOption {
  if (thinking || modelInfo?.backend !== ModelBackend.Ollama || !modelInfo.can_think) return thinking;
  // budget_tokens is required by the type but unread when thinking is off.
  return { enabled: false, budget_tokens: 0 };
}
