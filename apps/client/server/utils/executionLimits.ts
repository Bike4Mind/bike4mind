/**
 * Limits shared by every path that can dispatch a top-level agent execution.
 *
 * These live here rather than next to one dispatcher because there is now more
 * than one: the WebSocket `agent_execute` start, and the QuestMaster v5 node
 * runner. A cap enforced by only one of them is not a cap.
 */

/** Top-level agent executions a single user may have in flight at once. */
export const MAX_CONCURRENT_EXECUTIONS_PER_USER = 3;

/**
 * How long an `active` execution may go without a write before a dispatcher
 * treats it as dead and sweeps it. A healthy run touches its doc every step, so
 * a stale `updatedAt` is the cleanest "this Lambda is never coming back"
 * signal. Without the sweep, executions orphaned by a dropped SQS handoff or a
 * crashed Lambda accumulate and lock the user out of new runs.
 */
export const STALE_ACTIVE_MS = 20 * 60 * 1000;
