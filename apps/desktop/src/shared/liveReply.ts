import type { ChatMessage, ChatReplyRound, ChatStreamEvent } from './chat';

/**
 * A reply in flight, rebuilt from its stream events.
 *
 * Shared by the renderer's thread and main's live copy (ChatService.getSession), so a window
 * that opens a conversation mid-turn is handed exactly what one that watched from the start
 * would be showing, and the two cannot drift apart.
 */

/** Open the reply a 'start' names: a fresh message, or a resumed one keeping its text and rows. */
export function startReply(messages: readonly ChatMessage[], messageId: string): ChatMessage[] {
  return messages.some(message => message.id === messageId)
    ? messages.map(message => (message.id === messageId ? { ...message, stopReason: undefined } : message))
    : [...messages, { id: messageId, role: 'assistant', content: '', createdAt: new Date().toISOString() }];
}

/** Fold one non-terminal event into its reply. Anything else leaves the message as it was. */
export function applyLiveEvent(message: ChatMessage, event: ChatStreamEvent): ChatMessage {
  if (!('messageId' in event) || event.messageId !== message.id) return message;

  if (event.type === 'delta') {
    return { ...message, content: message.content + event.text, rounds: appendText(message.rounds, event.text) };
  }

  if (event.type === 'tool-start' || event.type === 'tool-end') {
    const existing = message.toolCalls ?? [];
    const known = existing.some(call => call.id === event.call.id);
    return {
      ...message,
      toolCalls: known
        ? // Wholesale, with nothing carried over from the state it replaces. The approval
          // prompt's diff is a proposal and must not outlive the answer; the record of what
          // landed arrives on the settled call itself as `diff`.
          existing.map(call => (call.id === event.call.id ? event.call : call))
        : [...existing, event.call],
      rounds: known ? message.rounds : attachCall(message.rounds, event.call.id),
    };
  }

  if (event.type === 'tool-progress') {
    return {
      ...message,
      toolCalls: (message.toolCalls ?? []).map(call =>
        call.id === event.callId ? { ...call, progress: event.text } : call
      ),
    };
  }

  return message;
}

/**
 * Rebuild the reply's round structure from the stream, which does not carry it.
 *
 * It does not need to: a round is prose and then the tools that prose announced, so the FIRST
 * text after a round has run something opens the next round. That is the whole rule, and it
 * reproduces exactly what main stores - the point being that the thread reads in order while it
 * is streaming, instead of every row sitting at the bottom until 'done' rearranges them.
 */
function appendText(rounds: ChatReplyRound[] | undefined, text: string): ChatReplyRound[] {
  const open = rounds?.[rounds.length - 1];
  if (!rounds || !open || open.toolCallIds.length > 0) {
    // The blank line main puts between rounds belongs to the flattened `content`, not to the
    // round that follows it, which would otherwise open on an empty line of its own.
    return [...(rounds ?? []), { text: text.replace(/^\n+/, ''), toolCallIds: [] }];
  }
  return [...rounds.slice(0, -1), { ...open, text: open.text + text }];
}

/** Put a call in the round that is open, starting one for a round that announced itself in silence. */
function attachCall(rounds: ChatReplyRound[] | undefined, callId: string): ChatReplyRound[] {
  const open = rounds?.[rounds.length - 1];
  if (!rounds || !open) return [{ text: '', toolCallIds: [callId] }];
  return [...rounds.slice(0, -1), { ...open, toolCallIds: [...open.toolCallIds, callId] }];
}
