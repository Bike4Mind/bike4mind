import { ForbiddenError, NotFoundError } from '@bike4mind/utils';

/** `view`: owner or a user the agent is shared with. `own`: owner only. */
export type AgentAccess = 'view' | 'own';

export type AgentAccessShape = {
  userId?: string | null;
  users?: { userId: string }[] | null;
};

const DEFAULT_FORBIDDEN_MESSAGE = "You don't have permission to modify this agent";

/**
 * Throws unless `userId` may act on `agent` at the requested level.
 *
 * A missing agent and one the caller cannot see throw the identical NotFoundError, so a stranger
 * cannot probe which ids exist. Only a caller who can already view the agent (a shared user asking
 * for `own` access) gets a ForbiddenError, since for them nothing is leaked.
 */
export function assertAgentAccess<T extends AgentAccessShape>(
  agent: T | null | undefined,
  userId: string,
  access: AgentAccess,
  forbiddenMessage: string = DEFAULT_FORBIDDEN_MESSAGE
): asserts agent is T {
  if (!agent) throw new NotFoundError('Agent not found');

  if (agent.userId === userId) return;

  const isSharedWithUser = agent.users?.some(share => share.userId === userId) ?? false;
  if (!isSharedWithUser) throw new NotFoundError('Agent not found');

  if (access === 'own') throw new ForbiddenError(forbiddenMessage);
}
