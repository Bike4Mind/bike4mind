import { questGraphRepository, questNodeRepository } from '@bike4mind/database';
import { NotFoundError } from '@bike4mind/common';
import type { IQuestGraphDocument, IQuestNodeDocument } from '@bike4mind/common';

/**
 * Ownership checks for v5 graphs and nodes.
 *
 * A graph the caller does not own is reported as 404, not 403: a 403 confirms
 * the id exists and turns the endpoints into an enumeration oracle over other
 * users' graph ids. The `visibility` field on QuestGraph is not consulted yet -
 * sharing is unbuilt, so every graph is effectively private and treating
 * `shared`/`public` as readable here would grant access no UI has authored.
 */
export async function requireOwnedGraph(graphId: string, userId: string): Promise<IQuestGraphDocument> {
  const graph = await questGraphRepository.findById(graphId);
  if (!graph || graph.userId !== userId) throw new NotFoundError('Quest graph not found');
  return graph;
}

/** Resolve a node and the graph that owns it, asserting the caller owns both. */
export async function requireOwnedNode(
  nodeId: string,
  userId: string
): Promise<{ node: IQuestNodeDocument; graph: IQuestGraphDocument }> {
  const node = await questNodeRepository.getNode(nodeId);
  if (!node) throw new NotFoundError('Quest node not found');
  const graph = await requireOwnedGraph(node.graphId, userId);
  return { node, graph };
}
