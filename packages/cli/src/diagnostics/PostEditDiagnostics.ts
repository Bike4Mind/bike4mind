import path from 'path';
import type { FeedbackDrainPhase } from '@bike4mind/agents';
import { logger } from '../utils/Logger';
import { checkTypeScriptAndEslint, type Diagnostic, type DiagnosticsChecker } from './checkers';

/**
 * How long a drain waits for in-flight checks (ms). Between turns the model
 * will take another turn anyway, so a busy worker just defers to the next
 * one; at finalization there is no later turn, so it waits longer.
 */
export const DRAIN_BUDGET_MS: Record<FeedbackDrainPhase, number> = { turn: 250, final: 30_000 };

const REPORT_HEADER = '[Post-edit diagnostics] Errors in files you changed. Fix them before you finish:';
const MAX_REPORTED_ERRORS = 20;
const MAX_MESSAGE_LENGTH = 300;

type PostEditDiagnosticsOptions = {
  /** Report paths are relative to this, so absolute home paths never reach the transcript. */
  workspaceRoot: string;
  check?: DiagnosticsChecker;
};

/**
 * Background type/lint checking of files the agent edits, drained into the
 * agent loop via AgentRunOptions.drainFeedback. Edits never wait on a check.
 *
 * Queue semantics are re-edit-wins: a file edited again before its check runs
 * is checked once in its final state, and a file edited again while a check
 * is in flight has that (stale) result discarded in favor of the queued
 * re-check. Each completed result is reported at most once.
 *
 * Only collects between beginTurn() and endTurn(); a no-op otherwise, which is
 * how the per-turn config gate in turnController switches it off.
 */
export class PostEditDiagnostics {
  private readonly workspaceRoot: string;
  private readonly check: DiagnosticsChecker;
  private readonly pending = new Set<string>();
  private readonly results = new Map<string, Diagnostic[]>();
  private worker: Promise<void> | null = null;
  private active = false;
  // Bumped on every turn boundary so a check still running from a previous turn is discarded.
  private generation = 0;

  constructor({ workspaceRoot, check = checkTypeScriptAndEslint }: PostEditDiagnosticsOptions) {
    this.workspaceRoot = workspaceRoot;
    this.check = check;
  }

  beginTurn(): void {
    this.reset();
    this.active = true;
  }

  endTurn(): void {
    this.reset();
    this.active = false;
  }

  enqueue(filePath: string): void {
    if (!this.active) return;
    this.pending.add(path.resolve(this.workspaceRoot, filePath));
    this.worker ??= this.processQueue();
  }

  /**
   * Waits up to `budgetMs` (or until `signal` aborts) for queued checks, then
   * returns the errors found since the last drain, or null when there are none.
   */
  async drain(budgetMs: number, signal?: AbortSignal): Promise<string | null> {
    if (this.worker) await settleWithin(this.worker, budgetMs, signal);
    return this.takeReport();
  }

  private reset(): void {
    this.generation++;
    this.pending.clear();
    this.results.clear();
  }

  private async processQueue(): Promise<void> {
    try {
      while (this.pending.size > 0) {
        const batch = [...this.pending];
        this.pending.clear();
        const generation = this.generation;
        const diagnostics = await this.runCheck(batch);
        if (!diagnostics || generation !== this.generation) continue;
        for (const filePath of batch) {
          if (this.pending.has(filePath)) continue;
          this.results.set(
            filePath,
            diagnostics.filter(diagnostic => diagnostic.filePath === filePath)
          );
        }
      }
    } finally {
      this.worker = null;
    }
  }

  private async runCheck(batch: string[]): Promise<Diagnostic[] | null> {
    try {
      return await this.check(batch);
    } catch (error) {
      logger.debug(`[diagnostics] check failed; skipping ${batch.length} file(s): ${String(error)}`);
      return null;
    }
  }

  private takeReport(): string | null {
    const errors = [...this.results.values()].flat();
    this.results.clear();
    if (errors.length === 0) return null;

    const lines = errors.slice(0, MAX_REPORTED_ERRORS).map(error => this.formatError(error));
    const omitted = errors.length - lines.length;
    if (omitted > 0) lines.push(`(+${omitted} more)`);
    return [REPORT_HEADER, ...lines].join('\n');
  }

  private formatError({ filePath, line, column, code, message }: Diagnostic): string {
    const relativePath = path.relative(this.workspaceRoot, filePath).split(path.sep).join('/');
    const firstLine = message.split('\n')[0];
    const text = firstLine.length > MAX_MESSAGE_LENGTH ? `${firstLine.slice(0, MAX_MESSAGE_LENGTH)}...` : firstLine;
    return `${relativePath}:${line}:${column} - ${code}: ${text}`;
  }
}

/** Resolves when `work` settles, `budgetMs` elapses, or `signal` aborts - whichever is first. */
async function settleWithin(work: Promise<void>, budgetMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const cutoff = new Promise<void>(resolve => {
    timer = setTimeout(resolve, budgetMs);
    onAbort = resolve;
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  try {
    await Promise.race([work, cutoff]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}
