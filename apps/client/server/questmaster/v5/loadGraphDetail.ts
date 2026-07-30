import { agentExecutionRepository, isNodeReady, questNodeRepository } from '@bike4mind/database';
import type { IQuestGraphDocument, IQuestNodeDocument, NodeStatus } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import { reconcileQuestNodes } from './reconcileQuestNodes';
import { toQuestGraphWire, toQuestNodeWire, type QuestNodeRunWire, type QuestNodeWire } from './wire';

/** Terminal answers can be long; the graph view only needs a readable excerpt. */
const MAX_ANSWER_CHARS = 20_000;

/**
 * Load a graph with its nodes, reconciled against their runs and annotated
 * with DAG readiness and a run summary.
 *
 * This is the read path the graph view polls, so it is also where lazy
 * reconciliation happens - see `reconcileQuestNodes` for why the executor does
 * not push status back instead.
 */
export async function loadGraphDetail(graph: IQuestGraphDocument, logger: Logger) {
  const stored = await questNodeRepository.getNodes(graph.id);
  const nodes = await reconcileQuestNodes(stored, logger);

  const statusById = new Map<string, NodeStatus>(nodes.map(n => [n.id, n.status]));
  const runs = await loadRunSummaries(nodes, logger);

  return {
    graph: toQuestGraphWire(graph),
    nodes: nodes.map(node =>
      toQuestNodeWire(node, {
        isReady: isNodeReady(node, statusById),
        run: runs.get(node.id) ?? null,
      })
    ),
  } satisfies { graph: unknown; nodes: QuestNodeWire[] };
}

/**
 * Fetch the execution behind each dispatched node. Best-effort: a missing or
 * unreadable execution yields no run summary rather than failing the graph read,
 * because the node's own status is already authoritative for the view.
 */
async function loadRunSummaries(nodes: IQuestNodeDocument[], logger: Logger): Promise<Map<string, QuestNodeRunWire>> {
  const summaries = new Map<string, QuestNodeRunWire>();

  await Promise.all(
    nodes.map(async node => {
      const executionId = node.execution?.agentExecutionId;
      if (!executionId) return;
      try {
        const execution = await agentExecutionRepository.findById(executionId);
        if (!execution) return;
        const result = execution.result as { answer?: unknown; totalIterations?: unknown } | undefined;
        const answer = typeof result?.answer === 'string' ? result.answer : null;
        summaries.set(node.id, {
          executionId,
          status: execution.status,
          answer: answer !== null && answer.length > MAX_ANSWER_CHARS ? answer.slice(0, MAX_ANSWER_CHARS) : answer,
          totalIterations: typeof result?.totalIterations === 'number' ? result.totalIterations : null,
          totalCreditsUsed: execution.totalCreditsUsed ?? null,
          errorMessage: execution.error?.message ?? null,
        });
      } catch (err) {
        logger.warn('[questmaster-v5] failed to load run summary for node', {
          nodeId: node.id,
          executionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })
  );

  return summaries;
}
