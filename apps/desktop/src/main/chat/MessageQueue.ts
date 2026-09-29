import { randomUUID } from 'node:crypto';
import type {
  ChatAttachment,
  ChatMessage,
  ChatQueueEvent,
  ChatQueueReturnReason,
  ChatQueuedMessage,
  ChatRelayOrigin,
} from '@shared/chat';

/**
 * What the user has typed during a live turn, waiting to be sent when it ends.
 *
 * At most ONE pending TYPED message per session: a second send while something is already
 * waiting appends to it rather than lining up behind it, so the whole wait produces a single
 * next turn carrying everything the user said.
 *
 * A message relayed from another conversation (session_send) is the exception, and the reason
 * the list is a list. It never merges: merging would put another agent's words inside a message
 * the user is composing, and the two then go out as one turn with no way to tell which half
 * came from where. Each relay is its own entry and becomes its own turn, in arrival order.
 *
 * Every TYPED message that leaves without being sent is handed BACK rather than dropped:
 * cancelling, a stopped reply, a failed reply and a refused turn all take the same exit, so
 * there is exactly one way a queued message can disappear from the UI and it always ends with
 * the text in the composer again. A relay leaving the queue is handed back to the CALLER
 * instead - see releaseAll - because another conversation's words have no business appearing
 * in this user's composer as though they had written them.
 *
 * Nothing is persisted, matching SessionActivity: a queue entry is only meaningful while the
 * reply it is waiting behind is open, and replies are anchored to in-memory AbortControllers.
 */
/** Union of the two attachment sets by id, so re-sending the same file does not double it. */
function mergedAttachments(
  pending: readonly ChatAttachment[] | undefined,
  incoming: readonly ChatAttachment[]
): { attachments?: ChatAttachment[] } {
  const byId = new Map((pending ?? []).map(attachment => [attachment.id, attachment]));
  for (const attachment of incoming) byId.set(attachment.id, attachment);
  return byId.size > 0 ? { attachments: [...byId.values()] } : {};
}

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

  /**
   * Add to what is pending, or start it.
   *
   * A second send joins the message already waiting, on a new line. Keeping its id and
   * `queuedAt` matters: the row above the composer stays the same row rather than being
   * replaced, and one cancel still takes back everything typed during this turn.
   */
  enqueue(sessionId: string, text: string, attachments: readonly ChatAttachment[] = []): ChatQueuedMessage {
    const messages = this.list(sessionId);
    // The tail, and only if it is the user's own: a relay is never merged into, so typing
    // behind one starts a fresh entry rather than appending to another agent's words.
    const last = messages[messages.length - 1];
    const pending = last && !last.relay ? last : undefined;
    const merged: ChatQueuedMessage = pending
      ? {
          ...pending,
          text: [pending.text, text].filter(Boolean).join('\n'),
          ...mergedAttachments(pending.attachments, attachments),
        }
      : {
          id: randomUUID(),
          sessionId,
          text,
          queuedAt: new Date().toISOString(),
          ...(attachments.length > 0 ? { attachments: [...attachments] } : {}),
        };

    this.replace(sessionId, pending ? [...messages.slice(0, -1), merged] : [...messages, merged]);
    this.announce(sessionId);
    return merged;
  }

  /**
   * Line up a message another conversation sent, behind whatever is already waiting.
   *
   * Always its own entry, and always appended: arrival order is what the target's transcript
   * will show, and two senders' messages must not be run together as one turn.
   */
  enqueueRelay(sessionId: string, text: string, relay: ChatRelayOrigin): ChatQueuedMessage {
    const message: ChatQueuedMessage = {
      id: randomUUID(),
      sessionId,
      text,
      queuedAt: new Date().toISOString(),
      relay,
    };
    this.replace(sessionId, [...this.list(sessionId), message]);
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

  /**
   * One message the user took back. Unknown ids are ignored, so a double click cannot cancel
   * the next one. Returns it whether it was theirs or a relay; the caller decides where a
   * cancelled relay goes, since the composer is not an answer for one.
   */
  cancel(sessionId: string, queuedId: string): ChatQueuedMessage | undefined {
    const messages = this.list(sessionId);
    const message = messages.find(entry => entry.id === queuedId);
    if (!message) return undefined;
    this.replace(
      sessionId,
      messages.filter(entry => entry.id !== queuedId)
    );
    this.returned(sessionId, [message], 'cancelled');
    return message;
  }

  /**
   * Empty the queue - the stopped and failed paths. Typed messages go back to the composer;
   * the RELAYS are returned here for the caller to strand in the transcript instead.
   */
  releaseAll(sessionId: string, reason: ChatQueueReturnReason, detail?: string): ChatQueuedMessage[] {
    const messages = this.drain(sessionId);
    if (messages.length === 0) return [];
    this.returned(sessionId, messages, reason, detail);
    return messages.filter(message => message.relay);
  }

  /**
   * Hand back messages already taken out, ahead of whatever is still queued. Used when a
   * released message's turn is refused: the head is no longer in the queue, but it is exactly
   * the text the user must not lose. Relays come back to the caller, as in releaseAll.
   */
  giveBack(
    sessionId: string,
    taken: readonly ChatQueuedMessage[],
    reason: ChatQueueReturnReason,
    detail?: string
  ): ChatQueuedMessage[] {
    const messages = [...taken, ...this.drain(sessionId)];
    if (messages.length === 0) return [];
    this.returned(sessionId, messages, reason, detail);
    return messages.filter(message => message.relay);
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

  /**
   * Announce messages leaving the queue unsent, with the relays filtered out of what the
   * composer is asked to take back. The event still fires when everything leaving was a relay:
   * `queued` is authoritative, so a renderer that heard nothing would keep drawing rows for
   * messages that are no longer there.
   */
  private returned(
    sessionId: string,
    messages: readonly ChatQueuedMessage[],
    reason: ChatQueueReturnReason,
    detail?: string
  ): void {
    const typed = messages.filter(message => !message.relay);
    if (typed.length === 0) {
      this.announce(sessionId);
      return;
    }
    this.announce(sessionId, { messages: typed, reason, ...(detail ? { detail } : {}) });
  }
}
