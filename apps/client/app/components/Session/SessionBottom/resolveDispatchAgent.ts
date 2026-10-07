import type { IAgent } from '@bike4mind/common';

/**
 * The agent an agent-mode run executes as. Precedence: the orchestration-configured @mention,
 * then the first plain @mention, then the first agent attached with the composer's Agents
 * picker. "First attached" matches the `session.agentIds[0]` that b4m-core/services
 * ChatCompletionInvoke records as the session's agent in prompt metadata. Null means the
 * executor builds the synthetic profile from admin defaults.
 */
export function resolveDispatchAgent(
  orchestrationAgent: IAgent | null,
  mentionedAgent: IAgent | null,
  attachedAgents: readonly IAgent[]
): IAgent | null {
  return orchestrationAgent ?? mentionedAgent ?? attachedAgents[0] ?? null;
}

/** Iteration cap for the dispatched agent; undefined when it sets no default thoroughness so the server's admin default applies. */
export function resolveDispatchMaxIterations(agent: IAgent | null): number | undefined {
  return agent?.defaultThoroughness ? agent.maxIterations?.[agent.defaultThoroughness] : undefined;
}

/** The agents the composer's Agents badge shows: the session's once it exists, else the workbench's. */
export function pickerAttachedAgents(
  currentSessionId: string | null | undefined,
  sessionAgents: readonly IAgent[],
  workBenchAgents: readonly IAgent[]
): readonly IAgent[] {
  return currentSessionId ? sessionAgents : workBenchAgents;
}
