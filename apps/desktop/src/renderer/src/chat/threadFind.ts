import type { ChatMessage, ChatToolCall } from '@shared/chat';
import { noticeChildId } from './childCardLayout';
import { presentReply } from './codeStream';
import { displayText } from './relayRows';
import { callsIn, roundsOf } from './replyRounds';
import { summarizeInput } from './toolRows';

/**
 * Find in the open conversation, as a model over the thread's DATA rather than its DOM.
 *
 * The thread draws only a window of recent rounds, folds everything above a /clear or /compact
 * into an unmounted disclosure, and mounts a tool row's input and output only while the row is
 * open. A search over what is on screen would miss most of a long session and could not count
 * it, so matches are collected from the messages, and the parts of the thread that hold the
 * current one are opened to it (see ThreadFindContext). The DOM is then searched only to paint:
 * every element a segment renders into carries `data-find-scope` with that segment's id.
 */

/** Which part of a tool call a segment is. */
export type ToolPart = 'input' | 'output';

/** One searchable run of text, and where in the thread it is drawn. */
export interface FindSegment {
  /** Matches `data-find-scope` on the element the text renders into. */
  scope: string;
  messageId: string;
  /** In the WHOLE thread, so the windowed list and the folded section can tell if it is theirs. */
  messageIndex: number;
  /** Set for text that is drawn inside a tool row. */
  callId?: string;
  part?: ToolPart;
  text: string;
}

/** One occurrence of the query: its segment, and which occurrence within that segment it is. */
export interface FindMatch extends Omit<FindSegment, 'text'> {
  occurrence: number;
}

/** Past this, counting stops: the bar says "N+" rather than walking a whole history per keystroke. */
export const MAX_FIND_MATCHES = 5000;

export function messageScope(messageId: string): string {
  return `message:${messageId}`;
}

export function roundScope(messageId: string, round: number): string {
  return `round:${messageId}:${round}`;
}

export function toolScope(callId: string, part: ToolPart): string {
  return `tool:${callId}:${part}`;
}

/** What a tool row's detail shows for its input and output; must stay in step with ToolCallDetail. */
export function toolSegmentTexts(call: ChatToolCall): Record<ToolPart, string> {
  const diffs = call.diffs ?? (call.diff ? [call.diff] : []);
  return {
    input: diffs.length > 0 ? '' : summarizeInput(call),
    output: call.error ?? call.preview ?? call.progress ?? '',
  };
}

/**
 * The text a message renders, segment by segment, in the order it is drawn; must stay in step
 * with MessageThread's turn(). A skill turn's body is left out: what it shows is the invocation,
 * and the body is someone else's instructions folded behind a toggle.
 */
function messageSegments(message: ChatMessage, messageIndex: number): FindSegment[] {
  const base = { messageId: message.id, messageIndex };
  const whole = (text: string): FindSegment[] => (text ? [{ ...base, scope: messageScope(message.id), text }] : []);

  if (message.boundary) return message.boundary.kind === 'compact' ? whole(message.content) : [];
  if (message.automatic) return whole(message.content);
  // A child's notices fold into its card (ChildSessionCards), which draws no find scope for them.
  if (noticeChildId(message)) return [];
  if (message.relay || message.system) return whole(displayText(message));
  if (message.role === 'user') return message.skill ? [] : whole(message.content);

  const toolCalls = message.toolCalls ?? [];
  const segments: FindSegment[] = [];
  roundsOf(message).forEach((round, index) => {
    const text = presentReply(round.text, false).text;
    if (text) segments.push({ ...base, scope: roundScope(message.id, index), text });
    for (const call of callsIn(round, toolCalls)) {
      const texts = toolSegmentTexts(call);
      for (const part of ['input', 'output'] as const) {
        if (texts[part]) {
          segments.push({ ...base, scope: toolScope(call.id, part), callId: call.id, part, text: texts[part] });
        }
      }
    }
  });
  return segments;
}

export function threadSegments(messages: readonly ChatMessage[]): FindSegment[] {
  return messages.flatMap((message, index) => messageSegments(message, index));
}

/**
 * The query as a global pattern, or null when there is nothing to look for. Case-insensitive
 * through the `i` flag rather than by lowercasing both sides, so an offset in the text is an
 * offset in what was drawn: lowercasing can change a string's length.
 */
export function findPattern(query: string, caseSensitive: boolean): RegExp | null {
  if (!query) return null;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(escaped, caseSensitive ? 'gu' : 'giu');
}

export function countOccurrences(text: string, pattern: RegExp): number {
  pattern.lastIndex = 0;
  let count = 0;
  while (pattern.exec(text) !== null) count++;
  return count;
}

export function collectMatches(
  segments: readonly FindSegment[],
  query: string,
  caseSensitive: boolean,
  limit = MAX_FIND_MATCHES
): FindMatch[] {
  const pattern = findPattern(query, caseSensitive);
  if (!pattern) return [];
  const matches: FindMatch[] = [];
  for (const { text, ...segment } of segments) {
    const count = countOccurrences(text, pattern);
    for (let occurrence = 0; occurrence < count; occurrence++) {
      if (matches.length >= limit) return matches;
      matches.push({ ...segment, occurrence });
    }
  }
  return matches;
}

/** The next (or previous) match index, wrapping at both ends. */
export function stepMatch(current: number, total: number, direction: 1 | -1): number {
  if (total === 0) return -1;
  if (current < 0) return direction === 1 ? 0 : total - 1;
  return (current + direction + total) % total;
}

/** "3 of 12", "No results", or "3 of 5000+" once the count stopped at the cap. */
export function describeCount(current: number, total: number, limit = MAX_FIND_MATCHES): string {
  if (total === 0) return 'No results';
  return `${current + 1} of ${total}${total >= limit ? '+' : ''}`;
}
