import type { B4MLLMTools } from '@bike4mind/common';

/**
 * Tool whitelist for an agent-executor dispatch: a non-empty briefcase
 * `toolsOverride` wins (already resolved into `effectiveTools`) so an
 * `@`-mention can't drop the tools the prompt pinned; otherwise the agent's own
 * whitelist. The `length > 0` guard matches `resolveTools` (empty is no override).
 */
export function resolveDispatchTools(
  toolsOverride: B4MLLMTools[] | undefined,
  effectiveTools: B4MLLMTools[],
  agentAllowedTools: string[] | undefined
): string[] | undefined {
  return toolsOverride && toolsOverride.length > 0 ? effectiveTools : agentAllowedTools;
}
