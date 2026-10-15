import type { ChatSessionStatus, ChatSessionStatusEvent } from '@shared/chat';

/** What each state is called, in the one place both the badge and its aria-label read it from. */
export const STATUS_LABEL: Record<ChatSessionStatus, string> = {
  processing: 'Working',
  'needs-action': 'Needs you',
  done: 'Idle',
};

/**
 * Fold status pushes from main into the map the sidebar reads.
 *
 * 'done' is stored as ABSENCE rather than as a value, so the map holds one entry per busy
 * conversation instead of one per conversation that has ever been opened, and a fresh map and
 * a fully idle one are the same thing.
 *
 * Returns the map it was given when nothing actually changed, so React can skip the render.
 */
export function applyStatusEvents(
  current: ReadonlyMap<string, ChatSessionStatus>,
  events: readonly ChatSessionStatusEvent[]
): ReadonlyMap<string, ChatSessionStatus> {
  let next: Map<string, ChatSessionStatus> | null = null;

  for (const event of events) {
    // Compared against what has been folded in so far, not the original: two events for one
    // session in the same batch have to see each other.
    const soFar = next ?? current;
    const unchanged =
      event.status === 'done' ? !soFar.has(event.sessionId) : soFar.get(event.sessionId) === event.status;
    if (unchanged) continue;

    next ??= new Map(current);
    if (event.status === 'done') next.delete(event.sessionId);
    else next.set(event.sessionId, event.status);
  }

  return next ?? current;
}
