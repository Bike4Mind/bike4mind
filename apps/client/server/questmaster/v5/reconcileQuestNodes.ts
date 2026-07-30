import { questNodeRepository } from '@bike4mind/database';
import type { AgentExecutionStatus, IQuestNodeDocument } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import { nodeStatusFromExecution } from './nodeStatusFromExecution';

/** The projected slice of an AgentExecution a node needs to reconcile and render. */
export interface NodeRunSummary {
  id: string;
  status: AgentExecutionStatus;
  answer: string | null;
  totalIterations: number | null;
  totalCreditsUsed: number | null;
  errorMessage: string | null;
  completedAt: Date | null;
}

/**
 * Bring `in_progress` nodes in line with the executions they dispatched.
 *
 * Reconciliation is pull-based and lazy: it runs when a graph is read (and,
 * from Phase 2, on each scheduler tick) rather than being pushed from the
 * agent executor's terminal path. That is a deliberate choice - the executor
 * stays entirely unaware of QuestMaster, so v5 adds zero risk to the agent-mode
 * hot path, and a node's status is always *derived* from its run rather than
 * being a second source of truth that can drift when a Lambda dies mid-write.
 *
 * Takes the already-fetched run summaries rather than querying for them, so the
 * caller reads each execution exactly once (see `loadGraphDetail`).
 *
 * Best-effort per node: one node's write failing must not fail the read of the
 * whole graph, so failures log and leave that node untouched.
 */
export async function reconcileQuestNodes(
  nodes: IQuestNodeDocument[],
  runs: Map<string, NodeRunSummary>,
  logger: Logger
): Promise<IQuestNodeDocument[]> {
  const inFlight = nodes.filter(n => n.status === 'in_progress' && n.execution?.agentExecutionId);
  if (!inFlight.length) return nodes;

  const patched = new Map<string, IQuestNodeDocument>();

  await Promise.all(
    inFlight.map(async node => {
      const executionId = node.execution!.agentExecutionId!;
      const run = runs.get(executionId);
      if (!run) {
        logger.warn('[questmaster-v5] no execution for an in-flight node - leaving it in_progress', {
          nodeId: node.id,
          executionId,
        });
        return;
      }

      const nextStatus = nodeStatusFromExecution(run.status);
      if (!nextStatus) return;

      try {
        // The execution's own completion time, not "now" - a node that finished
        // while nobody was looking must not be stamped with the moment somebody
        // finally read the graph, or every duration derived from it is wrong.
        const updated = await questNodeRepository.updateStatus(node.id, nextStatus, {
          completedAt: run.completedAt ?? new Date(),
        });
        if (updated) patched.set(node.id, updated);
      } catch (err) {
        logger.warn('[questmaster-v5] node reconciliation failed - leaving node in_progress', {
          nodeId: node.id,
          executionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })
  );

  return patched.size ? nodes.map(n => patched.get(n.id) ?? n) : nodes;
}
