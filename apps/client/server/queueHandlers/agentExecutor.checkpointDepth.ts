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
