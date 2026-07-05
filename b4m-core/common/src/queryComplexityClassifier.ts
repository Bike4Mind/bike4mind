import { z } from 'zod';
import { ResearchModeParamsSchema } from './llm';
import type { QueryComplexityType } from './schemas/query';

/**
 * Single source of truth for query-complexity classification and agent routing.
 *
 * Lives in `@bike4mind/common` (browser-safe, no server deps) so both the
 * client (`useSendMessage`, `LLMCommand`) and the server (`ChatCompletionInvoke`)
 * import the same implementation. Previously this was hand-mirrored in
 * `apps/client/app/utils` and `b4m-core/services/src/llm`, which drifted silently
 * whenever a routing rule changed.
 */

/**
 * Classifies the complexity of a query based on various factors including:
 * - Message patterns (simple greetings, basic questions)
 * - Tool usage (deep research, image generation, recharts, chess engine)
 * - Agent mentions or attachments
 * - File attachments
 * - Message length
 * - Analytical language patterns
 *
 * @param message - The user's message/query
 * @param sessionFabFileIds - Array of file IDs attached to the session
 * @param messageFileIds - Array of file IDs attached to the message
 * @param tools - Optional array of tools being used
 * @param researchMode - Optional research mode parameters
 * @param sessionAgentIds - Optional array of agent IDs attached to the session
 * @returns QueryComplexityType - 'simple', 'contextual', or 'complex'
 */
