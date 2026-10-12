import type { AgentResource, IAgent } from '@bike4mind/common';

/** The agent fields the public shape may read. Anything else on the document never reaches `/api/v1`. */
export type PublicAgentSource = Pick<IAgent, 'id' | 'name' | 'description'> &
  Partial<
    Pick<
      IAgent,
      | 'userId'
      | 'systemPrompt'
      | 'preferredModel'
      | 'temperature'
      | 'maxTokens'
      | 'allowedTools'
      | 'deniedTools'
      | 'triggerWords'
      | 'createdAt'
      | 'updatedAt'
    >
  >;

const toIso = (value: Date | string | undefined | null): string | null => {
  if (value === undefined || value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

/**
 * Allowlist projection onto the public `AgentResource` (schemas/agentPublic.ts). Built field by
 * field, never by spreading the document, so sharing state, credits and memory cannot leak. The
 * system prompt is the owner's authored IP, so a sharee gets `null`.
 */
export function toPublicAgent(agent: PublicAgentSource, callerId: string): AgentResource {
  const isOwner = agent.userId === callerId;
  return {
    id: String(agent.id),
    name: agent.name,
    description: agent.description,
    system_prompt: isOwner ? (agent.systemPrompt ?? '') : null,
    preferred_model: agent.preferredModel ?? null,
    temperature: agent.temperature ?? null,
    max_tokens: agent.maxTokens ?? null,
    allowed_tools: agent.allowedTools ?? null,
    denied_tools: agent.deniedTools ?? null,
    trigger_words: agent.triggerWords ?? [],
    is_owner: isOwner,
    created_at: toIso(agent.createdAt),
    updated_at: toIso(agent.updatedAt),
  };
}
