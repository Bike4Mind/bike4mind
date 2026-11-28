import {
  canSpawnDeeper,
  isAgentSession,
  isOrchestratorSession,
  type ChatSessionSummary,
  type OrchestratorLabel,
} from './chat';

type LabelInput = Pick<ChatSessionSummary, 'id' | 'orchestrate' | 'orchestrator' | 'orchestratorLabel' | 'origin'>;

export interface OrchestratorLabels {
  /** Sessions the sidebar marks: the automatic rule with each session's override applied. */
  shown: ReadonlySet<string>;
  /** Sessions the automatic rule alone would mark, so a menu can tell an override from the default. */
  automatic: ReadonlySet<string>;
}

/**
 * The automatic rule, for one session: it was made an orchestrator (isOrchestratorSession, so a
 * relaunch does not drop it) and can still start agents, or it has at least one agent child, live
 * or archived, however it was started. The sidebar icon and Agent View (agentsSurfaceAvailable)
 * both read this, so they always agree.
 */
export function isAutomaticOrchestrator(
  session: Pick<ChatSessionSummary, 'orchestrate' | 'orchestrator' | 'origin'>,
  hasAgentChild: boolean
): boolean {
  return hasAgentChild || (isOrchestratorSession(session) && canSpawnDeeper(session));
}

/** The override wins; without one ('auto' or absent), the automatic rule decides. */
export function showsOrchestratorLabel(label: OrchestratorLabel | undefined, automatic: boolean): boolean {
  if (label === 'on') return true;
  if (label === 'off') return false;
  return automatic;
}

/**
 * Which sessions read as orchestrators in the sidebar. A display label only: it never turns
 * Orchestrate on or lifts its spawn gate. Side chats are not agents (isAgentSession), so plain
 * nesting stays unmarked.
 */
export function orchestratorLabels(sessions: readonly LabelInput[]): OrchestratorLabels {
  const parents = new Set<string>();
  for (const session of sessions) {
    if (session.origin && isAgentSession(session)) parents.add(session.origin.parentSessionId);
  }
  const automatic = new Set<string>();
  const shown = new Set<string>();
  for (const session of sessions) {
    const isAutomatic = isAutomaticOrchestrator(session, parents.has(session.id));
    if (isAutomatic) automatic.add(session.id);
    if (showsOrchestratorLabel(session.orchestratorLabel, isAutomatic)) shown.add(session.id);
  }
  return { shown, automatic };
}

/**
 * The override to store for a wanted label. One that matches the automatic rule is stored as
 * 'auto' instead of pinned, so a later child (or its absence) still moves the label.
 */
export function settledOrchestratorLabel(wanted: OrchestratorLabel, automatic: boolean): OrchestratorLabel {
  if (wanted === 'auto') return 'auto';
  return (wanted === 'on') === automatic ? 'auto' : wanted;
}

/** The label that flips what a row shows; see settledOrchestratorLabel. */
export function toggledOrchestratorLabel(shown: boolean, automatic: boolean): OrchestratorLabel {
  return settledOrchestratorLabel(shown ? 'off' : 'on', automatic);
}
