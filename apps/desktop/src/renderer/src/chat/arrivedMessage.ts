import type { ChatMessage } from '@shared/chat';

/** Marks a prompt drawn before main has stored it; main assigns the real id. */
export const OPTIMISTIC_ID_PREFIX = 'pending-';

/**
 * Add a message main pushed on its own: at the end of the thread, except that a boundary goes
 * ABOVE any prompt still drawn optimistically. An automatic compaction writes its boundary while
 * the prompt that set it off is on screen but not yet stored, and main stores that prompt below
 * the boundary - drawn the other way round, it would look like part of what was compacted away.
 */
export function appendArrived(messages: readonly ChatMessage[], arrived: ChatMessage): ChatMessage[] {
  if (!arrived.boundary) return [...messages, arrived];
  let at = messages.length;
  while (at > 0 && messages[at - 1].id.startsWith(OPTIMISTIC_ID_PREFIX)) at--;
  return [...messages.slice(0, at), arrived, ...messages.slice(at)];
}
