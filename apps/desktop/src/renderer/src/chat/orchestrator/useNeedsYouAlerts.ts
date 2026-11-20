import { useEffect, useRef, useState } from 'react';
import type { AttentionOpenEvent } from '@shared/attention';
import type { ChatSessionStatus, ChatSessionSummary } from '@shared/chat';
import { useNotifyScope } from '../notifyScopeSetting';
import { playChime } from './chime';
import { readPresenter } from './orchestratorPrefs';
import {
  alertableSessions,
  enteredNeedsYou,
  needsYouBody,
  needsYouCount,
  needsYouTitle,
  rootSessionOf,
} from '@shared/needsYou';

/**
 * Tells the user when an alertable session (an agent or a parent; any session when the notify scope
 * is `all`) starts needing them: a chime if the sound setting is on, an OS notice while the window is
 * not focused, and the dock badge kept at the number of sessions waiting. One notice per needs-action
 * entry. A clicked notice comes back on `onOpen`. A plain session the user is looking at (`viewingId`)
 * in a focused window is not announced: they can already see it asking.
 *
 * `loaded` is whether the first status snapshot has arrived. That snapshot is the baseline:
 * sessions already waiting when the window opened are not announced, only later entries are.
 * While no window is open main announces instead (main/attention/needsYouMonitor.ts), by the same
 * rules; a notice of its that reopened this window is handed to `onOpen` once its session is listed.
 */
export function useNeedsYouAlerts(
  sessions: readonly ChatSessionSummary[],
  statuses: ReadonlyMap<string, ChatSessionStatus>,
  loaded: boolean,
  onOpen: (event: AttentionOpenEvent) => void,
  viewingId: string | null
): void {
  const [scope] = useNotifyScope();
  const latestScope = useRef(scope);
  latestScope.current = scope;
  const latestViewingId = useRef(viewingId);
  latestViewingId.current = viewingId;
  const previous = useRef<ReadonlyMap<string, ChatSessionStatus> | null>(null);
  // Refs, so a session-list change between status pushes never re-announces anything.
  const latestSessions = useRef(sessions);
  latestSessions.current = sessions;
  const latestOnOpen = useRef(onOpen);
  latestOnOpen.current = onOpen;

  useEffect(() => {
    if (!loaded) return;
    const alertable = alertableSessions(latestSessions.current, latestScope.current);
    // Agent alerts keep firing for the viewed session, as they always have; only the wider scope skips it.
    const agentTree = alertableSessions(latestSessions.current, 'agents');
    const inView = (id: string) => id === latestViewingId.current && !agentTree.has(id) && document.hasFocus();
    const entered = previous.current ? enteredNeedsYou(previous.current, statuses).filter(id => alertable.has(id)) : [];
    previous.current = statuses;
    const viewed = entered.filter(inView);
    // Claimed without announcing, so another open window does not announce what this one shows.
    if (viewed.length > 0) {
      window.b4m.attention
        .claim(viewed)
        .catch((error: unknown) => console.warn(`Could not claim the viewed needs-you entry: ${String(error)}`));
    }
    const announced = entered.filter(id => !inView(id));
    if (announced.length === 0) return;
    void announce(announced, latestSessions.current);
  }, [statuses, loaded]);

  const count = needsYouCount(statuses, sessions, scope);
  useEffect(() => {
    void window.b4m.attention.setBadgeCount(count);
  }, [count]);
  // Signing out unmounts the chat, and nothing else would take its waiting sessions off the dock.
  useEffect(() => () => void window.b4m.attention.setBadgeCount(0), []);

  useEffect(() => window.b4m.attention.onOpen(event => latestOnOpen.current(event)), []);

  const [pendingOpen, setPendingOpen] = useState<AttentionOpenEvent | null>(null);
  useEffect(() => {
    const take = async () => {
      try {
        // Only a hit is kept: the take is once-only, so a second effect run (StrictMode) reads null
        // and must not wipe the event the first one got.
        const taken = await window.b4m.attention.takePendingOpen();
        if (taken) setPendingOpen(taken);
      } catch (error: unknown) {
        console.warn(`Could not read the clicked needs-you notice: ${String(error)}`);
      }
    };
    void take();
  }, []);
  // Held until the session list has loaded, since opening a session it does not list does nothing.
  useEffect(() => {
    if (!pendingOpen || !sessions.some(session => session.id === pendingOpen.rootId)) return;
    setPendingOpen(null);
    latestOnOpen.current(pendingOpen);
  }, [pendingOpen, sessions]);
}

/** Chime and notify for the entries this window wins; another open window announces the rest. */
async function announce(entered: readonly string[], sessions: readonly ChatSessionSummary[]): Promise<void> {
  // A failed claim must not silence the alert: worst case two windows both announce.
  const won = await window.b4m.attention.claim([...entered]).catch((error: unknown) => {
    console.warn(`Could not claim the needs-you entry: ${String(error)}`);
    return [...entered];
  });
  if (won.length === 0) return;
  playChime();
  if (document.hasFocus()) return;
  await Promise.all(
    won.map(sessionId =>
      notify(sessionId, sessions).catch((error: unknown) =>
        console.warn(`Could not show the needs-you notice: ${String(error)}`)
      )
    )
  );
}

/** The whole notice while Presenter mode is on (presenter.ts): a shared screen shows OS notices too. */
export const PRESENTER_NOTICE_TITLE = 'An agent needs you';

/** Tells a user who forgot Presenter mode is on why the notice is bare. */
export const PRESENTER_NOTICE_BODY = 'Presenter mode is on';

async function notify(sessionId: string, sessions: readonly ChatSessionSummary[]): Promise<void> {
  const rootId = rootSessionOf(sessions, sessionId);
  if (readPresenter()) {
    await window.b4m.attention.notify({ sessionId, rootId, title: PRESENTER_NOTICE_TITLE, body: PRESENTER_NOTICE_BODY });
    return;
  }
  const title = needsYouTitle(sessions, sessionId, rootId);
  // A session that cannot be read still gets its notice, just without the request spelled out.
  const session = await window.b4m.chat.getSession(sessionId).catch(() => null);
  await window.b4m.attention.notify({ sessionId, rootId, title, body: needsYouBody(session?.messages ?? []) });
}
