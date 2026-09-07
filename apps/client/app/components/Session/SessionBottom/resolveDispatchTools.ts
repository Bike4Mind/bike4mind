import type { B4MLLMTools } from '@bike4mind/common';

/**
 * Tool whitelist for an agent-executor dispatch, in precedence order:
 *
 * 1. A non-empty briefcase `toolsOverride` (already resolved into
 *    `effectiveTools`) wins, so an `@`-mention can't drop the tools the prompt
 *    pinned. The `length > 0` guard matches `resolveTools` (empty is no override).
 * 2. An `@`-mentioned agent's own non-empty whitelist.
 * 3. Agentless: the user's Smart Tools UNIONED with `agentModeDefaultTools`.
 *
 * Case 3 is the agentless dispatch - the auto-route, the Agent-mode composer
 * toggle and the `@agent` literal alike, so the same visible composer state
 * never behaves two ways. The union is load-bearing: `buildSharedTools` only
 * surfaces tools named in `enabledTools`, so shipping the bare Smart Tools list
 * would strip `web_search` / `retrieve_knowledge_content` / `recharts` /
 * `mermaid_chart` from every agentless run. Sending nothing instead would
 * silently drop the user's `deep_research` / `chess_engine` / `web_scrape`
 * picks, which is the bug this exists to fix.
 *
 * `agentModeDefaultTools` MUST come from the org's admin-configured
 * `orchestrationDefaults` (see `agentModeDefaultToolNames`), not a hardcoded
 * seed. The server does not intersect: a non-empty payload REPLACES
 * `profile.allowedTools` in `pickEffectiveEnabledTools`, so a seeded union here
 * would override an admin who narrowed the org toolbelt. What still holds
 * server-side regardless of this payload is `deniedTools` (subtracted last) and
 * a `toolsetIsExclusive` profile (ignores the payload outright).
 *
 * With no Smart Tools selected there is nothing to preserve, so we return
 * `undefined` and let the server resolve the profile itself - one less place
 * for the client's view of admin config to drift from the server's.
 *
 * Agentless is inferred from an absent/empty `agentAllowedTools` rather than an
 * explicit flag; that matches the server's own per-field fallback, where
 * `resolveTopLevelProfile` also reads an empty `allowedTools` as "use defaults".
 */
export function resolveDispatchTools(
  toolsOverride: B4MLLMTools[] | undefined,
  effectiveTools: B4MLLMTools[],
  agentAllowedTools: string[] | undefined,
  agentModeDefaultTools: ReadonlySet<string>
): string[] | undefined {
  if (toolsOverride && toolsOverride.length > 0) return effectiveTools;
  if (agentAllowedTools && agentAllowedTools.length > 0) return agentAllowedTools;
  if (effectiveTools.length === 0) return undefined;
  return [...new Set<string>([...effectiveTools, ...agentModeDefaultTools])];
}
