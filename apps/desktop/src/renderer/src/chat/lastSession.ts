import { useEffect, useState } from 'react';
import type { ChatSessionSummary } from '@shared/chat';
import { LOCAL_HOST_ID } from '@shared/hostBridge';
import { isSessionPlace, type SessionPlace } from './rail/places';

/**
 * The conversation the user last had open, so the chat screen reopens it after a restart and
 * after a trip to another route (Profile unmounts the whole shell).
 *
 * Window chrome rather than anything about a conversation, so localStorage and not the session
 * file - the same reasoning, and the same blocked-storage fallback, as sidebarWidth.ts. The mode
 * rides along so the sidebar's Chat/Code switch is right on the first paint, before the summaries
 * that would say which mode the session is in have loaded.
 */
const STORAGE_KEY = 'b4m.chat.lastSession';

export interface LastSession {
  id: string;
  mode: SessionPlace;
}

export function readLastSession(): LastSession | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { id, mode } = parsed as Record<string, unknown>;
    if (typeof id !== 'string' || (mode !== 'chat' && mode !== 'code')) return null;
    return { id, mode };
  } catch {
    // Storage blocked or the value unreadable: nothing to reopen, which is a fresh install.
    return null;
  }
}

export function writeLastSession(session: LastSession): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    // Kept for this run by the shell's own state; only the next launch loses it.
  }
}

export function clearLastSession(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing stored can be read back either, so there is nothing stale to leave behind.
  }
}

/**
 * Whether the restore waits, and whether a remembered session missing once it stops waiting is gone
 * for good. A session on a remote host (sessionHostMemory) waits for that host's first listing, and
 * for main's host list while the host is not known yet; a local one never waits on a remote host.
 * Unlisted on a remote host that has not answered is not gone, so the pointer is kept for next time.
 */
export function restoreGate(input: {
  rememberedHost: string;
  /** The remembered host's listing state; undefined for a host not registered (or not known yet). */
  listing: 'loading' | 'pending' | 'live' | 'stale' | undefined;
  /** Whether main has answered the host list. */
  hostsListed: boolean;
  /** Whether the local host's first listing is still on its way. */
  localLoading: boolean;
  /** Whether the remembered session is already in the list. */
  listed: boolean;
}): { wait: boolean; forgetIfGone: boolean } {
  const { rememberedHost, listing, hostsListed, localLoading, listed } = input;
  if (rememberedHost === LOCAL_HOST_ID) return { wait: localLoading, forgetIfGone: true };
  const pending = listing === undefined ? !hostsListed : listing === 'loading' || listing === 'pending';
  return {
    wait: localLoading || (pending && !listed),
    forgetIfGone: listing === 'live' || (listing === undefined && hostsListed),
  };
}

/** The remembered session if it can still be opened: archived counts as gone. */
export function findRestorable(
  remembered: LastSession | null,
  sessions: readonly ChatSessionSummary[]
): ChatSessionSummary | null {
  if (!remembered) return null;
  return sessions.find(session => session.id === remembered.id && !session.archived) ?? null;
}

/**
 * Reopens the remembered conversation once the session list has loaded, and remembers each one
 * opened after that.
 *
 * Checked against the summaries the shell lists anyway, so restoring costs no read of its own.
 * `onRestore` is called exactly once, and only if something was remembered: with the session to
 * open, or null when it is gone - the stored value is already cleared by then, unless
 * `forgetIfGone` is false (its host has not answered, so gone may only mean not listed yet). While this returns
 * true the shell must not pick a session itself, or it would open the most recent one first and
 * then jump.
 *
 * `remembered` is read once on mount, so another window opening a conversation never moves this one.
 */
export function useLastSession(input: {
  /** What readLastSession returned when the shell mounted. */
  remembered: LastSession | null;
  loading: boolean;
  /** Whether a remembered session missing from `sessions` is gone for good; default true. */
  forgetIfGone?: boolean;
  sessions: readonly ChatSessionSummary[];
  activeId: string | null;
  onRestore: (session: ChatSessionSummary | null) => void;
}): boolean {
  const { remembered, loading, forgetIfGone = true, sessions, activeId, onRestore } = input;
  const [restoring, setRestoring] = useState(remembered !== null);

  useEffect(() => {
    if (!restoring || loading) return;
    setRestoring(false);
    const target = findRestorable(remembered, sessions);
    if (!target && forgetIfGone) clearLastSession();
    onRestore(target);
  }, [restoring, loading, forgetIfGone, remembered, sessions, onRestore]);

  // Keyed on the id and its mode rather than the list, which reloads on every status push.
  const activeMode = sessions.find(session => session.id === activeId)?.mode;
  useEffect(() => {
    // A Studio session is the Studio place's, never the conversation a restart reopens.
    if (restoring || !activeId || !activeMode || !isSessionPlace(activeMode)) return;
    writeLastSession({ id: activeId, mode: activeMode });
  }, [restoring, activeId, activeMode]);

  return restoring;
}
