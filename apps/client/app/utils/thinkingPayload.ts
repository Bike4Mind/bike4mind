import type { ModelInfo } from '@bike4mind/common';

type ThinkingInfo = Pick<ModelInfo, 'thinkingAlwaysOn'> | undefined;

/**
 * The `thinking` a send to this model carries. A model whose thinking cannot be switched off gets
 * none, so a stored toggle cannot pin its effort: the server plans it from the query complexity.
 * Anything that prices or sizes a request must read this rather than the stored toggle.
 */
export function thinkingForSend<T>(thinking: T | undefined, info: ThinkingInfo): T | undefined {
  return info?.thinkingAlwaysOn ? undefined : thinking;
}

export function isThinkingShownActive(thinking: { enabled?: boolean } | undefined, info: ThinkingInfo): boolean {
  return info?.thinkingAlwaysOn === true || thinking?.enabled === true;
}
