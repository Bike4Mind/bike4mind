import { agentRepository } from '@bike4mind/database';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { ForbiddenError, NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { assertAgentAccess } from '@server/agents/assertAgentAccess';
import { resolveUserRateLimitPerMin } from '@server/utils/userRateTier';

// Named so every agent id shares one bucket per method instead of one per pathname.
export const perUserRateLimit = (bucket: string) =>
  rateLimit({ limit: req => resolveUserRateLimitPerMin(req.user, req), windowMs: 60 * 1000, bucket });

// One bucket for all four authoring assistants: each is a model call, so rotating across the routes
// must not multiply the caller's per-minute quota.
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
