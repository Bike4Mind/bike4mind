import { artifactRepository, questNodeRepository } from '@bike4mind/database';
import type { IQuestNodeDocument } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import type { NodeRunSummary } from './reconcileQuestNodes';

/** What the graph view needs to render an artifact chip - never the body. */
export interface NodeArtifact {
  id: string;
  type: string;
  title: string;
}

/**
 * Attach each node's run artifacts to the node, and return them for the wire.
 *
 * The join is `artifact.sourceQuestId === run.questId`: `persistAgentArtifacts`
 * stamps every row it writes with the Quest the run produced, and a v5 node
 * knows that Quest through its execution. Nothing about this is v5-specific on
 * the write side, which is why the node link had to wait for server-side
 * artifact persistence to land.
 *
 * Runs on every graph read rather than only at the completed-transition,
 * deliberately. The executor calls `markComplete` BEFORE `persistRunAsQuest`
 * writes the artifacts, so a node can legitimately reach `completed` a moment
 * before its artifacts exist. Linking only on transition would lose that race
 * permanently; re-deriving on read makes it self-healing, and `linkArtifacts`
 * uses `$addToSet` so repeats are free.
 *
 * One batched query for the whole graph, projected to id/type/title - a
 * per-node lookup would be an N+1 on a polled endpoint, and the full document
 * carries the artifact body.
 *
 * Best-effort by contract: artifacts are an enrichment, so a failure here
 * returns an empty map and leaves the graph perfectly readable.
 */
export async function linkNodeArtifacts(
  nodes: IQuestNodeDocument[],
  runs: Map<string, NodeRunSummary>,
  logger: Logger
): Promise<Map<string, NodeArtifact[]>> {
  const byNode = new Map<string, NodeArtifact[]>();

  const questIdByNode = new Map<string, string>();
  for (const node of nodes) {
    const executionId = node.execution?.agentExecutionId;
    const questId = executionId ? runs.get(executionId)?.questId : undefined;
    if (questId) questIdByNode.set(node.id, questId);
  }
  if (!questIdByNode.size) return byNode;

  try {
    const rows = await artifactRepository.findByQuestIds([...new Set(questIdByNode.values())]);
    if (!rows.length) return byNode;

    const byQuest = new Map<string, NodeArtifact[]>();
    for (const row of rows) {
      const list = byQuest.get(row.sourceQuestId) ?? [];
      list.push({ id: row.id, type: row.type, title: row.title });
      byQuest.set(row.sourceQuestId, list);
    }

    await Promise.all(
      nodes.map(async node => {
        const questId = questIdByNode.get(node.id);
        const artifacts = questId ? byQuest.get(questId) : undefined;
        if (!artifacts?.length) return;
        byNode.set(node.id, artifacts);

        // Persist only what the node does not already carry, so a steady-state
        // read does no writes at all.
        const missing = artifacts.map(a => a.id).filter(id => !node.artifactIds.includes(id));
        if (!missing.length) return;
        try {
          await questNodeRepository.linkArtifacts(node.id, missing);
        } catch (err) {
          logger.warn('[questmaster-v5] could not attach artifacts to node - they still render', {
            nodeId: node.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      })
    );
  } catch (err) {
    logger.warn('[questmaster-v5] artifact lookup failed - rendering the graph without artifacts', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return byNode;
}
