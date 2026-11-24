import { useEffect, useRef, useState } from 'react';
import type { ChatSessionSummary } from '@shared/chat';

/**
 * The Studio session Create saves into: the remembered one while it is still open, else the most
 * recent. Null when there is none, which is the cue to start one. `sessions` is newest first, the
 * order main lists them in.
 */
export function pickStudioSession(sessions: readonly ChatSessionSummary[], remembered: string | null): string | null {
  const open = sessions.filter(session => session.mode === 'studio' && !session.archived);
  return (open.find(session => session.id === remembered) ?? open[0])?.id ?? null;
}

export const STUDIO_STARTING = 'Getting Studio ready...';
export const STUDIO_START_FAILED =
  'Studio could not start a session. Check that you are signed in, then open Studio again.';

/**
 * Binds the Studio place to a Studio session, starting one the first time the place is opened.
 *
 * One attempt per visit: a failed start (no account signed in, say) is reported and not retried
 * until the user leaves Studio and comes back, so a broken backend never turns into a loop of
 * create calls.
 */
export function useStudioSession(input: {
  /** The Studio place is showing. */
  active: boolean;
  /** The session list has not arrived yet, so "none" cannot be told from "not loaded". */
  loading: boolean;
  sessions: readonly ChatSessionSummary[];
  remembered: string | null;
  create: () => Promise<string>;
}): {
  sessionId: string | null;
  error: string | null;
  /** Points Create at a given Studio session, e.g. one opened from a notification. */
  select: (sessionId: string) => void;
} {
  const { active, loading, sessions, remembered, create } = input;
  const [chosen, setChosen] = useState<string | null>(remembered);
  const [error, setError] = useState<string | null>(null);
  const attempted = useRef(false);
  const picked = pickStudioSession(sessions, chosen);

  useEffect(() => {
    if (!active) {
      attempted.current = false;
      setError(null);
      return;
    }
    if (loading) return;
    if (picked) {
      if (picked !== chosen) setChosen(picked);
      return;
    }
    if (attempted.current) return;
    attempted.current = true;
    // main's own message arrives wrapped in Electron's IPC prefix, so the user gets a plain one.
    create().then(
      id => setChosen(id),
      () => setError(STUDIO_START_FAILED)
    );
  }, [active, loading, picked, chosen, create]);

  return { sessionId: picked, error, select: setChosen };
}
