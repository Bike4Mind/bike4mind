import type { ChatSessionStatus, ChatSessionStatusEvent, SessionBackgroundJobs, SessionSetupStep } from '@shared/chat';

/** How a turn ended. Only 'completed' lets a queued message go out; see settleQueue in ChatService. */
export type TurnOutcome = 'completed' | 'aborted' | 'failed' | 'expired';

/**
 * Whether a turn that just ended leaves an unread reply: a finished answer with text, or a turn that
 * failed. Either stays on the Agents board and the dock badge until opened; a stop the user asked for,
 * or an empty answer, does not.
 */
export function endsUnread(outcome: TurnOutcome, replyText: string): boolean {
  return outcome === 'failed' || (outcome === 'completed' && replyText.trim().length > 0);
}

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
 * Live activity and unread replies are in memory. Pending task decisions are restored from the
 * session store after a restart; unread reply attention lasts for the current app run.
 */
export class SessionActivity {
  private readonly replying = new Set<string>();

  /** Sessions cutting their worktree or sending their first turn, which have no reply yet, by step. */
  private readonly preparing = new Map<string, SessionSetupStep>();

  /** sessionId -> approvals outstanding. One turn can put several tools at the gate at once. */
  private readonly awaiting = new Map<string, number>();

  /** Sessions with a relayed message waiting on their user, who is the one holding it up. */
  private readonly held = new Set<string>();

  /**
   * Workers whose task waits on a decision only the user can make. The one state here that
   * outlives a restart: ChatService re-marks it from the stored task (see listTaskDecisions).
   */
  private readonly deciding = new Set<string>();

  private readonly unread = new Set<string>();

  /** Turns each session has finished this run; see ChatSessionStatusEvent.settledTurns. */
  private readonly settled = new Map<string, number>();

  /**
   * Wake-on-exit background commands still running, per session. Orthogonal to the status: a
   * session whose turn ended is 'done' and may still be waiting on these (see BackgroundProcessRegistry).
   */
  private readonly background = new Map<string, SessionBackgroundJobs>();

  /**
   * `statusChanged` is false for an event that only moved the setup step or the background jobs,
   * so a listener that acts on a turn settling (PrMonitor) does not run twice for one turn.
   */
  constructor(private readonly onChange: (event: ChatSessionStatusEvent, statusChanged: boolean) => void) {}

  statusOf(sessionId: string): ChatSessionStatus {
    const runtime = this.runtimeStatusOf(sessionId);
    return runtime === 'done' && this.unread.has(sessionId) ? 'needs-action' : runtime;
  }

  runtimeStatusOf(sessionId: string): ChatSessionStatus {
    if ((this.awaiting.get(sessionId) ?? 0) > 0 || this.held.has(sessionId) || this.deciding.has(sessionId))
      return 'needs-action';
    return this.replying.has(sessionId) || this.preparing.has(sessionId) ? 'processing' : 'done';
  }

  /** What a 'needs-action' session is waiting on, for the notice its parent gets; undefined when it waits on nothing. */
  waitingReason(sessionId: string): 'approval' | 'decision' | 'message' | undefined {
    if ((this.awaiting.get(sessionId) ?? 0) > 0) return 'approval';
    if (this.deciding.has(sessionId)) return 'decision';
    if (this.held.has(sessionId)) return 'message';
    return undefined;
  }

  /**
   * Every session not currently idle, plus every idle one still waiting on background jobs.
   *
   * 'done' is represented by absence throughout, so a renderer seeded with this holds one entry
   * per busy conversation rather than one per conversation that has ever existed.
   */
  snapshot(): ChatSessionStatusEvent[] {
    const ids = new Set([
      ...this.replying,
      ...this.preparing.keys(),
      ...this.awaiting.keys(),
      ...this.held,
      ...this.deciding,
      ...this.unread,
      ...this.background.keys(),
    ]);
    const events: ChatSessionStatusEvent[] = [];
    for (const sessionId of ids) {
      const status = this.statusOf(sessionId);
      if (status !== 'done' || this.background.has(sessionId)) events.push(this.eventFor(sessionId, status));
    }
    return events;
  }

  replyStarted(sessionId: string): void {
    this.transition(sessionId, () => {
      this.unread.delete(sessionId);
      this.replying.add(sessionId);
    });
  }

  replyEnded(sessionId: string, unread = false): void {
    this.transition(sessionId, () => {
      this.replying.delete(sessionId);
      this.settled.set(sessionId, (this.settled.get(sessionId) ?? 0) + 1);
      if (unread) this.unread.add(sessionId);
    });
  }

  viewed(sessionId: string): void {
    this.transition(sessionId, () => this.unread.delete(sessionId));
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

  decisionChanged(sessionId: string, pending: boolean): void {
    this.transition(sessionId, () => (pending ? this.deciding.add(sessionId) : this.deciding.delete(sessionId)));
  }

  /** The session's running wake-on-exit background jobs, or undefined when none are left. */
  backgroundChanged(sessionId: string, jobs: SessionBackgroundJobs | undefined): void {
    this.transition(sessionId, () =>
      jobs && jobs.running > 0 ? this.background.set(sessionId, { ...jobs }) : this.background.delete(sessionId)
    );
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
    this.deciding.delete(sessionId);
    this.unread.delete(sessionId);
    this.background.delete(sessionId);
    this.settled.delete(sessionId);
  }

  /** The setup step of a session still being prepared, with no reply streaming yet; else undefined. */
  private setupStep(sessionId: string, status: ChatSessionStatus): SessionSetupStep | undefined {
    if (status !== 'processing' || this.replying.has(sessionId)) return undefined;
    return this.preparing.get(sessionId);
  }

  private eventFor(sessionId: string, status: ChatSessionStatus): ChatSessionStatusEvent {
    const step = this.setupStep(sessionId, status);
    const unreadReply = status === 'needs-action' && this.runtimeStatusOf(sessionId) === 'done';
    const jobs = this.background.get(sessionId);
    const settledTurns = this.settled.get(sessionId);
    return {
      sessionId,
      status,
      ...(unreadReply ? { unreadReply: true } : {}),
      ...(step ? { preparing: step } : {}),
      ...(jobs ? { background: { ...jobs } } : {}),
      ...(settledTurns ? { settledTurns } : {}),
    };
  }

  private backgroundKey(sessionId: string): string {
    const jobs = this.background.get(sessionId);
    return jobs ? `${jobs.running}:${jobs.label}` : '';
  }

  private transition(sessionId: string, mutate: () => void): void {
    const before = this.statusOf(sessionId);
    const unreadBefore = this.eventFor(sessionId, before).unreadReply;
    const stepBefore = this.setupStep(sessionId, before);
    const backgroundBefore = this.backgroundKey(sessionId);
    const settledBefore = this.settled.get(sessionId);
    mutate();
    const after = this.statusOf(sessionId);
    // Only a real change goes out: a turn running four tools would otherwise push four
    // identical 'needs-action' events, and every open window would re-render on each one.
    // The unread flag, the setup step, the background jobs and a settled turn count as changes too.
    const statusChanged = after !== before;
    if (
      statusChanged ||
      this.eventFor(sessionId, after).unreadReply !== unreadBefore ||
      this.setupStep(sessionId, after) !== stepBefore ||
      this.backgroundKey(sessionId) !== backgroundBefore ||
      this.settled.get(sessionId) !== settledBefore
    ) {
      this.onChange(this.eventFor(sessionId, after), statusChanged);
    }
  }
}
