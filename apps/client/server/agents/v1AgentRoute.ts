import { agentRepository } from '@bike4mind/database';
import { ForbiddenError, NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { assertAgentAccess } from '@server/agents/assertAgentAccess';

// One bucket for all four authoring assistants: each is a model call, so rotating across the routes
// must not multiply the caller's per-minute quota within /api/v1.
export const AUTHORING_RATE_LIMIT_BUCKET = 'POST /api/v1/agents/[id]/authoring';

// A malformed or unknown id, a soft-deleted agent and a system/org agent all come back null or
// ownerless from findById, so assertAgentAccess answers 404 for every one of them.
export async function findOwnedAgent(id: string, userId: string) {
  const agent = await agentRepository.findById(id);
  try {
    assertAgentAccess(agent, userId, 'own');
    return agent;
  } catch (error) {
    if (error instanceof ForbiddenError) throw new NotFoundError('Agent not found');
    throw error;
  }
}
