import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChatSessionStatus, ChatSessionSummary } from '@shared/chat';
import type { PrSummary } from '@shared/pullRequest';
import { bufferUntrackedActivity, foldActivity, type AgentActivity } from './activity';
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
import { buildRoster, descendantIds, type AgentView } from './roster';

const NO_ACTIVITY: ReadonlyMap<string, AgentActivity> = new Map();
// Untracked ids remembered at once; the stream carries every session, so this must stay bounded.
const UNTRACKED_BUFFER_CAP = 16;

/**
 * What the tracked sessions' agents are doing right now, folded from the shared stream. Events from
 * any other session never reach state, so unrelated work never re-renders; the latest few are kept
 * aside and applied if their id becomes tracked.
 */
export function useAgentActivity(trackedIds: ReadonlySet<string>): ReadonlyMap<string, AgentActivity> {
  const [activity, setActivity] = useState(NO_ACTIVITY);
  // A ref, so a changing roster never resubscribes.
  const tracked = useRef(trackedIds);
  tracked.current = trackedIds;

  // Activity for ids not tracked yet, held in a ref so it never re-renders.
  const untracked = useRef(NO_ACTIVITY);

  useEffect(() => {
    return window.b4m.chat.onStreamEvent(event => {
      if (!tracked.current.has(event.sessionId)) {
        untracked.current = bufferUntrackedActivity(untracked.current, event, UNTRACKED_BUFFER_CAP);
        return;
      }
      // A live event supersedes anything buffered before the id was tracked.
      if (untracked.current.has(event.sessionId)) {
        const without = new Map(untracked.current);
        without.delete(event.sessionId);
        untracked.current = without;
      }
      setActivity(current => foldActivity(current, event));
    });
  }, []);

  useEffect(() => {
    const adopted = [...untracked.current].filter(([id]) => trackedIds.has(id));
    if (adopted.length === 0) return;
    const remaining = new Map(untracked.current);
    adopted.forEach(([id]) => remaining.delete(id));
    untracked.current = remaining;
    setActivity(current => {
      const next = new Map(current);
      adopted.forEach(([id, buffered]) => {
        if (!next.has(id)) next.set(id, buffered);
      });
      return next;
    });
  }, [trackedIds]);

  return activity;
}

export function useOrchestratorRoster(
  rootId: string | null,
  sessions: readonly ChatSessionSummary[],
  statuses: ReadonlyMap<string, ChatSessionStatus>,
  prSummaries: ReadonlyMap<string, PrSummary>
): AgentView[] {
  const trackedIds = useMemo(() => descendantIds(sessions, rootId), [sessions, rootId]);
  const activity = useAgentActivity(trackedIds);
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
