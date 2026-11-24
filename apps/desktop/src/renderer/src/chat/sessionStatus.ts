import type { ChatSessionStatus, ChatSessionStatusEvent, SessionBackgroundJobs, SessionSetupStep } from '@shared/chat';

/** What each state is called, in the one place both the badge and its aria-label read it from. */
export const STATUS_LABEL: Record<ChatSessionStatus, string> = {
  processing: 'Working',
  'needs-action': 'Needs you',
  done: 'Idle',
};

/**
 * The working spinner's colour, shared with the rail elbow into a working child (SessionList railSx)
 * so a busy branch reads as one colour from rail to badge. plainColor, not solidBg: solidBg is a fill
 * colour and sits at about 3:1 on the dark sidebar, while plainColor is tuned for contrast in both modes.
 */
export const WORKING_COLOR = 'primary.plainColor';
export const WORKING_COLOR_VAR = 'var(--joy-palette-primary-plainColor)';

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

/**
 * Fold the same pushes into the setup step of each session still being prepared (worktree,
 * dependency install, held first turn). Kept apart from the status map because it is orthogonal
 * to it: a preparing agent is 'processing' either way. Returns the map it was given when nothing
 * changed.
 */
export function applyPreparingEvents(
  current: ReadonlyMap<string, SessionSetupStep>,
  events: readonly ChatSessionStatusEvent[]
): ReadonlyMap<string, SessionSetupStep> {
  let next: Map<string, SessionSetupStep> | null = null;

  for (const event of events) {
    const soFar = next ?? current;
    if (soFar.get(event.sessionId) === event.preparing) continue;

    next ??= new Map(current);
    if (event.preparing) next.set(event.sessionId, event.preparing);
    else next.delete(event.sessionId);
  }

  return next ?? current;
}

export function applyUnreadReplyEvents(
  current: ReadonlySet<string>,
  events: readonly ChatSessionStatusEvent[]
): ReadonlySet<string> {
  let next: Set<string> | undefined;
  for (const event of events) {
    if ((next ?? current).has(event.sessionId) === (event.unreadReply === true)) continue;
    next ??= new Set(current);
    if (event.unreadReply) next.add(event.sessionId);
    else next.delete(event.sessionId);
  }
  return next ?? current;
}

/**
 * Fold the same pushes into each session's running wake-on-exit background jobs. Orthogonal to the
 * status like the setup step: a 'done' session can still be waiting on them. Every event carries the
 * full current value, so an event without `background` clears it. Returns the map it was given when
 * nothing changed.
 */
export function applyBackgroundEvents(
  current: ReadonlyMap<string, SessionBackgroundJobs>,
  events: readonly ChatSessionStatusEvent[]
): ReadonlyMap<string, SessionBackgroundJobs> {
  let next: Map<string, SessionBackgroundJobs> | null = null;

  for (const event of events) {
    const soFar = next ?? current;
    const known = soFar.get(event.sessionId);
    const incoming = event.background;
    if (known?.running === incoming?.running && known?.label === incoming?.label) continue;

    next ??= new Map(current);
    if (incoming) next.set(event.sessionId, { ...incoming });
    else next.delete(event.sessionId);
  }

  return next ?? current;
}
