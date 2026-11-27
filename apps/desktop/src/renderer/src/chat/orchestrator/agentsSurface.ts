import type { ChatSessionSummary } from '@shared/chat';
import { isAutomaticOrchestrator, showsOrchestratorLabel } from '@shared/orchestratorLabels';

/**
 * Whether the active session can show Agent View (the orchestrator stage): exactly when the
 * sidebar shows its orchestrator icon (isAutomaticOrchestrator and the orchestratorLabel override,
 * in @shared/orchestratorLabels). Agents earn it, live or archived, so archiving them never takes
 * away a view the user picked. 'off' takes it away while agents run (ChatShell then falls back to
 * chat). A session that could start no agent still gets the stage when the rule or its label
 * gives it; the empty stage then says why (OrchestratorStage canStartAgents). Availability never
 * opens the view by itself: a session's surface still defaults to chat (orchestratorPrefs).
 */
export function agentsSurfaceAvailable(input: {
  session: Pick<ChatSessionSummary, 'orchestrate' | 'orchestrator' | 'orchestratorLabel' | 'origin'> | undefined;
  hasAgents: boolean;
  hasArchivedAgents: boolean;
}): boolean {
  const { session } = input;
  if (!session) return false;
  return showsOrchestratorLabel(
    session.orchestratorLabel,
    isAutomaticOrchestrator(session, input.hasAgents || input.hasArchivedAgents)
  );
}
