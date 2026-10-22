import type { ChatMessage } from '@shared/chat';

/**
 * How much more of a transcript mounts each time, in reply rounds: what opening one draws, and
 * what each approach to the top adds. Counted in rounds rather than messages because one reply
 * can carry a hundred of them, and a window of "the last few messages" would still be the whole
 * of a conversation that is three very long replies.
 */
export const WINDOW_STEP = 24;

/**
 * The part of a range of messages that is drawn: everything from `start` on, less the first
 * `skip` stored rounds of `messages[start]`.
 *
 * Anchored at its top rather than counted back from the end, so a reply streaming in at the
 * bottom grows the drawn part instead of pushing older turns back out of it.
 */
export interface ThreadWindow {
  start: number;
  skip: number;
}

/** A message's weight in the window: its stored rounds, and never less than one. */
export function unitsOf(message: ChatMessage): number {
  return Math.max(1, message.rounds?.length ?? 0);
}

/**
 * The window grown upward by `step` rounds, never past `from`. Only the messages it walks over
 * are looked at, so the cost of opening is the cost of what is drawn, not of the thread.
 */
export function extendWindow(
  messages: readonly ChatMessage[],
  from: number,
  current: ThreadWindow,
  step: number
): ThreadWindow {
  let remaining = step;
  if (current.skip >= remaining) return { start: current.start, skip: current.skip - remaining };
  remaining -= current.skip;
  for (let index = current.start - 1; index >= from; index--) {
    const units = unitsOf(messages[index]);
    if (units >= remaining) return { start: index, skip: units - remaining };
    remaining -= units;
  }
  return { start: Math.min(from, current.start), skip: 0 };
}

/** The window an open starts from: the last `step` rounds of messages[from..to). */
export function initialWindow(messages: readonly ChatMessage[], from: number, to: number, step: number): ThreadWindow {
  return extendWindow(messages, from, { start: to, skip: 0 }, step);
}

/**
 * The window held in state, fitted to the range as it is now: a new boundary can raise `from`
 * past it, and a range that shrank cannot leave it pointing beyond its end.
 */
export function clampWindow(window: ThreadWindow, from: number, to: number): ThreadWindow {
  if (window.start < from) return { start: from, skip: 0 };
  if (window.start > to) return { start: to, skip: 0 };
  return window;
}
