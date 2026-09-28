import { randomUUID } from 'node:crypto';
import type {
  ChatAttachment,
  ChatMessage,
  ChatQueueEvent,
  ChatQueueReturnReason,
  ChatQueuedMessage,
} from '@shared/chat';

/**
 * Messages typed during a live turn, waiting to be sent when it ends.
 *
 * FIFO per session, and every message that leaves without being sent is handed BACK rather
 * than dropped: cancelling, a stopped reply, a failed reply and a refused turn all take the
 * same exit, so there is exactly one way a queued message can disappear from the UI and it
 * always ends with the text in the composer again.
 *
 * Nothing is persisted, matching SessionActivity: a queue entry is only meaningful while the
 * reply it is waiting behind is open, and replies are anchored to in-memory AbortControllers.
 */
export class MessageQueue {
  private readonly queues = new Map<string, ChatQueuedMessage[]>();

  constructor(private readonly onChange: (event: ChatQueueEvent) => void) {}

  /** What is waiting for one session, oldest first. */
  list(sessionId: string): ChatQueuedMessage[] {
    return [...(this.queues.get(sessionId) ?? [])];
  }

  /** Every session holding a queue, for a renderer that has just mounted. */
  snapshot(): ChatQueueEvent[] {
    return [...this.queues.entries()]
      .filter(([, messages]) => messages.length > 0)
      .map(([sessionId, messages]) => ({ sessionId, queued: [...messages] }));
  }

  /**
   * Attachment ids the queue is still holding onto, so pruning does not delete the bytes of a
   * message that has not been sent yet. Pruning keeps only what the PERSISTED messages
   * reference, and a queued message is by definition in neither place.
   */
  attachmentIds(sessionId: string): string[] {
    return this.list(sessionId).flatMap(message => (message.attachments ?? []).map(attachment => attachment.id));
  }

  enqueue(sessionId: string, text: string, attachments: readonly ChatAttachment[] = []): ChatQueuedMessage {
    const message: ChatQueuedMessage = {
      id: randomUUID(),
      sessionId,
      text,
      queuedAt: new Date().toISOString(),
      ...(attachments.length > 0 ? { attachments: [...attachments] } : {}),
    };
    this.queues.set(sessionId, [...this.list(sessionId), message]);
    this.announce(sessionId);
    return message;
  }

  /** Take the head, to send it. Nothing is announced: the caller may still have to hand it back. */
  takeNext(sessionId: string): ChatQueuedMessage | undefined {
    const messages = this.queues.get(sessionId);
    if (!messages || messages.length === 0) return undefined;
    const [next, ...rest] = messages;
    if (rest.length > 0) this.queues.set(sessionId, rest);
    else this.queues.delete(sessionId);
    return next;
  }

  /** Remove everything without announcing, for a caller that is about to hand it back. */
  drain(sessionId: string): ChatQueuedMessage[] {
    const messages = this.list(sessionId);
    this.queues.delete(sessionId);
    return messages;
  }

  /**
   * Confirm a taken message really became a turn, naming the thread message it became so the
   * renderer can show the prompt the reply is about to answer.
   */
  sent(sessionId: string, queuedId: string, message: ChatMessage): void {
    this.onChange({ sessionId, queued: this.list(sessionId), sent: { queuedId, message } });
  }

  /** One message the user took back. Unknown ids are ignored, so a double click cannot cancel the next one. */
  cancel(sessionId: string, queuedId: string): ChatQueuedMessage | undefined {
    const messages = this.list(sessionId);
    const message = messages.find(entry => entry.id === queuedId);
    if (!message) return undefined;
    this.replace(
      sessionId,
      messages.filter(entry => entry.id !== queuedId)
    );
    this.announce(sessionId, { messages: [message], reason: 'cancelled' });
    return message;
  }

  /** Empty the queue and hand all of it back - the stopped and failed paths. */
  releaseAll(sessionId: string, reason: ChatQueueReturnReason, detail?: string): ChatQueuedMessage[] {
    const messages = this.drain(sessionId);
    if (messages.length === 0) return [];
    this.announce(sessionId, { messages, reason, ...(detail ? { detail } : {}) });
    return messages;
  }

  /**
   * Hand back messages already taken out, ahead of whatever is still queued. Used when a
   * released message's turn is refused: the head is no longer in the queue, but it is exactly
   * the text the user must not lose.
   */
  giveBack(
    sessionId: string,
    taken: readonly ChatQueuedMessage[],
    reason: ChatQueueReturnReason,
    detail?: string
  ): void {
    const messages = [...taken, ...this.drain(sessionId)];
    if (messages.length === 0) return;
    this.announce(sessionId, { messages, reason, ...(detail ? { detail } : {}) });
  }

  /**
   * Drop a deleted conversation. Silent on purpose, like SessionActivity.forget: the composer
   * that would take the text back is gone with the conversation.
   */
  forget(sessionId: string): void {
    this.queues.delete(sessionId);
  }

  private replace(sessionId: string, messages: ChatQueuedMessage[]): void {
    if (messages.length > 0) this.queues.set(sessionId, messages);
    else this.queues.delete(sessionId);
  }

  private announce(sessionId: string, returned?: ChatQueueEvent['returned']): void {
    this.onChange({ sessionId, queued: this.list(sessionId), ...(returned ? { returned } : {}) });
  }
}
