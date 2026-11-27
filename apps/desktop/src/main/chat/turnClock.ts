/**
 * The part of a turn's wall clock that does NOT count toward its time budget (TurnLimits.wallClockMs):
 * time spent waiting on the user (an approval or ask_user card) or on a background process the model
 * chose to block on (bash_output wait_seconds). Neither is the agent working, and counting them let a
 * slow reviewer or a busy machine end a productive turn.
 *
 * Waits can overlap (parallel tool calls each showing a card), so pauses nest: the clock is stopped
 * from the first pause to the last resume and the overlap is counted once.
 */
export class TurnClock {
  private depth = 0;
  private pausedAt = 0;
  private idle = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /** Stop counting until the returned function is called. Calling it twice resumes once. */
  readonly pause = (): (() => void) => {
    if (this.depth === 0) this.pausedAt = this.now();
    this.depth += 1;
    let resumed = false;
    return () => {
      if (resumed) return;
      resumed = true;
      this.depth -= 1;
      if (this.depth === 0) this.idle += this.now() - this.pausedAt;
    };
  };

  /** Excluded time so far, including a pause still open. */
  idleMs(): number {
    return this.idle + (this.depth > 0 ? this.now() - this.pausedAt : 0);
  }
}

/**
 * Whether a turn that reached its round or time budget is carried on automatically.
 *
 * `stalled` is the loop's count of identical rounds in a row (see TurnLimits.stalledRounds). One
 * repeat is ordinary work, re-running a test after an edit; two or more at the moment the budget
 * runs out looks like the start of a loop, so the turn stops and a human decides.
 */
export function canExtendTurn(state: { extensions: number; allowed: number; stalled: number }): boolean {
  return state.extensions < state.allowed && state.stalled < 2;
}
