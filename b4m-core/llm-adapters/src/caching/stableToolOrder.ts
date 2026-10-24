import type { ICompletionOptionTools } from '../backend';

/**
 * Tools sorted by name, so two requests offering the same tool set send byte-identical `tools`.
 *
 * Anthropic's prompt cache hashes tools BEFORE system, so the order the caller assembled them in
 * (the client's saved `enabledTools` array, prompt-recommended tools, server auto-adds) is part of
 * the cache key: two users with the same tools in a different order otherwise each pay a cache
 * write for the deployment-wide system prefix behind them. Code-unit comparison, not
 * localeCompare, so the order cannot depend on the host's locale. Returns a new array.
 */
export function sortToolsForStableCacheKey<T extends ICompletionOptionTools>(tools: readonly T[]): T[] {
  return [...tools].sort((left, right) => {
    const leftName = left.toolSchema.name;
    const rightName = right.toolSchema.name;
    if (leftName === rightName) return 0;
    return leftName < rightName ? -1 : 1;
  });
}
