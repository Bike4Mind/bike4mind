import type { ChatAutomaticOrigin, ChatMessage } from '@shared/chat';

/** Where the summary stops, so a long message cannot push the chevron off the line. */
const MAX_SUMMARY_CHARS = 64;

/**
 * What the thread shows for a message the app wrote, rather than what the model reads.
 *
 * The fallback is the whole point: messages stored before `display` existed have only the
 * model's copy, and showing that is a good deal better than an empty row. See ChatMessage.display.
 */
export function displayText(message: Pick<ChatMessage, 'content' | 'display'>): string {
  return message.display?.trim() || message.content;
}

const AUTOMATIC_HEADS: Record<ChatAutomaticOrigin['kind'], string> = {
  'auto-fix': 'Started by auto-fix',
  'background-exit': 'Background command finished',
  'agents-settled': 'Agents finished',
};

/** Short labels for the queue, keyed like AUTOMATIC_HEADS. */
export const AUTOMATIC_TAGS: Record<ChatAutomaticOrigin['kind'], string> = {
  'auto-fix': 'Auto-fix',
  'background-exit': 'Background',
  'agents-settled': 'Agents',
};

/** The collapsed row for a turn the app started: who started it, then what it is about. */
export function automaticSummary(message: Pick<ChatMessage, 'automatic'>): string {
  if (!message.automatic) return AUTOMATIC_HEADS['auto-fix'];
  const head = AUTOMATIC_HEADS[message.automatic.kind];
  const summary = message.automatic.summary;
  return summary ? `${head}: ${summary}` : head;
}

/**
 * The collapsed row for a message another conversation sent here.
 *
 * It names the SENDER first and the message second, which is the order that matters when the
 * row is one line in a transcript: the reader needs to know this is not the user talking before
 * they read a word of it.
 */
export function relaySummary(message: Pick<ChatMessage, 'content' | 'display' | 'relay'>): string {
  const head = `Received message from ${message.relay?.fromTitle || 'another session'}`;
  const flat = displayText(message).replace(/\s+/g, ' ').trim();
  if (!flat) return head;
  return `${head}: ${flat.length <= MAX_SUMMARY_CHARS ? flat : `${flat.slice(0, MAX_SUMMARY_CHARS - 3)}...`}`;
}
