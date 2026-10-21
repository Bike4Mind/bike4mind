import { useSyncExternalStore } from 'react';
import type { ChatSessionSummary } from '@shared/chat';

/**
 * Rows a sidebar group draws before it asks for "Show more". Must stay at or above
 * QUICK_SWITCH_LIMIT (grouping.ts): orderedSessions counts every row of a group, which is only
 * the drawn order while no hidden row can sit within the first nine.
 */
export const GROUP_ROW_CAP = 20;
export const GROUP_ROW_STEP = 10;

export interface CappedRows {
  /** In the group's own order: the first `limit` rows, then any kept row past them. */
  visible: ChatSessionSummary[];
  hidden: number;
  /** The limit that reveals the next GROUP_ROW_STEP hidden rows, or all of them if fewer remain. */
  nextLimit: number;
}

/**
 * The rows a group draws under `limit`. A kept row past the limit is drawn in its own place
 * rather than pulling the window out to it, so one active session far down a 500-row project
 * costs one row, not 480.
 */
export function capRows(
  sessions: readonly ChatSessionSummary[],
  limit: number,
  keep: (session: ChatSessionSummary) => boolean
): CappedRows {
  if (sessions.length <= limit) return { visible: [...sessions], hidden: 0, nextLimit: limit };
  const visible = sessions.slice(0, limit);
  let nextLimit = sessions.length;
  let revealed = 0;
  for (let index = limit; index < sessions.length; index++) {
    const session = sessions[index];
    if (keep(session)) {
      visible.push(session);
      continue;
    }
    revealed++;
    if (revealed === GROUP_ROW_STEP && nextLimit === sessions.length) nextLimit = index + 1;
  }
  return { visible, hidden: sessions.length - visible.length, nextLimit };
}

// Per group key, for this run only: a sidebar collapse, a mode switch or a remount keeps them,
// a relaunch starts every group at the cap again.
const limits = new Map<string, number>();
const raised = new Map<string, Set<string>>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function groupLimit(key: string): number {
  return limits.get(key) ?? GROUP_ROW_CAP;
}

export function setGroupLimit(key: string, limit: number): void {
  if (limit <= GROUP_ROW_CAP) limits.delete(key);
  else limits.set(key, limit);
  for (const listener of listeners) listener();
}

/** Ids of the rows a group has drawn past its cap, which keep drawing after they stop being kept. */
export function raisedRows(key: string): Set<string> {
  let ids = raised.get(key);
  if (!ids) raised.set(key, (ids = new Set()));
  return ids;
}

export function useGroupLimit(key: string): number {
  const read = () => groupLimit(key);
  return useSyncExternalStore(subscribe, read, read);
}
