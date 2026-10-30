import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ChatSessionStatus, ChatSessionSummary } from '@shared/chat';
import type { PrSummary } from '@shared/pullRequest';
import { foldActivity, type AgentActivity } from './activity';
import {
  readDockOpen,
  readSurface,
  readView,
  writeDockOpen,
  writeSurface,
  writeView,
  type OrchestratorViewId,
  type SessionSurface,
} from './orchestratorPrefs';
import { buildRoster, type AgentView } from './roster';

const NO_ACTIVITY: ReadonlyMap<string, AgentActivity> = new Map();

/** What every session's agent is doing right now, folded from the one shared stream. */
export function useAgentActivity(): ReadonlyMap<string, AgentActivity> {
  const [activity, setActivity] = useState(NO_ACTIVITY);

  useEffect(() => {
    return window.b4m.chat.onStreamEvent(event => {
      setActivity(current => foldActivity(current, event));
    });
  }, []);

  return activity;
}

export function useOrchestratorRoster(
  rootId: string | null,
  sessions: readonly ChatSessionSummary[],
  statuses: ReadonlyMap<string, ChatSessionStatus>,
  prSummaries: ReadonlyMap<string, PrSummary>
): AgentView[] {
  const activity = useAgentActivity();
  return useMemo(
    () => (rootId === null ? [] : buildRoster({ sessions, statuses, activity, prSummaries, rootId })),
    [rootId, sessions, statuses, activity, prSummaries]
  );
}

interface OrchestratorPrefs {
  surface: SessionSurface;
  setSurface(surface: SessionSurface): void;
  view: OrchestratorViewId;
  setView(view: OrchestratorViewId): void;
  dockOpen: boolean;
  setDockOpen(open: boolean): void;
}

interface SessionPrefs {
  sessionId: string | null;
  surface: SessionSurface;
  view: OrchestratorViewId;
}

function readSessionPrefs(sessionId: string | null): SessionPrefs {
  return sessionId === null
    ? { sessionId, surface: 'chat', view: 'tavern' }
    : { sessionId, surface: readSurface(sessionId), view: readView(sessionId) };
}

/** Per-session surface and view, plus the global dock flag. Setters update state and storage together. */
export function useOrchestratorPrefs(sessionId: string | null): OrchestratorPrefs {
  const [prefs, setPrefs] = useState(() => readSessionPrefs(sessionId));
  const [dockOpen, setDockOpenState] = useState(readDockOpen);

  // Re-read during render rather than in an effect, so a session switch never paints the old session's mode.
  const current = prefs.sessionId === sessionId ? prefs : readSessionPrefs(sessionId);
  if (current !== prefs) setPrefs(current);

  const setSurface = useCallback(
    (surface: SessionSurface) => {
      if (sessionId === null) return;
      writeSurface(sessionId, surface);
      setPrefs(previous => ({ ...previous, sessionId, surface }));
    },
    [sessionId]
  );

  const setView = useCallback(
    (view: OrchestratorViewId) => {
      if (sessionId === null) return;
      writeView(sessionId, view);
      setPrefs(previous => ({ ...previous, sessionId, view }));
    },
    [sessionId]
  );

  const setDockOpen = useCallback((open: boolean) => {
    writeDockOpen(open);
    setDockOpenState(open);
  }, []);

  return { surface: current.surface, setSurface, view: current.view, setView, dockOpen, setDockOpen };
}
