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

export interface RelaySummaryParts {
  /** Text before the sender's name. Empty for a notice, which leads with the sender. */
  lead: string;
  sender: string;
  /** Text after the sender's name, ending with the message's first line when there is one. */
  tail: string;
}

/**
 * The collapsed row for a message another conversation sent here, split around the sender's name
 * so the thread can draw that name as a link.
 *
 * It names the SENDER first and the message second, which is the order that matters when the
 * row is one line in a transcript: the reader needs to know this is not the user talking before
 * they read a word of it. A 'done' notice is the app's own words, so it says only who finished.
 */
export function relaySummaryParts(message: Pick<ChatMessage, 'content' | 'display' | 'relay'>): RelaySummaryParts {
  const sender = message.relay?.fromTitle || 'another session';
  if (message.relay?.kind === 'done') {
    return { lead: '', sender, tail: ' finished the turn your message started' };
  }
  const project = message.relay?.fromProject ? ` (${message.relay.fromProject})` : '';
  const flat = displayText(message).replace(/\s+/g, ' ').trim();
  const clipped = flat.length <= MAX_SUMMARY_CHARS ? flat : `${flat.slice(0, MAX_SUMMARY_CHARS - 3)}...`;
  return { lead: 'Received message from ', sender, tail: clipped ? `${project}: ${clipped}` : project };
}

export function relaySummary(message: Pick<ChatMessage, 'content' | 'display' | 'relay'>): string {
  const { lead, sender, tail } = relaySummaryParts(message);
  return `${lead}${sender}${tail}`;
}
