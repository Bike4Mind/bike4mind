import { messagesSinceBoundary, type ChatMessage, type ChatSession } from '@shared/chat';

/** The longest selection a side chat carries; the rest is cut with a marker. */
export const SIDE_CHAT_SELECTION_LIMIT = 6_000;
/** Budget for the parent excerpt as a whole, newest messages first. */
export const SIDE_CHAT_CONTEXT_LIMIT = 12_000;
/** No single parent message may take more than this of the excerpt. */
const PER_MESSAGE_LIMIT = 2_000;

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit).trimEnd()} [...]`;
}

function quoteBlock(text: string): string {
  return text
    .split('\n')
    .map(line => `> ${line}`.trimEnd())
    .join('\n');
}

/**
 * The tail of the parent conversation a side chat opens with: the user's and the model's words
 * since the last /clear or /compact (the compaction summary included), oldest first.
 *
 * An excerpt rather than a copy of the transcript: a copy would carry the parent's tool calls and
 * artifacts into a conversation that never made them, and grow with every turn of the parent.
 */
export function parentExcerpt(messages: readonly ChatMessage[], limit = SIDE_CHAT_CONTEXT_LIMIT): string {
  const lines: string[] = [];
  let used = 0;
  const spoken = messagesSinceBoundary(messages).filter(
    message => (message.role === 'user' || message.role === 'assistant') && message.content.trim()
  );
  for (let index = spoken.length - 1; index >= 0; index--) {
    const message = spoken[index];
    const speaker = message.system ? 'App' : message.role === 'user' ? 'User' : 'Assistant';
    const line = `${speaker}: ${clip(message.content.trim(), PER_MESSAGE_LIMIT)}`;
    if (used + line.length > limit) break;
    lines.unshift(line);
    used += line.length;
  }
  return lines.join('\n\n');
}

/**
 * The app-written message a side chat starts with: what the model reads (`content`) and what the
 * thread shows in its place (`display`).
 */
export function sideChatOpening(
  parent: Pick<ChatSession, 'title' | 'messages'>,
  selection: string
): { content: string; display: string; selection: string } {
  const selected = clip(selection.trim(), SIDE_CHAT_SELECTION_LIMIT);
  const excerpt = parentExcerpt(parent.messages);
  const content = [
    `This is a side chat branched from the conversation "${parent.title}". The user highlighted a ` +
      'passage there and wants to discuss it here, without adding to that conversation.',
    excerpt ? `Recent messages from that conversation, oldest first (may be truncated):\n\n${excerpt}` : '',
    `The highlighted passage:\n\n${quoteBlock(selected)}`,
    "Treat the passage as the subject of the user's next message.",
  ]
    .filter(Boolean)
    .join('\n\n');
  return { content, display: quoteBlock(selected), selection: selected };
}
