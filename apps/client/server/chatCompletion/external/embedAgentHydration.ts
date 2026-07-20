import { buildAgentPersonaPrompt, type IAgent } from '@bike4mind/common';

/**
 * The runtime shape the embed chat route needs from a configured agent. All
 * server-side only - none of this crosses the response boundary to the browser.
 */
export interface HydratedEmbedAgent {
  model: string;
  systemPrompt: string;
  temperature?: number;
  maxTokens?: number;
  allowedTools: string[];
  deniedTools: string[];
  /**
   * The agent's Project; its files scope KB retrieval. Undefined resolves to an EMPTY
   * kbScope - the KB tools stay available but read nothing (fail-closed), never
   * owner-wide. See buildEmbedServerTools in embedRoute.ts.
   */
  projectId?: string;
}

/**
 * Project a stored agent into the fields the embed streaming path consumes.
 *
 * Uses the pure `buildAgentPersonaPrompt` directly rather than the WS/SQS
 * `resolveTopLevelProfile`, so hydration carries none of the ReAct/session/
 * orchestration machinery - just persona + model config + the tool lists a
 * later milestone gates.
 */
export function hydrateEmbedAgent(agent: IAgent): HydratedEmbedAgent {
  return {
    model: agent.preferredModel ?? '',
    systemPrompt: buildAgentPersonaPrompt(agent),
    temperature: agent.temperature,
    maxTokens: agent.maxTokens,
    allowedTools: agent.allowedTools ?? [],
    deniedTools: agent.deniedTools ?? [],
    projectId: agent.projectId,
  };
}
