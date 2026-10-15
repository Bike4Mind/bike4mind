import type { ChatQueueEvent, ChatQueuedMessage } from '@shared/chat';

/**
 * The rules for messages coming BACK out of the queue.
 *
 * Kept as plain functions because these are the decisions worth pinning down: what happens to
 * text the user typed when their turn does not go out. Every path that removes a queued
 * message without sending it lands here, so there is one answer rather than one per caller.
 */

/**
 * Put returned text back in the composer without destroying what is already there.
 *
 * Appending rather than replacing is the whole point: a user who cancels a queued message
 * while halfway through typing the next one must not lose either. They end up in one box, in
 * the order they were written, which is also how "edit a queued message" works - cancel it,
 * and it is back in the input under the cursor.
 */
export function mergeIntoDraft(draft: string, returned: readonly ChatQueuedMessage[]): string {
  const text = returned
    .map(message => message.text.trim())
    .filter(Boolean)
    .join('\n');
  if (!text) return draft;
  return draft.trim() ? `${draft.replace(/\s+$/, '')}\n${text}` : text;
}

/**
 * Why the composer suddenly has text in it again, or null when it needs no explaining.
 *
 * 'cancelled' is the null case on purpose: the user pressed the X, and the text reappearing
 * where they can edit it IS the feedback. The other three happened TO them, and a message
 * they thought was sent silently reappearing is exactly the confusion this line prevents.
 */
export function describeReturn(returned: ChatQueueEvent['returned']): string | null {
  if (!returned || returned.messages.length === 0) return null;
  if (returned.reason === 'cancelled') return null;

  const one = returned.messages.length === 1;
  const subject = one ? 'your queued message' : `your ${returned.messages.length} queued messages`;
  const back = one ? 'It is back in the composer.' : 'They are back in the composer.';

  if (returned.reason === 'refused') {
    return returned.detail
      ? `Could not send ${subject}: ${returned.detail} ${back}`
      : `Could not send ${subject}. ${back}`;
  }
  const cause = returned.reason === 'stopped' ? 'You stopped the reply' : 'That reply failed';
  return `${cause}, so ${subject} ${one ? 'was' : 'were'} not sent. ${back}`;
}

/**
 * The pending row's text, clipped so a pasted wall of text cannot push the composer off screen.
 *
 * Line breaks are KEPT: a pending message grows by appending each further send on its own line,
 * so flattening it would run separate things the user said into one run-on sentence. The row
 * clamps its own height in CSS; this only bounds what is handed to it.
 */
export function queuedPreview(message: ChatQueuedMessage, limit = 400): string {
  const trimmed = message.text.replace(/[ \t]+/g, ' ').trim();
  if (!trimmed) return '(attachments only)';
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit).trimEnd()}...`;
}
