/**
 * Lightweight pipeline phase timer for structured performance instrumentation.
 *
 * Usage:
 *   const timer = new PipelineTimer();
 *   timer.phase('init');
 *   // ... do init work ...
 *   timer.phase('essential_data');
 *   // ... fetch data ...
 *   timer.end();
 *
 *   logger.info(timer.summary());
 *   quest.promptMeta.performance.phases = timer.toRecord();
 */
export class PipelineTimer {
  private start = Date.now();
  private phases: { name: string; start: number; end?: number }[] = [];

  /** End the current phase (if any) and start a new one. */
  phase(name: string): void {
    const now = Date.now();
    // Close the active phase
    const active = this.phases[this.phases.length - 1];
    if (active && active.end === undefined) {
      active.end = now;
    }
    this.phases.push({ name, start: now });
  }

  /** End the current phase without starting a new one. */
  end(): void {
    const active = this.phases[this.phases.length - 1];
    if (active && active.end === undefined) {
      active.end = Date.now();
    }
  }

  /** Return a record of phase name -> duration in ms. */
  toRecord(): Record<string, number> {
    const record: Record<string, number> = {};
    for (const p of this.phases) {
      record[p.name] = (p.end ?? Date.now()) - p.start;
    }
    return record;
  }

  /** Total elapsed time since timer creation. */
  totalMs(): number {
    return Date.now() - this.start;
  }

  /** Formatted single-line summary suitable for structured loggers that prefix each line. */
  summary(): string {
    const total = this.totalMs();
    const parts: string[] = [];
    for (const p of this.phases) {
      const dur = (p.end ?? Date.now()) - p.start;
      const pct = total > 0 ? ((dur / total) * 100).toFixed(1) : '0.0';
      parts.push(`${p.name}: ${dur}ms (${pct}%)`);
    }
    return `${parts.join(' | ')} | TOTAL: ${total}ms`;
  }
}
