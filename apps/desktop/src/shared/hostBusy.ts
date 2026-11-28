import type { ChatSessionStatusEvent } from './chat';
import type { HostBusySession } from './hostConnection';

/**
 * The sessions an update would interrupt: a turn running or waiting on the user, or background
 * commands still running. One definition for main (which asks before updating) and the panel
 * that counts the same sessions.
 */
export function busySessions(statuses: readonly ChatSessionStatusEvent[]): HostBusySession[] {
  return statuses
    .map(status => ({
      sessionId: status.sessionId,
      status: status.status,
      backgroundJobs: status.background?.running ?? 0,
    }))
    .filter(session => session.status !== 'done' || session.backgroundJobs > 0);
}
