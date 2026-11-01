/**
 * How a message names another conversation: `@[Title](session:<id>)`.
 *
 * The composer shows the user `@Title` and writes this form into the text it sends, so the
 * mention survives the queue, a merge with typed-ahead text and the stored transcript without a
 * side channel. The model reads it as-is (HOST_GUIDANCE says what it means) and the thread draws
 * it as a link. Main also reads it back: a session the user mentioned is one this conversation
 * may read even outside its own project (see ChatService.buildHostContext).
 */

const SESSION_ID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/** Global and stateful (`lastIndex`): always go through the helpers below rather than `.test` it. */
const MENTION = new RegExp(`@\\[([^\\]\\n]{1,200})\\]\\(session:(${SESSION_ID})\\)`, 'g');

export interface SessionMention {
  sessionId: string;
  title: string;
  start: number;
  end: number;
}

/** A title made safe to sit inside the brackets: no `]`, no line breaks. */
export function mentionTitle(title: string): string {
  const flat = title.replace(/[\]\r\n]+/g, ' ').trim();
  return flat || 'Untitled';
}

export function formatSessionMention(sessionId: string, title: string): string {
  return `@[${mentionTitle(title)}](session:${sessionId})`;
}

export function findSessionMentions(text: string): SessionMention[] {
  return [...text.matchAll(MENTION)].map(match => ({
    title: match[1],
    sessionId: match[2],
    start: match.index,
    end: match.index + match[0].length,
  }));
}
