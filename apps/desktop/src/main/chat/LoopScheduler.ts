import { loopDecision, type LoopState } from '@shared/loop';

export type LoopOutcome = { ok: true; reply: string } | { ok: false; error: string };

interface Entry {
  state: LoopState;
  controller: AbortController;
  timer?: ReturnType<typeof setTimeout>;
  run: (signal: AbortSignal) => Promise<LoopOutcome>;
}

export class LoopScheduler {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly busy: (sessionId: string) => boolean,
    private readonly changed: (sessionId: string, state: LoopState | null) => void
  ) {}

  get(sessionId: string): LoopState | null {
    const state = this.entries.get(sessionId)?.state;
    return state ? { ...state } : null;
  }

  start(state: LoopState, run: Entry['run']): void {
    this.stop(state.sessionId);
    const entry: Entry = { state: { ...state }, run, controller: new AbortController() };
    this.entries.set(state.sessionId, entry);
    this.arm(entry, 0);
  }

  stop(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    this.entries.delete(sessionId);
    clearTimeout(entry.timer);
    entry.controller.abort();
    this.changed(sessionId, null);
  }

  clear(): void {
    for (const id of this.entries.keys()) this.stop(id);
  }

  idle(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (entry?.state.phase === 'waiting' && !this.busy(sessionId)) this.arm(entry, 0);
  }

  pauseWaiting(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (!entry || entry.state.phase === 'running') return;
    clearTimeout(entry.timer);
    entry.state.phase = 'paused';
    entry.state.nextRunAt = null;
    entry.state.error = 'A turn failed or stopped. Start /loop again to resume.';
    this.publish(entry);
  }

  private publish(entry: Entry): void {
    this.changed(entry.state.sessionId, { ...entry.state });
  }

  private arm(entry: Entry, delay: number): void {
    entry.state.phase = 'scheduled';
    entry.state.nextRunAt = Date.now() + delay;
    this.publish(entry);
    entry.timer = setTimeout(() => void this.fire(entry), delay);
  }

  private async fire(entry: Entry): Promise<void> {
    const { sessionId } = entry.state;
    if (this.entries.get(sessionId) !== entry) return;
    entry.state.nextRunAt = null;
    if (this.busy(sessionId)) {
      entry.state.phase = 'waiting';
      this.publish(entry);
      return;
    }
    entry.state.phase = 'running';
    this.publish(entry);
    let outcome: LoopOutcome;
    try {
      outcome = await entry.run(entry.controller.signal);
    } catch (error) {
      outcome = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    if (this.entries.get(sessionId) !== entry) return;
    const delay = outcome.ok ? (entry.state.intervalMs ?? loopDecision(outcome.reply)) : null;
    if (delay === null) {
      entry.state.phase = 'paused';
      entry.state.error = outcome.ok
        ? 'The model did not end its reply with a valid LOOP_NEXT: interval (30s to 1d). Start /loop again to resume.'
        : outcome.error;
      this.publish(entry);
      return;
    }
    this.arm(entry, delay);
  }
}
