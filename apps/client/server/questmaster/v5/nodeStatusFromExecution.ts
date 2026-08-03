import type { AgentExecutionStatus, NodeStatus } from '@bike4mind/common';

/**
 * Map an AgentExecution's status onto the QuestNode status it implies.
 *
 * A v5 node does not track its own progress - it delegates to the agent
 * executor and *derives* progress from the execution doc. This keeps the
 * executor (a 2900-line Lambda on the hot path for all of agent mode) free of
 * any QuestMaster coupling: nothing writes back to the node, the node reads
 * forward from the run.
 *
 * Returns `null` when the execution is still in flight and the node's status
 * should be left alone.
 *
 * Phase 4 will interpose the review gate here: `completed` will land the node
 * on `needs_review` and only a passing score will advance it to `completed`.
 * Until the scorer exists, a finished run completes the node directly -
 * otherwise every node would park on `needs_review` with nothing able to
 * advance it, and `computeReadyNodes` (which unblocks dependents on
 * `completed`/`skipped`) would deadlock the graph the moment Phase 2 starts
 * rolling it.
 */
export function nodeStatusFromExecution(executionStatus: AgentExecutionStatus): NodeStatus | null {
  switch (executionStatus) {
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    // A human (or a cascade) stopped the run, so the node did not produce an
    // accepted result. Terminal rather than back-to-pending so the graph
    // doesn't silently re-run it; the run endpoint still allows an explicit retry.
    case 'aborted':
      return 'failed';
    default:
      return null;
  }
}
