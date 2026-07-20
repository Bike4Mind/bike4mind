import { matchesAnyPattern } from '@bike4mind/agents';

/**
 * Tool policy for the public embed chat surface: which tools an anonymous end-user's
 * completion may ever materialize. The resolver output feeds buildSharedTools'
 * enabledTools (exact names), so a tool absent from the result is never built, never
 * advertised to the model, and never executable - the hardest possible gate.
 *
 * The policy is deliberately app-side (next to the route it governs) rather than in
 * b4m-core: the core registry stays generic; what is safe for THIS surface is this
 * surface's decision.
 */

/**
 * Default-on base: KB retrieval is the embed feature. Always scoped by kbScope on the
 * route (see registerEmbedRoutes) - never owner-wide. deniedTools can still remove these
 * (deny wins over everything).
 */
export const EMBED_KB_DEFAULT_TOOLS = ['search_knowledge_base', 'retrieve_knowledge_content'] as const;

/**
 * The ONLY additional tools an embed agent may opt into via allowedTools. Wildcard
 * patterns are matched against THIS list, never the full registry - so `*` grants at
 * most this curated set and can never reach an excluded tool.
 *
 * Inclusion bar: read-only external/public data or pure compute; no owner-state writes,
 * no persistence (embed is stateless), no owner-private reads, no open-ended spend.
 * Excluded and why (fail-closed - when unsure, leave it out):
 *   - delegate_to_agent / coordinate_task: orchestration (also structurally impossible -
 *     the route wires no agentStore/dagDispatcher).
 *   - image_generation / edit_image / edit_file / blog_*: owner-state mutation.
 *   - skill: reads the owner's private skill templates into an anonymous session.
 *   - generate_jupyter_notebook / excel_generation: persist session-scoped files;
 *     embed has no session.
 *   - deep_research / prompt_enhancement: unbounded/pointless LLM spend on the org's
 *     credits for an anonymous caller.
 *   - recharts / mermaid_chart: stream raw artifact markup onto the embed SSE wire
 *     (see toolStreamingHelper), which the plain-text embed protocol does not carry.
 *   - navigate_view: host-app navigation intents; meaningless in an isolated iframe.
 */
export const EMBED_OPT_IN_TOOLS = [
  'web_search',
  'web_fetch',
  'wolfram_alpha',
  'fmp_financial_data',
  'math_evaluate',
  'dice_roll',
  'current_datetime',
  'chess_engine',
  'weather_info',
  'wikipedia_on_this_day',
  'moon_phase',
  'sunrise_sunset',
  'iss_tracker',
  'planet_visibility',
] as const;

/**
 * Resolve the exact tool-name set an embed run may expose: KB defaults plus opt-in
 * matches from the curated universe, minus deny (deny wins over everything, including
 * the KB defaults). Pure - unit-testable with zero mocks. Both pattern lists come from
 * trusted server-side agent config, never from the request.
 */
export function resolveEmbedTools(hydrated: { allowedTools: string[]; deniedTools: string[] }): string[] {
  const { allowedTools, deniedTools } = hydrated;

  const optedIn = allowedTools.length ? EMBED_OPT_IN_TOOLS.filter(name => matchesAnyPattern(name, allowedTools)) : [];
  const union = [...EMBED_KB_DEFAULT_TOOLS, ...optedIn];
  const afterDeny = deniedTools.length ? union.filter(name => !matchesAnyPattern(name, deniedTools)) : union;

  return Array.from(new Set(afterDeny));
}
