/**
 * Wall time spent in each phase of one operation, for a single debug line rather than one per
 * step: the steps of a session start interleave with every other session's logging.
 */
export class PhaseTimer {
  private readonly startedAt = performance.now();
  private last = this.startedAt;
  private readonly phases: string[] = [];

  lap(phase: string): void {
    const now = performance.now();
    this.phases.push(`${phase}=${Math.round(now - this.last)}ms`);
    this.last = now;
  }

  summary(): string {
    return `${this.phases.join(' ')} total=${Math.round(performance.now() - this.startedAt)}ms`;
  }
}
