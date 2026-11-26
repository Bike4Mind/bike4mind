import {
  canSpawnDeeper,
  isAgentSession,
  isOrchestratorSession,
  type ChatSessionSummary,
  type OrchestratorLabel,
} from '@shared/chat';

type LabelInput = Pick<ChatSessionSummary, 'id' | 'orchestrate' | 'orchestrator' | 'orchestratorLabel' | 'origin'>;

export interface OrchestratorLabels {
  /** Sessions the sidebar marks: the automatic rule with each session's override applied. */
  shown: ReadonlySet<string>;
  /** Sessions the automatic rule alone would mark, so a menu can tell an override from the default. */
  automatic: ReadonlySet<string>;
}

/**
 * Which sessions read as orchestrators in the sidebar. A display label only: it never turns
 * Orchestrate on or lifts its spawn gate.
 *
 * Automatic rule: the session was made an orchestrator (isOrchestratorSession, so a relaunch does
 * not drop it) and can still start agents, or it has at least one agent child, live or archived,
 * however it was started (a prompt or a skill can orchestrate with the toggle off). Side chats
 * the user branched off are not agents (isAgentSession), so plain nesting stays unmarked. This is
 * the same evidence Agent View is earned by (orchestrator/agentsSurface.ts).
 *
 * A session's `orchestratorLabel` override ('on' / 'off') wins over the rule.
 */
export function orchestratorLabels(sessions: readonly LabelInput[]): OrchestratorLabels {
  const automatic = new Set<string>();
  for (const session of sessions) {
    if (isOrchestratorSession(session) && canSpawnDeeper(session)) automatic.add(session.id);
    if (session.origin && isAgentSession(session)) automatic.add(session.origin.parentSessionId);
  }
  const shown = new Set<string>();
  for (const session of sessions) {
    const label = session.orchestratorLabel;
    if (label === 'on' || (label !== 'off' && automatic.has(session.id))) shown.add(session.id);
  }
  return { shown, automatic };
}

/** The sessions the sidebar marks as orchestrators; see orchestratorLabels. */
export function orchestratorIds(sessions: readonly LabelInput[]): ReadonlySet<string> {
  return orchestratorLabels(sessions).shown;
}

/**
 * The label that flips what a row shows. Landing back on what the automatic rule says clears the
 * override instead of pinning it, so a later child (or its absence) still moves the label.
 */
export function toggledOrchestratorLabel(shown: boolean, automatic: boolean): OrchestratorLabel {
  const next = !shown;
  if (next === automatic) return 'auto';
  return next ? 'on' : 'off';
}