export function classifyQueryComplexity(
  message: string,
  sessionFabFileIds: string[],
  messageFileIds: string[],
  tools?: string[],
  researchMode?: z.infer<typeof ResearchModeParamsSchema>,
  sessionAgentIds?: string[]
): QueryComplexityType {
  // Simple queries: Basic questions without context requirements
  const simplePatterns = [
    /^what('s| is) your (favorite|preferred|best)/i,
    /^(tell me about|what about|how about)/i,
    /^(can you )?(recommend|suggest)/i,
    /^(what do you think|your opinion)/i,
    /^(define|what is|explain)/i,
    /^\s*(hi|hello|hey)\s*$/i, // Greetings
    /^\s*(thanks|thank you|thx)\s*$/i, // Thank you messages
    /^\s*(bye|goodbye|see you)\s*$/i, // Farewell messages
  ];

  // Check for tool-dependent features - always marks as complex because
  // rapid reply without tools produces confusing "I don't have X tools" responses
  const hasDeepResearch = tools?.includes('deep_research') || false;
  const hasImageGeneration = tools?.includes('image_generation') || false;
  const isResearchModeEnabled = researchMode?.enabled || false;
  const hasRecharts = tools?.includes('recharts') || false;
  const hasChessEngine = tools?.includes('chess_engine') || false;

  // If a tool-dependent feature is explicitly enabled, immediately return complex
  if (hasDeepResearch || isResearchModeEnabled || hasImageGeneration || hasRecharts || hasChessEngine) {
    return 'complex';
  }

  // Check for agent mentions first - these always require contextual processing
  const hasAgentMention = message.includes('@');
  const hasAttachedAgents = sessionAgentIds && sessionAgentIds.length > 0;
  const hasAgents = hasAgentMention || hasAttachedAgents;

  const complexIndicators = [
    hasAgents, // Agent mentions or attached agents
    message.length > 150, // Longer prompts
    sessionFabFileIds.length > 0, // Session files
    messageFileIds.length > 0, // Attached files
    /\b(compare|analyze|evaluate|critique|summarize)\b/i.test(message), // Analytical verbs
    /\b(why|because|reason)\b/i.test(message), // Explanatory questions
    /\b(\d{4}|\d{1,2}\/\d{1,2}\/\d{2,4})\b/.test(message), // Dates
  ];

  // Integration-context upgrade: queries mentioning Jira/GitHub/Confluence terms
  // should be at least 'contextual' to ensure adequate history and features.
  // Checked BEFORE simplePatterns so "define jira" -> 'contextual' (not 'simple').
  const hasIntegrationContext =
    /\b[A-Z][A-Z0-9]{1,9}-\d+\b/.test(message) ||
    /\b(board|sprint|backlog|epic|confluence|github|jira)\b/i.test(message);
  if (hasIntegrationContext) return 'contextual';

  // First check for simple patterns, but override if agents are involved
  if (!hasAgents && simplePatterns.some(pattern => pattern.test(message))) {
    return 'simple';
  }

  const complexityScore = complexIndicators.filter(Boolean).length;

  if (complexityScore >= 3) return 'complex';
  if (complexityScore >= 1) return 'contextual';

  return 'simple';
}

// ---------------------------------------------------------------------------
// Agent Executor Routing
// ---------------------------------------------------------------------------

export interface AgentRoutingContext {
  /** The user's message */
  message: string;
  /** Complexity classification from classifyQueryComplexity */
  complexity: QueryComplexityType;
  /** Whether agent executor is enabled for this user/org (feature flag) */
  agentExecutorEnabled: boolean;
  /**
   * Explicit user-side override. Set by the Agent-mode composer toggle.
   * `force_agent` short-circuits to `agent_executor`, `force_normal` forces
   * `quest_processor`. Honored as the first check so it overrides all
   * downstream rules (mention detection, complexity heuristic, feature flag).
   */
  userOverride?: 'force_agent' | 'force_normal';
  /**
   * Set by the caller when at least one mentioned agent has orchestration
   * fields configured (see `pickOrchestrationAgent`). Preserves the
   * `@specific-agent` dispatch path now that routeQuery is the single source
   * of truth - without this signal, mentioning an orchestration-configured
   * agent would silently fall back to the quest processor.
   */
  hasOrchestrationAgent?: boolean;
  /**
   * Whether the user has opted into heuristic auto-routing (Agent-mode default
   * `'auto'`). Gates ONLY the `complexity === 'complex'` rule below - explicit
   * signals (`force_agent` toggle, `@agent` literal, orchestration-agent
   * mention) dispatch regardless. Without this gate a query the classifier
   * deems `'complex'` (e.g. the recharts tool is enabled -> `'generate random
   * charts'`) would silently dispatch the executor while the composer toggle
   * reads OFF. Defaults to falsy (fail-closed: never auto-route unless opted in).
   */
  autoRouteEnabled?: boolean;
}

export type QueryRouteTarget = 'quest_processor' | 'agent_executor';

/**
 * Determine whether a query should be routed to the Agent Executor Lambda
 * instead of the standard ChatCompletionProcess (questProcessor).
 *
 * Routing rules (first match wins):
 * 1. `userOverride` -> forced route (Agent-mode toggle)
 * 2. Mentioned orchestration agent + feature enabled -> agent_executor
 *    (preserves the `@specific-agent` dispatch path)
 * 3. Feature flag off -> quest_processor
 * 4. Explicit `@agent` literal -> agent_executor (synthetic profile dispatch)
 * 5. Complex + feature enabled + `autoRouteEnabled` -> agent_executor
 * 6. Everything else -> quest_processor
 */
export function routeQuery(ctx: AgentRoutingContext): QueryRouteTarget {
  // User-side override takes precedence over all other rules. The toggle is
  // an explicit user intent; the classifier heuristic must never overturn it.
  if (ctx.userOverride === 'force_agent') return 'agent_executor';
  if (ctx.userOverride === 'force_normal') return 'quest_processor';

  // Existing `@specific-agent` orchestration path - when an orchestration-
  // configured agent is mentioned and the feature is enabled, dispatch.
  if (ctx.hasOrchestrationAgent && ctx.agentExecutorEnabled) {
    return 'agent_executor';
  }

  // Feature flag gate: if agent executor is not enabled, always use quest_processor
  if (!ctx.agentExecutorEnabled) {
    return 'quest_processor';
  }

  // Explicit @agent literal trigger routes to agent executor (synthetic profile)
  if (hasExplicitAgentLiteral(ctx.message)) {
    return 'agent_executor';
  }

  // Complex queries route to agent executor only when the user opted into
  // heuristic auto-routing (Agent-mode default 'auto'). With auto-routing off,
  // a 'complex' classification (e.g. the recharts tool is enabled) must NOT
  // dispatch the executor on its own - otherwise agent runs fire behind an OFF
  // composer toggle. Explicit signals above (force_agent / @agent / orchestration
  // agent) are unaffected.
  if (ctx.autoRouteEnabled && ctx.complexity === 'complex') {
    return 'agent_executor';
  }

  return 'quest_processor';
}

/**
 * Match the `@agent` literal trigger - distinct from generic `@<name>` mentions
 * (which target a specific persisted IAgent). The `@agent` trigger is a user's
 * explicit request for the ReAct agent mode. Exported so the M4 short-circuit
 * predicate list (`intentClassifierShortCircuits.ts`) re-exports it - single
 * source of truth keeps `routeQuery` and `evaluateShortCircuits` in lockstep.
 */
export function hasExplicitAgentLiteral(message: string): boolean {
  return /(?:^|\s)@agent\b/i.test(message);
}
