import type { IAgentDocument, IAgentRepository, IUserDocument } from '@bike4mind/common';

/**
 * The attached agents, in `agentIds` order, that at least one viewer can still read. A session keeps
 * agent ids after the share that allowed attaching them is revoked, so they are re-checked on use.
 * Loaded through `findById` so callers get the same plain shape as before the check.
 */
export const findUsableAttachedAgents = async (
  agentIds: readonly string[],
  viewers: ReadonlyArray<Pick<IUserDocument, 'id' | 'groups'> | null | undefined>,
  agents: Pick<IAgentRepository, 'shareable' | 'findById'>
): Promise<IAgentDocument[]> => {
  if (agentIds.length === 0) return [];
  const usable = new Set<string>();
  for (const viewer of viewers) {
    if (!viewer) continue;
    for (const agent of await agents.shareable.findAllAccessibleByIds(viewer, [...agentIds])) {
      usable.add(String(agent.id));
    }
  }
  const ids = [...new Set(agentIds.map(String))].filter(id => usable.has(id));
  const loaded = await Promise.all(ids.map(id => agents.findById(id)));
  return loaded.filter((agent): agent is IAgentDocument => agent != null);
};
