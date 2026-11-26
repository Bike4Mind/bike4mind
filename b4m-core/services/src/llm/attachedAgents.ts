import type { IAgentDocument, IAgentRepository, IUserDocument } from '@bike4mind/common';

/**
 * The attached agents, in `agentIds` order, that at least one viewer can still read. A session keeps
 * agent ids after the share that allowed attaching them is revoked, so they are re-checked on use.
 */
export const findUsableAttachedAgents = async (
  agentIds: readonly string[],
  viewers: ReadonlyArray<Pick<IUserDocument, 'id' | 'groups'> | null | undefined>,
  agents: Pick<IAgentRepository, 'shareable'>
): Promise<IAgentDocument[]> => {
  if (agentIds.length === 0) return [];
  const usable = new Map<string, IAgentDocument>();
  for (const viewer of viewers) {
    if (!viewer) continue;
    for (const agent of await agents.shareable.findAllAccessibleByIds(viewer, [...agentIds])) {
      usable.set(String(agent.id), agent);
    }
  }
  return agentIds.flatMap(id => usable.get(String(id)) ?? []);
};
