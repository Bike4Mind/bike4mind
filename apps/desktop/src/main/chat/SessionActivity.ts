import type { ChatSessionStatus, ChatSessionStatusEvent } from '@shared/chat';

/**
 * The authoritative answer to "what is each session doing", for every session at once.
 *
 * It lives in main because main is the only process that knows. Replies stream here and the
 * approval gate waits here, and both keep running for conversations no window has open. A
 * renderer deriving this from the stream events it happened to witness gets the important case
 * exactly backwards: a window that opened - or merely reloaded - while a background session was
 * already parked at the approval gate has seen no events for it at all, and would draw the one
 * session that needs the user as the one session that is idle.
 *
 * Nothing here is persisted, and that is correct rather than a shortcut: every state it tracks
 * is anchored to an in-memory AbortController or an unresolved promise, so after a restart no
 * session is processing and none is waiting for an answer.
 */
export class SessionActivity {
  private readonly replying = new Set<string>();

  /** sessionId -> approvals outstanding. One turn can put several tools at the gate at once. */
  private readonly awaiting = new Map<string, number>();

  constructor(private readonly onChange: (event: ChatSessionStatusEvent) => void) {}

  statusOf(sessionId: string): ChatSessionStatus {
    if ((this.awaiting.get(sessionId) ?? 0) > 0) return 'needs-action';
    return this.replying.has(sessionId) ? 'processing' : 'done';
  }

  /**
   * Every session not currently idle.
   *
   * 'done' is represented by absence throughout, so a renderer seeded with this holds one entry
   * per busy conversation rather than one per conversation that has ever existed.
   */
  snapshot(): ChatSessionStatusEvent[] {
    const ids = new Set([...this.replying, ...this.awaiting.keys()]);
    const events: ChatSessionStatusEvent[] = [];
    for (const sessionId of ids) {
      const status = this.statusOf(sessionId);
      if (status !== 'done') events.push({ sessionId, status });
    }
    return events;
  }

  replyStarted(sessionId: string): void {
    this.transition(sessionId, () => this.replying.add(sessionId));
  }

  replyEnded(sessionId: string): void {
    this.transition(sessionId, () => this.replying.delete(sessionId));
  }

  approvalRequested(sessionId: string): void {
    this.transition(sessionId, () => this.awaiting.set(sessionId, (this.awaiting.get(sessionId) ?? 0) + 1));
  }

  approvalSettled(sessionId: string): void {
    this.transition(sessionId, () => {
      const left = (this.awaiting.get(sessionId) ?? 0) - 1;
      if (left > 0) this.awaiting.set(sessionId, left);
      else this.awaiting.delete(sessionId);
    });
  }

  /**
   * Drop a deleted conversation. Silent on purpose: the row whose status it would announce is
   * already gone from the sidebar by the time this runs.
   */
  forget(sessionId: string): void {
    this.replying.delete(sessionId);
    this.awaiting.delete(sessionId);
  }

  private transition(sessionId: string, mutate: () => void): void {
    const before = this.statusOf(sessionId);
    mutate();
    const after = this.statusOf(sessionId);
    // Only a real change goes out: a turn running four tools would otherwise push four
    // identical 'needs-action' events, and every open window would re-render on each one.
    if (after !== before) this.onChange({ sessionId, status: after });
  }
}
