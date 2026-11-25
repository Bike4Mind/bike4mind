import type { BackgroundProcessStatus, SessionBackgroundJobs } from '@shared/chat';

/**
 * Feeds a session's running wake-on-exit jobs into SessionActivity, holding the last one's Waiting
 * for a moment after it ends on its own.
 *
 * The registry reports the exit before BackgroundWake has coalesced it into a turn (see
 * backgroundWake.ts, COALESCE_MS), so clearing at once would show the agent as Done for that gap
 * and then Working again. Held instead: a wake turn that starts within `holdMs` takes over as
 * 'processing', and one that never comes (the model already read the exit, or the wake streak is
 * capped) lets the agent settle as Done once the hold runs out. It never stays Waiting for good.
 * A kill clears at once: nobody is woken for it.
 */
export class BackgroundJobsFeed {
  private readonly holds = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly apply: (sessionId: string, jobs: SessionBackgroundJobs | undefined) => void,
    private readonly holdMs: number
  ) {}

  /** `ended` is the status of the process whose event triggered this update. */
  update(sessionId: string, jobs: SessionBackgroundJobs | undefined, ended: BackgroundProcessStatus): void {
    this.cancel(sessionId);
    if (jobs || ended === 'running' || ended === 'killed') {
      this.apply(sessionId, jobs);
      return;
    }
    const hold = setTimeout(() => {
      this.holds.delete(sessionId);
      this.apply(sessionId, undefined);
    }, this.holdMs);
    hold.unref?.();
    this.holds.set(sessionId, hold);
  }

  dispose(): void {
    for (const hold of this.holds.values()) clearTimeout(hold);
    this.holds.clear();
  }

  private cancel(sessionId: string): void {
    const hold = this.holds.get(sessionId);
    if (hold) clearTimeout(hold);
    this.holds.delete(sessionId);
  }
}
