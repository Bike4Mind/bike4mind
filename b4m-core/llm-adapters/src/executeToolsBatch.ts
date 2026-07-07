import { PermissionDeniedError, getQuestErrorCode } from '@bike4mind/common';

/** Default concurrency cap to prevent resource exhaustion (DB pools, rate limits, memory) */
export const DEFAULT_MAX_PARALLEL_TOOLS = 8;

export type TaskOutcome<T> = { ok: true; result: T } | { ok: false; error: unknown };

/**
 * A tool failure that must end the whole turn rather than be fed back to the model
 * as a recoverable observation. Two cases today:
 * - PermissionDeniedError: the user declined the tool; retrying is pointless.
 * - Out-of-credits (tagged via `getQuestErrorCode`, e.g. insufficient_credits): no
 *   tool call can succeed without credits, so we short-circuit to the quest-level
 *   error state (which renders the inline "Add Credits" CTA) instead of letting the
 *   model narrate around a dead-end error string.
 */
function isTerminalToolError(error: unknown): boolean {
  return error instanceof PermissionDeniedError || getQuestErrorCode(error) !== undefined;
}

/**
 * Execute an array of async tasks either in parallel (with concurrency limiting)
 * or sequentially, returning outcomes in the original order.
 *
 * Security: PermissionDeniedError is always re-thrown immediately.
 * - Sequential: breaks the loop on first PermissionDeniedError.
 * - Parallel: all tasks in the batch run to completion (inherent to Promise.allSettled),
 *   but outcomes are pre-scanned for PermissionDeniedError before returning.
 *   This is accepted because PermissionDeniedError is rare in multi-tool batches.
 *
 * Fault isolation: uses Promise.allSettled so a single failure doesn't abort the batch.
 * Order preservation: results are indexed back to the original task array.
 */
export async function executeToolsBatch<T>(
  tasks: Array<() => Promise<T>>,
  options: {
    parallel: boolean;
    maxConcurrency?: number;
  }
): Promise<TaskOutcome<T>[]> {
  const { parallel, maxConcurrency = DEFAULT_MAX_PARALLEL_TOOLS } = options;

  if (parallel && tasks.length > 1) {
    const settled = await runWithConcurrency(tasks, maxConcurrency);

    const outcomes: TaskOutcome<T>[] = settled.map(s =>
      s.status === 'fulfilled' ? { ok: true as const, result: s.value } : { ok: false as const, error: s.reason }
    );

    // Fail-fast: check for terminal errors before returning any results.
    // With Promise.allSettled, sibling tasks have already executed - this is
    // accepted because terminal tool errors are rare in multi-tool batches.
    for (const outcome of outcomes) {
      if (!outcome.ok && isTerminalToolError(outcome.error)) {
        throw outcome.error;
      }
    }

    return outcomes;
  }

  // Sequential execution (single task or parallel opted out)
  const outcomes: TaskOutcome<T>[] = [];
  for (const task of tasks) {
    try {
      const result = await task();
      outcomes.push({ ok: true, result });
    } catch (error) {
      if (isTerminalToolError(error)) throw error;
      outcomes.push({ ok: false, error });
    }
  }
  return outcomes;
}

/**
 * Run tasks with bounded concurrency using a worker-pool pattern.
 * Spawns up to `limit` workers that pull from a shared task queue.
 * Results are stored by index to preserve original ordering.
 */
async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  limit: number
): Promise<PromiseSettledResult<T>[]> {
  if (limit >= tasks.length) {
    // No limiting needed - run all at once
    return Promise.allSettled(tasks.map(fn => fn()));
  }

  const results: PromiseSettledResult<T>[] = new Array(tasks.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < tasks.length) {
      const index = nextIndex++;
      try {
        results[index] = { status: 'fulfilled', value: await tasks[index]() };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  }

  const workerCount = Math.min(limit, tasks.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
