import type { ModelInfo } from '@bike4mind/common';
import { resolveDispatchForRecord } from './dispatchResolver';
import { belowReasoningFloor, buildThinkingParams } from './thinkingParams';

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

/**
 * belowReasoningFloor for the max_tokens the adapter really sends. A thinking turn on an Anthropic
 * adapter is already raised to the floor there (sentMaxTokensFor), so it is not a shortfall. The
 * shortfall telemetry in ChatCompletionProcess, cliCompletions and the agent executor reads this.
 */
export function sentBelowReasoningFloor(
  args: Parameters<typeof belowReasoningFloor>[0] & {
    thinking: { enabled?: boolean; budget_tokens?: number } | null | undefined;
  }
): { requested: number; floor: number } | undefined {
  const { thinking, ...floorArgs } = args;
  const shortfall = belowReasoningFloor(floorArgs);
  if (!shortfall) return undefined;
  return sentMaxTokensFor(args.modelInfo, thinking, shortfall.requested) < shortfall.floor ? shortfall : undefined;
}
