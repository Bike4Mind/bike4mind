import type { ChatMessage, ChatStreamEvent } from '@shared/chat';

type ReplyDoneEvent = Extract<ChatStreamEvent, { type: 'done' }>;

/**
 * The streaming message with the settled reply reconciled onto it.
 *
 * Main strips the artifact markup out of a reply before it announces it, so the deltas that
 * carried that markup are exactly what has to be dropped here: `content` REPLACES the streamed
 * text rather than extending it, and `rounds` for the same reason - that is what the thread
 * actually draws. Taking `content` alone put the stripped text in the field nothing reads and
 * left the raw markup in the field everything reads, so a reply that emitted an artifact went
 * on showing its <artifact> tag until the conversation was reloaded.
 *
 * `rounds` is ASSIGNED rather than defaulted to what streamed. The event omits it when no tool
 * ever ran, and dropping the streamed rounds is what makes roundsOf rebuild the single round
 * from `content` - which is the stripped text. Defaulting to the message's own rounds would
 * put the raw markup straight back, for exactly the turns this is here to fix.
 *
 * Pure, and separate from the hook that calls it, because this is the seam the bug lived in:
 * replyRounds covers what roundsOf does with rounds it is handed and the ChatService tests
 * cover what main emits, and nothing covered the handover between them.
 */
export function applyReplyDone(message: ChatMessage, event: ReplyDoneEvent): ChatMessage {
  return {
    ...message,
    content: event.content,
    rounds: event.rounds,
    stopReason: event.stopReason,
    toolCalls: event.toolCalls ?? message.toolCalls,
    artifacts: event.artifacts ?? message.artifacts,
  };
}
