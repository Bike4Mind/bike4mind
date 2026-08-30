import type { B4MLLMTools } from '@bike4mind/common';
import { AGENT_MODE_DEFAULT_TOOL_NAMES } from '@client/app/utils/agentOrchestration';

/**
 * Tool whitelist for an agent-executor dispatch, in precedence order:
 *
 * 1. A non-empty briefcase `toolsOverride` (already resolved into
 *    `effectiveTools`) wins, so an `@`-mention can't drop the tools the prompt
 *    pinned. The `length > 0` guard matches `resolveTools` (empty is no override).
 * 2. An `@`-mentioned agent's own non-empty whitelist.
 * 3. Agentless: the user's Smart Tools UNIONED with the agent-mode defaults.
 *
 * Case 3 is the agentless dispatch - the auto-route, the Agent-mode composer
 * toggle and the `@agent` literal alike, so the same visible composer state
 * never behaves two ways. The union is load-bearing: `buildSharedTools` only
 * surfaces tools named in `enabledTools`, so shipping the bare Smart Tools list
 * would strip `file_read` / `code_execute` / `coordinate_task` from every
 * agentless run. Sending nothing instead would silently drop the user's
 * `deep_research` / `chess_engine` / `web_scrape` picks, which is the bug this
 * exists to fix.
 *
 * With no Smart Tools selected there is nothing to preserve, so we return
 * `undefined` and let the server fall back to `profile.allowedTools` - the
 * ORG's admin-configured defaults, which are more authoritative than the
 * client's copy of the schema seed.
 *
 * Agentless is inferred from an absent/empty `agentAllowedTools` rather than an
 * explicit flag; that matches the server's own per-field fallback, where
 * `resolveTopLevelProfile` also reads an empty `allowedTools` as "use defaults".
 *
 * Never an authorization decision: `pickEffectiveEnabledTools` still ignores
 * this payload for a `toolsetIsExclusive` profile and subtracts `deniedTools`
 * last.
 */
export function resolveDispatchTools(
  toolsOverride: B4MLLMTools[] | undefined,
  effectiveTools: B4MLLMTools[],
  agentAllowedTools: string[] | undefined
): string[] | undefined {
  if (toolsOverride && toolsOverride.length > 0) return effectiveTools;
  if (agentAllowedTools && agentAllowedTools.length > 0) return agentAllowedTools;
  if (effectiveTools.length === 0) return undefined;
  return [...new Set<string>([...effectiveTools, ...AGENT_MODE_DEFAULT_TOOL_NAMES])];
}
