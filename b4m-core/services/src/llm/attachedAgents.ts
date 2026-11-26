import type { IAgentDocument, IAgentRepository, IUserDocument } from '@bike4mind/common';

const plain = (agent: IAgentDocument): IAgentDocument =>
  typeof (agent as { toJSON?: unknown }).toJSON === 'function'
    ? (agent as unknown as { toJSON: () => IAgentDocument }).toJSON()
    : agent;

/**
 * The attached agents, in `agentIds` order, that at least one viewer can still read. A session keeps
 * agent ids after the share that allowed attaching them is revoked, so they are re-checked on use.
 * Returned as plain objects (the access query hydrates), the same shape `findById` gives.
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
      if (!usable.has(String(agent.id))) usable.set(String(agent.id), plain(agent));
    }
  }
  return [...new Set(agentIds.map(String))].flatMap(id => usable.get(id) ?? []);
};
