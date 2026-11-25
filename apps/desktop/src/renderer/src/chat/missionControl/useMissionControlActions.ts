import { useCallback } from 'react';
import { addPinnedPane, type OrchestratorLayout } from '../orchestrator/orchestratorLayout';
import { writeSurface, type SessionSurface } from '../orchestrator/orchestratorPrefs';

interface MissionControlActionsInput {
  activeId: string | null;
  /** The active session has agents, so it has a stage to add a pane to. */
  activeHasAgents: boolean;
  /** The active session's stage layout and its setter (useOrchestratorPrefs: saved at session scope). */
  layout: OrchestratorLayout;
  onLayoutChange(layout: OrchestratorLayout): void;
  /** The active session's surface setter; another session's is written to storage for when it opens. */
  setActiveSurface(surface: SessionSurface): void;
  /** Opens a session on the conversation screen (ChatShell's selectSession). */
  selectSession(sessionId: string): void;
}

/**
 * Mission Control's tile actions. Open puts a session on its Orchestrate stage, as the header's Agents button
 * would. Open beside adds it as a pinned pane to the active orchestration, or just opens it when there is none.
 */
export function useMissionControlActions({
  activeId,
  activeHasAgents,
  layout,
  onLayoutChange,
  setActiveSurface,
  selectSession,
}: MissionControlActionsInput) {
  const open = useCallback(
    (sessionId: string) => {
      if (sessionId === activeId) setActiveSurface('orchestrate');
      else writeSurface(sessionId, 'orchestrate');
      selectSession(sessionId);
    },
    [activeId, setActiveSurface, selectSession]
  );

  const openBeside = useCallback(
    (sessionId: string) => {
      if (activeId === null || !activeHasAgents || sessionId === activeId) {
        open(sessionId);
        return;
      }
      onLayoutChange(addPinnedPane(layout, sessionId));
      setActiveSurface('orchestrate');
      selectSession(activeId);
    },
    [activeId, activeHasAgents, layout, onLayoutChange, setActiveSurface, selectSession, open]
  );

  return { open, openBeside };
}
