import type { ChatStreamEvent, EventCursor } from '@shared/chat';

export type StreamAdmission = 'apply' | 'hold' | 'drop';

/**
 * Joins the open chat's snapshot read to the live stream, so an event that lands while the read
 * is in flight is applied exactly once: after the snapshot when the snapshot does not reflect it,
 * never when it does. Events carry a per-session `seq` and the read returns the cursor it reflects
 * (ChatService.getSession), so the cut is exact rather than inferred.
 *
 * Only sequenced events are held. One without `seq` is applied at once, as before sequencing.
 */
export class StreamResumeGate {
  private sessionId: string | null = null;
  private held: ChatStreamEvent[] | null = null;
  private cursorSeq: number | null = null;

  /** A read of `sessionId` is starting. A re-read of the same chat keeps what is already held. */
  hold(sessionId: string): void {
    if (this.sessionId === sessionId && this.held) return;
    this.sessionId = sessionId;
    this.held = [];
    this.cursorSeq = null;
  }

  /** True for an event the applied snapshot already contains. */
  reflects(event: ChatStreamEvent): boolean {
    return (
      event.sessionId === this.sessionId &&
      event.seq !== undefined &&
      this.cursorSeq !== null &&
      event.seq <= this.cursorSeq
    );
  }

  admit(event: ChatStreamEvent): StreamAdmission {
    if (this.reflects(event)) return 'drop';
    if (event.sessionId !== this.sessionId || event.seq === undefined) return 'apply';
    if (!this.held) return 'apply';
    this.held.push(event);
    return 'hold';
  }

  /**
   * The read landed and its snapshot is applied: returns the held events it does not reflect, in
   * order, and from now on drops any event at or below its cursor.
   */
  resolve(cursor: EventCursor | undefined): ChatStreamEvent[] {
    const held = this.held ?? [];
    this.held = null;
    this.cursorSeq = cursor?.seq ?? null;
    const after = this.cursorSeq;
    return after === null ? held : held.filter(event => event.seq === undefined || event.seq > after);
  }

  /**
   * No snapshot is coming (the read failed, or the chat was left): returns everything held, to be
   * applied as it would have been without the gate.
   */
  release(): ChatStreamEvent[] {
    const held = this.held ?? [];
    this.held = null;
    this.cursorSeq = null;
    return held;
  }
}
