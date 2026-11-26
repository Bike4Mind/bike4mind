import { isOrchestratorSession, type ChatSessionSummary } from '@shared/chat';

/**
 * Whether the active session can show Agent View (the orchestrator stage).
 *
 * Its agents earn it, live or archived (archivedAgentsOf), however they were started, so archiving
 * them never takes away a view the user picked; the stage then shows its empty scene listing them.
 * With none at all, only an orchestrator that could still start one keeps it: isOrchestratorSession,
 * not the launch-scoped `orchestrate` flag, so a relaunch does not drop it. Availability never opens
 * the view by itself: a session's surface still defaults to chat (orchestratorPrefs).
 *
 * The session's orchestratorLabel override wins, so Agent View always matches the sidebar's
 * orchestrator icon (orchestratorLabels in ../orchestratorIds.ts): 'on' offers it before any agent
 * exists, 'off' takes it away while agents run (ChatShell then falls back to chat).
 */
export function agentsSurfaceAvailable(input: {
  session: Pick<ChatSessionSummary, 'orchestrate' | 'orchestrator' | 'orchestratorLabel'> | undefined;
  hasAgents: boolean;
  hasArchivedAgents: boolean;
  /** It has a project, room below the depth cap and a model sent tools (ChatShell's orchestrateCapable). */
  orchestrateCapable: boolean;
}): boolean {
  const label = input.session?.orchestratorLabel;
  if (label === 'on') return true;
  if (label === 'off') return false;
  if (input.hasAgents || input.hasArchivedAgents) return true;
  return input.orchestrateCapable && input.session !== undefined && isOrchestratorSession(input.session);
}
