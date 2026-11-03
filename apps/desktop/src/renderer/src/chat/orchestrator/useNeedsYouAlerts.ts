import { useEffect, useRef } from 'react';
import type { AttentionOpenEvent } from '@shared/attention';
import type { ChatSessionStatus, ChatSessionSummary } from '@shared/chat';
import { playChime } from './chime';
import { enteredNeedsYou, needsYouBody, needsYouCount, needsYouTitle, rootSessionOf } from './needsYou';

const NO_STATUSES: ReadonlyMap<string, ChatSessionStatus> = new Map();

/**
 * Tells the user when any session (an agent or a parent) starts needing them: a chime if the sound
 * setting is on, an OS notice while the window is not focused, and the dock badge kept at the number
 * of sessions waiting. One notice per needs-action entry. A clicked notice comes back on `onOpen`.
 */
export function useNeedsYouAlerts(
  sessions: readonly ChatSessionSummary[],
  statuses: ReadonlyMap<string, ChatSessionStatus>,
  onOpen: (event: AttentionOpenEvent) => void
): void {
  const previous = useRef(NO_STATUSES);
  // Refs, so a session-list change between status pushes never re-announces anything.
  const latestSessions = useRef(sessions);
  latestSessions.current = sessions;
  const latestOnOpen = useRef(onOpen);
  latestOnOpen.current = onOpen;

  useEffect(() => {
    const entered = enteredNeedsYou(previous.current, statuses);
    previous.current = statuses;
    if (entered.length === 0) return;
    playChime();
    if (document.hasFocus()) return;
    for (const sessionId of entered) {
      notify(sessionId, latestSessions.current, statuses).catch((error: unknown) =>
        console.warn(`Could not show the needs-you notice: ${String(error)}`)
      );
    }
  }, [statuses]);

  const count = needsYouCount(statuses);
  useEffect(() => {
    void window.b4m.attention.setBadgeCount(count);
  }, [count]);

  useEffect(() => window.b4m.attention.onOpen(event => latestOnOpen.current(event)), []);
}

async function notify(
  sessionId: string,
  sessions: readonly ChatSessionSummary[],
  statuses: ReadonlyMap<string, ChatSessionStatus>
): Promise<void> {
  const rootId = rootSessionOf(sessions, sessionId);
  const title = needsYouTitle(sessions, statuses, sessionId, rootId);
  // A session that cannot be read still gets its notice, just without the request spelled out.
  const session = await window.b4m.chat.getSession(sessionId).catch(() => null);
  await window.b4m.attention.notify({ sessionId, rootId, title, body: needsYouBody(session?.messages ?? []) });
}
