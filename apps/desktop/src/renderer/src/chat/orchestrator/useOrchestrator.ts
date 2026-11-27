import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChatSessionStatus, ChatSessionSummary, SessionBackgroundJobs, SessionSetupStep } from '@shared/chat';
import type { PrSummary } from '@shared/pullRequest';
import { useSessionsEvents } from '../../host/useSessionEvents';
import { foldActivity, type AgentActivity } from './activity';
import {
  readAmbient,
  readDockOpen,
  readFocus,
  readLayout,
  readPresenter,
  readSurface,
  writeAmbient,
  writeDockOpen,
  writeFocus,
  writeLayout,
  writePresenter,
  writeSurface,
  type OrchestratorViewId,
  type SessionSurface,
} from './orchestratorPrefs';
import { singlePaneLayout, type OrchestratorLayout } from './orchestratorLayout';
import { buildRoster, descendantIds, type AgentView, type ParentView } from './roster';

const NO_ACTIVITY: ReadonlyMap<string, AgentActivity> = new Map();
/**
 * What the tracked sessions' agents are doing right now, folded from each one's event stream. A
 * session joining the roster is subscribed to and starts from its next event; one leaving it is
 * released and dropped.
 */
export function useAgentActivity(trackedIds: ReadonlySet<string>): ReadonlyMap<string, AgentActivity> {
  const [activity, setActivity] = useState(NO_ACTIVITY);

  useSessionsEvents(trackedIds, event => setActivity(current => foldActivity(current, event)));

  // Every session-list change rebuilds the set, so the prune below keys on its contents.
  const trackedKey = useMemo(() => [...trackedIds].sort().join('\n'), [trackedIds]);
  const tracked = useRef(trackedIds);
  tracked.current = trackedIds;

  useEffect(() => {
    const ids = tracked.current;
    setActivity(current => {
      const next = new Map([...current].filter(([id]) => ids.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [trackedKey]);

  return activity;
}

/** The roster plus the root session itself, which the Tavern draws as the Innkeeper. */
export interface OrchestratorScene {
  agents: AgentView[];
  parent: ParentView;
}

export function useOrchestratorRoster(
  rootId: string | null,
  sessions: readonly ChatSessionSummary[],
  statuses: ReadonlyMap<string, ChatSessionStatus>,
  prSummaries: ReadonlyMap<string, PrSummary>,
  preparing?: ReadonlyMap<string, SessionSetupStep>,
  background?: ReadonlyMap<string, SessionBackgroundJobs>
): OrchestratorScene {
  const trackedIds = useMemo(() => {
    const ids = descendantIds(sessions, rootId);
    if (rootId !== null) ids.add(rootId);
    return ids;
  }, [sessions, rootId]);
  const activity = useAgentActivity(trackedIds);
  const agents = useMemo(
    () =>
      rootId === null ? [] : buildRoster({ sessions, statuses, preparing, background, activity, prSummaries, rootId }),
    [rootId, sessions, statuses, preparing, background, activity, prSummaries]
  );
  const status = rootId === null ? undefined : statuses.get(rootId);
  const rootActivity = rootId === null ? undefined : activity.get(rootId);
  const parent = useMemo<ParentView>(
    () => ({ ...(status && { status }), ...(rootActivity && { activity: rootActivity }) }),
    [status, rootActivity]
  );
  return useMemo(() => ({ agents, parent }), [agents, parent]);
}

interface OrchestratorPrefs {
  surface: SessionSurface;
  setSurface(surface: SessionSurface): void;
  layout: OrchestratorLayout;
  setLayout(layout: OrchestratorLayout): void;
  /** The first pane's view: what the shell's scene-only behaviour (ambient settle, scene conversation) reads. */
  view: OrchestratorViewId;
  dockOpen: boolean;
  setDockOpen(open: boolean): void;
  ambient: boolean;
  setAmbient(on: boolean): void;
  focus: boolean;
  setFocus(on: boolean): void;
  presenter: boolean;
  setPresenter(on: boolean): void;
}

interface SessionPrefs {
  sessionId: string | null;
  projectDirectory: string | undefined;
  surface: SessionSurface;
  layout: OrchestratorLayout;
}

function readSessionPrefs(sessionId: string | null, projectDirectory: string | undefined): SessionPrefs {
  return sessionId === null
    ? { sessionId, projectDirectory, surface: 'chat', layout: singlePaneLayout('tavern') }
    : {
        sessionId,
        projectDirectory,
        surface: readSurface(sessionId),
        layout: readLayout(sessionId, projectDirectory),
      };
}

/**
 * Per-session surface and layout, plus the global dock, ambient, focus and presenter flags.
 * Setters update state and storage together.
 */
export function useOrchestratorPrefs(sessionId: string | null, projectDirectory?: string): OrchestratorPrefs {
  const [prefs, setPrefs] = useState(() => readSessionPrefs(sessionId, projectDirectory));
  const [dockOpen, setDockOpenState] = useState(readDockOpen);
  const [ambient, setAmbientState] = useState(readAmbient);
  const [focus, setFocusState] = useState(readFocus);
  const [presenter, setPresenterState] = useState(readPresenter);

  // Re-read during render rather than in an effect, so a session switch never paints the old session's mode.
  const current =
    prefs.sessionId === sessionId && prefs.projectDirectory === projectDirectory
      ? prefs
      : readSessionPrefs(sessionId, projectDirectory);
  if (current !== prefs) setPrefs(current);

  const setSurface = useCallback(
    (surface: SessionSurface) => {
      if (sessionId === null) return;
      writeSurface(sessionId, surface);
      setPrefs(previous => ({ ...previous, sessionId, surface }));
    },
    [sessionId]
  );

  const setLayout = useCallback(
    (layout: OrchestratorLayout) => {
      if (sessionId === null) return;
      writeLayout(sessionId, layout, projectDirectory);
      setPrefs(previous => ({ ...previous, sessionId, projectDirectory, layout }));
    },
    [sessionId, projectDirectory]
  );

  const setDockOpen = useCallback((open: boolean) => {
    writeDockOpen(open);
    setDockOpenState(open);
  }, []);

  const setAmbient = useCallback((on: boolean) => {
    writeAmbient(on);
    setAmbientState(on);
  }, []);

  const setFocus = useCallback((on: boolean) => {
    writeFocus(on);
    setFocusState(on);
  }, []);

  const setPresenter = useCallback((on: boolean) => {
    writePresenter(on);
    setPresenterState(on);
  }, []);

  return {
    surface: current.surface,
    setSurface,
    layout: current.layout,
    setLayout,
    view: current.layout.panes[0].view,
    dockOpen,
    setDockOpen,
    ambient,
    setAmbient,
    focus,
    setFocus,
    presenter,
    setPresenter,
  };
}
