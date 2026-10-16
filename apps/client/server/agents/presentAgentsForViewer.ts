import { IAgent } from '@bike4mind/common';
import { refreshAgentAvatarUrls } from '@server/utils/refreshAgentAvatarUrls';

/**
 * The shape every agent read route returns to `viewerId`: fresh avatar URLs, and owner-only
 * fields removed for anyone but the owner. Shared by GET /api/agents, GET /api/agents/:id and
 * GET /api/sessions/:id/agents so the redaction cannot drift between them.
 *
 * `tavernSessionId` is owner-only: it names the owner's own session, which a shared viewer has no
 * access to. The PUT schema in `pages/api/agents/[id]/index.ts` does not accept it either -- only
 * the server-side session bridge sets it.
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
