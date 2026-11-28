import type { ChatSessionStatus, ChatSessionSummary } from '@shared/chat';
import { summaryHostId } from './sessionDirectory';

/** Sessions per host that are working or waiting on the user, the same two states the sidebar marks. */
export function runningSessionsByHost(
  sessions: readonly ChatSessionSummary[],
  statuses: ReadonlyMap<string, ChatSessionStatus>
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const session of sessions) {
    const status = statuses.get(session.id);
    if (status !== 'processing' && status !== 'needs-action') continue;
    const hostId = summaryHostId(session);
    counts.set(hostId, (counts.get(hostId) ?? 0) + 1);
  }
  return counts;
}
