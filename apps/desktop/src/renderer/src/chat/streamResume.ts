import type { ChatStreamEvent, EventCursor } from '@shared/chat';

export type StreamAdmission = 'apply' | 'hold' | 'reflected';

/** What a snapshot read leaves to do with the events held during it. */
export interface StreamResolution {
  /** Events above the snapshot's cursor: apply them in full. */
  unseen: ChatStreamEvent[];
  /**
   * Events at or below the cursor: the snapshot holds their transcript and turn, but not their
   * side effects (notices, settled-turn counts), which still have to run.
   */
  reflected: ChatStreamEvent[];
}

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
    if (this.reflects(event)) return 'reflected';
    if (event.sessionId !== this.sessionId || event.seq === undefined) return 'apply';
    if (!this.held) return 'apply';
    this.held.push(event);
    return 'hold';
  }

  /**
   * The read landed and its snapshot is applied: returns the held events it does not reflect, in
   * order, split from the ones it reflects, and from now on reports any event at or below its
   * cursor as reflected.
   */
  resolve(cursor: EventCursor | undefined): StreamResolution {
    const held = this.held ?? [];
    this.held = null;
    this.cursorSeq = cursor?.seq ?? null;
    const after = this.cursorSeq;
    if (after === null) return { unseen: held, reflected: [] };
    const isUnseen = (event: ChatStreamEvent): boolean => event.seq === undefined || event.seq > after;
    return { unseen: held.filter(isUnseen), reflected: held.filter(event => !isUnseen(event)) };
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
