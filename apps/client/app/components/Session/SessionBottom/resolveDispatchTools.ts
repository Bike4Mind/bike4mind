import type { B4MLLMTools } from '@bike4mind/common';

/**
 * What an agent-executor dispatch puts on the wire for its tool whitelist.
 *
 * The pair is deliberate: `enabledTools` alone cannot say whether it is a deliberate selection
 * or the composer's ambient state, and the server needs to know which - one replaces the
 * resolved profile's toolbelt, the other is unioned onto it.
 */
export interface DispatchToolSelection {
  /** `enabledTools` for the payload. `undefined` leaves the whole decision to the server. */
  enabledTools: string[] | undefined;
  /** `enabledToolsAreAmbient` for the payload. See `pickEffectiveEnabledTools`. */
  enabledToolsAreAmbient: boolean;
}

/**
 * Tool whitelist for an agent-executor dispatch, in precedence order:
 *
 * 1. A non-empty briefcase `toolsOverride` (already resolved into `effectiveTools`) wins, so an
 *    `@`-mention can't drop the tools the prompt pinned. The `length > 0` guard matches
 *    `resolveTools` (empty is no override). PINNED.
 * 2. An `@`-mentioned agent's own non-empty whitelist. PINNED.
 * 3. Agentless: the user's Smart Tools, marked AMBIENT.
 *
 * Case 3 is the agentless dispatch - the auto-route, the Agent-mode composer toggle and the
 * `@agent` literal alike, so the same visible composer state never behaves two ways.
 *
 * The user's picks have to reach the run (sending nothing silently drops their `deep_research` /
 * `chess_engine` / `web_scrape`) AND the org's agent-mode toolbelt has to survive them
 * (`buildSharedTools` only surfaces tools named in `enabledTools`, so a bare Smart Tools payload
 * would strip `web_search` / `retrieve_knowledge_content` / `recharts` / `mermaid_chart` from
 * every agentless run). Both hold only if the two sets are UNIONED - and the union happens
 * server-side, in `pickEffectiveEnabledTools`, against the profile the executor just resolved.
 *
 * That is why this function needs no view of admin config. It previously read the org's
 * `orchestrationDefaults` to build the union here, which put a client-derived copy of admin
 * config on the wire that could drift from what the server resolves - and left the client
 * guessing at org policy it has no authority over (an unreadable setting, an emptied
 * `allowedTools`) to decide whether the copy was safe to send.
 *
 * Agentless is inferred from an absent/empty `agentAllowedTools` rather than an explicit flag;
 * that matches the server's own per-field fallback, where `resolveTopLevelProfile` also reads an
 * empty `allowedTools` as "use defaults".
 */
export function resolveDispatchTools(
  toolsOverride: B4MLLMTools[] | undefined,
  effectiveTools: B4MLLMTools[],
  agentAllowedTools: string[] | undefined
): DispatchToolSelection {
  if (toolsOverride && toolsOverride.length > 0) {
    return { enabledTools: effectiveTools, enabledToolsAreAmbient: false };
  }
  if (agentAllowedTools && agentAllowedTools.length > 0) {
    return { enabledTools: agentAllowedTools, enabledToolsAreAmbient: false };
  }
  // Nothing to preserve, so say nothing rather than shipping an empty array the server would
  // have to read as "use the profile" anyway.
  if (effectiveTools.length === 0) {
    return { enabledTools: undefined, enabledToolsAreAmbient: false };
  }
  return { enabledTools: effectiveTools, enabledToolsAreAmbient: true };
}
