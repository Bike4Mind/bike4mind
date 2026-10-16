import { IAgent } from '@bike4mind/common';
import { refreshAgentAvatarUrls } from '@server/utils/refreshAgentAvatarUrls';

/**
 * What a viewer who does not own an agent may read. An allowlist, so a field added to `IAgent`
 * stays owner-only until it is named here. It covers what the agent UI renders for someone else's
 * agent (list cards, the view page, session chips, @mention autocomplete) and what dispatching a
 * mentioned or session agent reads client-side (model config, tool lists, iteration limits).
 *
 * Left out on purpose: the system prompt (the owner's authored IP; `toPublicAgent` nulls it for
 * sharees too), the credit balance, memory, pending inter-agent messages, heartbeat and tavern
 * state, the share list, and the owner's session pointer.
 */
export type ViewerAgent = Pick<
  IAgent,
  | 'id'
  | 'name'
  | 'description'
  | 'type'
  | 'isPublic'
  | 'triggerWords'
  | 'capabilities'
  | 'projectId'
  | 'useOwnCredits'
  | 'preferredModel'
  | 'preferredImageModel'
  | 'temperature'
  | 'maxTokens'
  | 'allowedTools'
  | 'deniedTools'
  | 'maxIterations'
  | 'defaultThoroughness'
  | 'personality'
  | 'identity'
  | 'createdAt'
  | 'updatedAt'
> & { visual: Pick<IAgent['visual'], 'portraitUrl' | 'style'> };

export type PresentedAgent = IAgent | ViewerAgent;

/**
 * The shape the agent read routes return to `viewerId`: fresh avatar URLs, the full agent for its
 * owner, and the `ViewerAgent` allowlist for everyone else. Shared by GET /api/agents,
 * GET /api/agents/:id, GET /api/sessions/:id/agents and GET /api/voice/v2/agents so the
 * projection cannot drift between them. The v1 API uses its own allowlist (`toPublicAgent`).
 */
export async function presentAgentsForViewer(agents: IAgent[], viewerId: string): Promise<PresentedAgent[]> {
  const refreshed = await refreshAgentAvatarUrls(agents, viewerId);
  return refreshed.map(agent => (agent.userId === viewerId ? agent : toViewerAgent(agent)));
}

// Built field by field, never by spreading the document, so nothing unlisted can ride along.
function toViewerAgent(agent: IAgent): ViewerAgent {
  return {
    id: agent.id,
    name: agent.name,
    description: agent.description,
    type: agent.type,
    isPublic: agent.isPublic,
    triggerWords: agent.triggerWords ?? [],
    capabilities: agent.capabilities,
    projectId: agent.projectId,
    useOwnCredits: agent.useOwnCredits,
    preferredModel: agent.preferredModel,
    preferredImageModel: agent.preferredImageModel,
    temperature: agent.temperature,
    maxTokens: agent.maxTokens,
    allowedTools: agent.allowedTools,
    deniedTools: agent.deniedTools,
    maxIterations: agent.maxIterations,
    defaultThoroughness: agent.defaultThoroughness,
    personality: agent.personality,
    identity: agent.identity,
    visual: { portraitUrl: agent.visual?.portraitUrl ?? '', style: agent.visual?.style ?? '' },
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
  };
}
