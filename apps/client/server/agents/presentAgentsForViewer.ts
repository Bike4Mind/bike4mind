import { IAgent } from '@bike4mind/common';
import { refreshAgentAvatarUrls } from '@server/utils/refreshAgentAvatarUrls';

/**
 * The shape the user-agent read routes return to `viewerId`: fresh avatar URLs, and owner-only
 * fields (`tavernSessionId`) removed for anyone but the owner, including agents with no owner.
 * The v1 API uses its own allowlist (`toPublicAgent`); the sole writer of `tavernSessionId` is
 * `AgentRepository.updateTavernSessionId`.
 */
export async function presentAgentsForViewer(agents: IAgent[], viewerId: string): Promise<IAgent[]> {
  const refreshed = await refreshAgentAvatarUrls(agents, viewerId);
  return refreshed.map(agent => redactOwnerOnlyFields(agent, viewerId));
}

function redactOwnerOnlyFields(agent: IAgent, viewerId: string): IAgent {
  if (agent.userId === viewerId) return agent;
  const { tavernSessionId: _ownerOnly, ...visible } = agent;
  return visible;
}
