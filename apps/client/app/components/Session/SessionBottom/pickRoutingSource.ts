import type { IAgent } from '@bike4mind/common';

/**
 * Provenance of a routing decision. Kept in sync with
 * the `agentMode.source` zod enum in `@bike4mind/common` (llm.ts), the
 * `IChatHistoryItem.routingSource` type, and the `agent_execute` WS command enum.
 */
export type RoutingSource = 'mention' | 'agent_literal' | 'toggle' | 'classifier' | 'user-default' | 'complexity';

/**
 * Resolve provenance for a routing decision. Precedence mirrors
 * `routeQuery()`: explicit user signals (mention / `@agent` literal / manual
 * toggle) win over classifier inference, which wins over the always-on
 * preference, which wins over the rule-based complexity fallback. Returns
 * `undefined` when the route stays on `quest_processor`.
 *
 * `complexity` is the provenance for a send that reaches
 * `agent_executor` via `routeQuery`'s rule-based fallback (`autoRouteEnabled &&
 * complexity === 'complex'`, i.e. the `'auto'` Smart Routing default) - no
 * toggle, no classifier, no mention. Previously this path returned `undefined`,
 * leaving the auto-route unattributable and badge-less; naming it lets the
 * AutoRouteBadge render and the Dismiss opt-out cover it too.
 *
 * Extracted from `useSendMessage` so the precedence rules are unit-testable in
 * isolation (the exact place a future auto-route source can regress silently).
 */
export function pickRoutingSource(params: {
  routeTarget: 'quest_processor' | 'agent_executor';
  orchestrationAgent: IAgent | null;
  promptHasAgentLiteral: boolean;
  agentToggleActive: boolean;
  classifierUpgraded: boolean;
  agentDefaultOn: boolean;
  complexityUpgraded: boolean;
}): RoutingSource | undefined {
  if (params.routeTarget !== 'agent_executor') return undefined;
  if (params.orchestrationAgent) return 'mention';
  if (params.promptHasAgentLiteral) return 'agent_literal';
  if (params.agentToggleActive) return 'toggle';
  if (params.classifierUpgraded) return 'classifier';
  if (params.agentDefaultOn) return 'user-default';
  if (params.complexityUpgraded) return 'complexity';
  return undefined;
}
