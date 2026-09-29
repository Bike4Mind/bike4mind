import type { ChatMessage } from '@shared/chat';

/** Where the summary stops, so a long message cannot push the chevron off the line. */
const MAX_SUMMARY_CHARS = 64;

/**
 * The collapsed row for a message another conversation sent here.
 *
 * It names the SENDER first and the message second, which is the order that matters when the
 * row is one line in a transcript: the reader needs to know this is not the user talking before
 * they read a word of it.
 */
export function relaySummary(message: Pick<ChatMessage, 'content' | 'relay'>): string {
  const head = `Received message from ${message.relay?.fromTitle || 'another session'}`;
  const flat = message.content.replace(/\s+/g, ' ').trim();
  if (!flat) return head;
  return `${head}: ${flat.length <= MAX_SUMMARY_CHARS ? flat : `${flat.slice(0, MAX_SUMMARY_CHARS - 3)}...`}`;
}
