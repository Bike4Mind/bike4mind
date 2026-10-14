/**
 * Checkpoint depth guard for agentContinuationQueue self-dispatch.
 *
 * Kept in its own module so the thresholds and classification logic can be
 * unit-tested without dragging in the executor's Mongo/AWS/SST deps.
 */

/**
 * Emit a `CheckpointDepthWarning` metric when self-dispatch depth reaches this
 * value so ops can investigate before the hard limit terminates the execution.
 *
 * At 15 min/Lambda: 25 x 15 min ≈ 6.25 hours.
 */
export const CHECKPOINT_DEPTH_WARNING = 25;

/**
 * Hard ceiling on consecutive agentContinuationQueue self-dispatches for a
 * single execution. `checkpointDepth` is incremented in every outgoing SQS
 * message and checked at the top of processExecution before any DB work.
 *
 * At 15 min/Lambda: 50 x 15 min ≈ 12.5 hours - well above any legitimate use
 * case (the largest known runs take < 2 hours end-to-end).
 */
export const MAX_CHECKPOINT_DEPTH = 50;

export type CheckpointDepthVerdict = 'ok' | 'warn' | 'terminate';

/**
 * Classify a checkpoint depth value against the two-tier thresholds.
 *
 * - `'terminate'` - depth has reached MAX_CHECKPOINT_DEPTH; execution must stop
 * - `'warn'`      - depth has reached CHECKPOINT_DEPTH_WARNING; emit metric, keep going
 * - `'ok'`        - below warning threshold; no action needed
 */
export function classifyCheckpointDepth(depth: number): CheckpointDepthVerdict {
  if (depth >= MAX_CHECKPOINT_DEPTH) return 'terminate';
  if (depth >= CHECKPOINT_DEPTH_WARNING) return 'warn';
  return 'ok';
}

/**
 * Collaborators the guard needs, declared structurally so this module stays free
 * of the executor's Mongo/AWS/SST imports (see the file header) and so the guard
 * can be driven with plain fakes in tests.
 */
export interface CheckpointDepthGuardDeps {
  executionId: string;
  logger: {
    warn(message: string, metadata?: Record<string, unknown>): void;
    error(message: string, metadata?: Record<string, unknown>): void;
  };
  emitMetric: (
    namespace: string,
    metricName: string,
    value: number,
    dimensions?: Record<string, string>
  ) => Promise<void>;
  markFailed: (executionId: string, failure: { message: string }) => Promise<unknown>;
  sendWs: (action: string, payload?: Record<string, unknown>) => Promise<void>;
}

/**
 * Apply the two-tier depth guard at the top of processExecution.
 *
 * Returns `true` when the execution was terminated, in which case the caller
 * MUST return immediately without loading the execution: terminating before any
 * DB work is the whole point of the guard, since a runaway agent would otherwise
 * chain Lambdas indefinitely.
 */
export async function enforceCheckpointDepth(depth: number, deps: CheckpointDepthGuardDeps): Promise<boolean> {
  const { executionId, logger, emitMetric, markFailed, sendWs } = deps;
  const verdict = classifyCheckpointDepth(depth);

  if (verdict === 'warn' || verdict === 'terminate') {
    logger.warn('[CheckpointDepth] Self-dispatch depth approaching hard limit', {
      checkpointDepth: depth,
      executionId,
    });
    void emitMetric('Lumina5/AgentExecutor', 'CheckpointDepthWarning', 1, { executionId });
  }

  if (verdict === 'terminate') {
    logger.error('[CheckpointDepth] Max self-dispatch depth exceeded - terminating execution', {
      checkpointDepth: depth,
      executionId,
    });
    void emitMetric('Lumina5/AgentExecutor', 'CheckpointDepthExceeded', 1, { executionId });
    await markFailed(executionId, {
      message: `Execution exceeded maximum self-dispatch depth (${MAX_CHECKPOINT_DEPTH}) - possible runaway agent loop`,
    });
    await sendWs('failed', { executionId, reason: 'max_checkpoint_depth_exceeded' });
    return true;
  }

  return false;
}
