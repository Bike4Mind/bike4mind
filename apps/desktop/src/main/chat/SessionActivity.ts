import type { ChatSessionStatus, ChatSessionStatusEvent, SessionSetupStep } from '@shared/chat';

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

  /** Sessions cutting their worktree or sending their first turn, which have no reply yet, by step. */
  private readonly preparing = new Map<string, SessionSetupStep>();

  /** sessionId -> approvals outstanding. One turn can put several tools at the gate at once. */
  private readonly awaiting = new Map<string, number>();

  /** Sessions with a relayed message waiting on their user, who is the one holding it up. */
  private readonly held = new Set<string>();

  constructor(private readonly onChange: (event: ChatSessionStatusEvent) => void) {}

  statusOf(sessionId: string): ChatSessionStatus {
    if ((this.awaiting.get(sessionId) ?? 0) > 0 || this.held.has(sessionId)) return 'needs-action';
    return this.replying.has(sessionId) || this.preparing.has(sessionId) ? 'processing' : 'done';
  }

  /**
   * Every session not currently idle.
   *
   * 'done' is represented by absence throughout, so a renderer seeded with this holds one entry
   * per busy conversation rather than one per conversation that has ever existed.
   */
  snapshot(): ChatSessionStatusEvent[] {
    const ids = new Set([...this.replying, ...this.preparing.keys(), ...this.awaiting.keys(), ...this.held]);
    const events: ChatSessionStatusEvent[] = [];
    for (const sessionId of ids) {
      const status = this.statusOf(sessionId);
      if (status !== 'done') events.push(this.eventFor(sessionId, status));
    }
    return events;
  }

  replyStarted(sessionId: string): void {
    this.transition(sessionId, () => this.replying.add(sessionId));
  }

  replyEnded(sessionId: string): void {
    this.transition(sessionId, () => this.replying.delete(sessionId));
  }

  /**
   * Held across the worktree and the turn that follows it, and ended after `replyStarted`, so
   * the row goes straight from preparing to replying without a 'done' push in between.
   */
  preparingStarted(sessionId: string, step: SessionSetupStep): void {
    this.transition(sessionId, () => this.preparing.set(sessionId, step));
  }

  /** Move a session already preparing on to its next setup step; a no-op for one that is not. */
  preparingStep(sessionId: string, step: SessionSetupStep): void {
    if (!this.preparing.has(sessionId)) return;
    this.transition(sessionId, () => this.preparing.set(sessionId, step));
  }

  preparingEnded(sessionId: string): void {
    this.transition(sessionId, () => this.preparing.delete(sessionId));
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

  heldChanged(sessionId: string, waiting: boolean): void {
    this.transition(sessionId, () => (waiting ? this.held.add(sessionId) : this.held.delete(sessionId)));
  }

  /**
   * Drop a deleted conversation. Silent on purpose: the row whose status it would announce is
   * already gone from the sidebar by the time this runs.
   */
  forget(sessionId: string): void {
    this.replying.delete(sessionId);
    this.preparing.delete(sessionId);
    this.awaiting.delete(sessionId);
    this.held.delete(sessionId);
  }

  /** The setup step of a session still being prepared, with no reply streaming yet; else undefined. */
  private setupStep(sessionId: string, status: ChatSessionStatus): SessionSetupStep | undefined {
    if (status !== 'processing' || this.replying.has(sessionId)) return undefined;
    return this.preparing.get(sessionId);
  }

  private eventFor(sessionId: string, status: ChatSessionStatus): ChatSessionStatusEvent {
    const step = this.setupStep(sessionId, status);
    return step ? { sessionId, status, preparing: step } : { sessionId, status };
  }

  private transition(sessionId: string, mutate: () => void): void {
    const before = this.statusOf(sessionId);
    const stepBefore = this.setupStep(sessionId, before);
    mutate();
    const after = this.statusOf(sessionId);
    // Only a real change goes out: a turn running four tools would otherwise push four
    // identical 'needs-action' events, and every open window would re-render on each one.
    // The setup step counts as a change: preparing -> replying keeps 'processing'.
    if (after !== before || this.setupStep(sessionId, after) !== stepBefore) {
      this.onChange(this.eventFor(sessionId, after));
    }
  }
}
