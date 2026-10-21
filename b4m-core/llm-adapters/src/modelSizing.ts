import type { ModelInfo } from '@bike4mind/common';
import { resolveDispatchForRecord } from './dispatchResolver';
import { buildThinkingParams } from './thinkingParams';

export { resolveDispatchForRecord } from './dispatchResolver';
export { buildThinkingParams, reasonsWithinOutputBudget } from './thinkingParams';

/**
 * The max_tokens the adapter actually sends for a `maxTokens` request: the Anthropic adapters raise
 * it for thinking (buildThinkingParams), every other adapter sends it unchanged. Credit holds and
 * the member cap are priced on this, so they cover what the model may really produce.
 */
export function sentMaxTokensFor(
  modelInfo: ModelInfo,
  thinking: { enabled?: boolean; budget_tokens?: number } | null | undefined,
  maxTokens: number
): number {
  if (!thinking?.enabled || !modelInfo.can_think) return maxTokens;
  const adapterFamily = resolveDispatchForRecord(modelInfo)?.adapterFamily;
  if (adapterFamily !== 'anthropic-messages' && adapterFamily !== 'bedrock-anthropic') return maxTokens;
  return buildThinkingParams(modelInfo.id, modelInfo, thinking.budget_tokens ?? 16000, maxTokens).maxTokens;
}
