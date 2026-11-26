import { isOrchestratorSession, type ChatSessionSummary } from '@shared/chat';

/**
 * Whether the active session can show Agent View (the orchestrator stage).
 *
 * Live agents always earn it. Without any, only an orchestrator that could still start one keeps it
 * and shows its empty scene: isOrchestratorSession, not the live roster or the launch-scoped
 * `orchestrate` flag, so archiving every agent or relaunching the app does not drop it. A session
 * that merely spawned agents loses it with them.
 */
export function agentsSurfaceAvailable(input: {
  session: Pick<ChatSessionSummary, 'orchestrate' | 'orchestrator'> | undefined;
  hasAgents: boolean;
  /** It has a project, room below the depth cap and a model sent tools (ChatShell's orchestrateCapable). */
  orchestrateCapable: boolean;
}): boolean {
  if (input.hasAgents) return true;
  return input.orchestrateCapable && input.session !== undefined && isOrchestratorSession(input.session);
}
