import type { IAgent } from '@bike4mind/common';

/**
 * The agent an agent-mode run executes as. Precedence: the orchestration-configured @mention,
 * then the first plain @mention, then the first agent attached with the composer's Agents
 * picker. "First attached" matches how chat completion picks a session's agent
 * (`session.agentIds[0]` in b4m-core/services ChatCompletionInvoke). Null means the executor
 * builds the synthetic profile from admin defaults.
 */
export function resolveDispatchAgent(
  orchestrationAgent: IAgent | null,
  mentionedAgent: IAgent | null,
  attachedAgents: readonly IAgent[]
): IAgent | null {
  return orchestrationAgent ?? mentionedAgent ?? attachedAgents[0] ?? null;
}
