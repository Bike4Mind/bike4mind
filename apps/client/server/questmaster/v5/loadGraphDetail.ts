import { agentExecutionRepository, isNodeReady, isNodeRunnable, questNodeRepository } from '@bike4mind/database';
import type { IQuestGraphDocument, NodeStatus } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import { reconcileQuestNodes, type NodeRunSummary } from './reconcileQuestNodes';
import { linkNodeArtifacts } from './linkNodeArtifacts';
import { toQuestGraphWire, toQuestNodeWire, type QuestNodeRunWire } from './wire';

/**
 * Terminal answers can be long. The graph view only needs a readable excerpt,
 * and the wire reports when it truncated rather than silently handing back a
 * prefix that looks complete.
 */
const MAX_ANSWER_CHARS = 20_000;

/**
 * Load a graph with its nodes, reconciled against their runs and annotated
 * with DAG readiness and a run summary.
 *
 * This is the read path the graph view polls while a node runs, so it is also
 * where lazy reconciliation happens (see `reconcileQuestNodes`). Every
 * execution is read ONCE, in one projected batch query, and that same batch
 * feeds both reconciliation and the run summaries - a per-node `findById` here
 * would be an N+1 on a 3-second poll, and would drag the whole `result` object
 * (including the full iteration trace in `result.steps`) across the wire from
 * Mongo just to read an answer string off it.
 */
export async function loadGraphDetail(graph: IQuestGraphDocument, logger: Logger) {
  const stored = await questNodeRepository.getNodes(graph.id);

  const executionIds = stored.map(n => n.execution?.agentExecutionId).filter((id): id is string => Boolean(id));
  const runs = await loadRunSummaries(executionIds, logger);

  const nodes = await reconcileQuestNodes(stored, runs, logger);
  const statusById = new Map<string, NodeStatus>(nodes.map(n => [n.id, n.status]));
  const artifactsByNode = await linkNodeArtifacts(nodes, runs, logger);

  return {
    graph: toQuestGraphWire(graph),
    nodes: nodes.map(node => {
      const executionId = node.execution?.agentExecutionId;
      const run = executionId ? runs.get(executionId) : undefined;
      return toQuestNodeWire(node, {
        isReady: isNodeReady(node, statusById),
        isRunnable: isNodeRunnable(node, statusById),
        run: run ? toRunWire(executionId!, run) : null,
        artifacts: artifactsByNode.get(node.id) ?? [],
      });
    }),
  };
}

function toRunWire(executionId: string, run: NodeRunSummary): QuestNodeRunWire {
  const truncated = run.answer !== null && run.answer.length > MAX_ANSWER_CHARS;
  return {
    executionId,
    status: run.status,
    answer: truncated ? run.answer!.slice(0, MAX_ANSWER_CHARS) : run.answer,
    answerTruncated: truncated,
    totalIterations: run.totalIterations,
    totalCreditsUsed: run.totalCreditsUsed,
    errorMessage: run.errorMessage,
  };
}

/**
 * Best-effort: if the batch read fails the graph still renders, just without
 * run detail, because each node's own status is already authoritative for the
 * view. Keyed by execution id (not node id) so reconciliation and the wire
 * mapping share one lookup.
 */
async function loadRunSummaries(executionIds: string[], logger: Logger): Promise<Map<string, NodeRunSummary>> {
  if (!executionIds.length) return new Map();
  try {
    const summaries = await agentExecutionRepository.findRunSummariesByIds(executionIds);
    return new Map(summaries.map(s => [s.id, s]));
  } catch (err) {
    logger.warn('[questmaster-v5] failed to load run summaries - rendering the graph without them', {
      count: executionIds.length,
      error: err instanceof Error ? err.message : String(err),
    });
    return new Map();
  }
}
