import { agentExecutionRepository, questNodeRepository } from '@bike4mind/database';
import type { IQuestNodeDocument } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import { nodeStatusFromExecution } from './nodeStatusFromExecution';

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
 * Best-effort per node: one node's reconciliation failure must not fail the
 * read of the whole graph, so failures log and leave that node untouched.
 */
export async function reconcileQuestNodes(nodes: IQuestNodeDocument[], logger: Logger): Promise<IQuestNodeDocument[]> {
  const inFlight = nodes.filter(n => n.status === 'in_progress' && n.execution?.agentExecutionId);
  if (!inFlight.length) return nodes;

  const patched = new Map<string, IQuestNodeDocument>();

  await Promise.all(
    inFlight.map(async node => {
      const executionId = node.execution!.agentExecutionId!;
      try {
        const execution = await agentExecutionRepository.findById(executionId);
        if (!execution) {
          logger.warn('[questmaster-v5] execution missing for in-flight node - leaving node in_progress', {
            nodeId: node.id,
            executionId,
          });
          return;
        }

        const nextStatus = nodeStatusFromExecution(execution.status);
        if (!nextStatus) return;

        const updated = await questNodeRepository.updateStatus(node.id, nextStatus, {
          completedAt: new Date(),
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
