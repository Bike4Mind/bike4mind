/**
 * GET    /api/v1/agents/{id} - the public twin of GET /api/agents/[id].
 * PATCH  /api/v1/agents/{id} - partial update; validates with the same checks as PUT /api/agents/[id].
 * DELETE /api/v1/agents/{id} - the public twin of DELETE /api/agents/[id], over the same deleteAgent.
 *
 * Auth mode, scopes and validation come from the contracts; the SPA route is unchanged. Unlike it,
 * a sharee asking to update or delete gets the same 404 as a stranger, so ownership is not probed.
 */
import { deleteAgentContract, getAgentContract, IAgent, updateAgentContract } from '@bike4mind/common';
import { agentRepository } from '@bike4mind/database';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { dispatchByMethod } from '@server/middlewares/dispatchByMethod';
import { rateLimit } from '@server/middlewares/rateLimit';
import { resolveUserRateLimitPerMin } from '@server/utils/userRateTier';
import { ForbiddenError, NotFoundError } from '@server/utils/errors';
import { validateAgentUpdate } from '@server/utils/agentValidation';
import { assertAgentAccess } from '@server/agents/assertAgentAccess';
import { deleteAgent } from '@server/agents/deleteAgent';
import { toPublicAgent } from '@server/agents/toPublicAgent';
import { toV1AgentError, v1FieldLabel } from '@server/agents/v1AgentErrors';

// Named so every agent id shares one bucket per method instead of one per pathname.
const perUserRateLimit = (bucket: string) =>
  rateLimit({ limit: req => resolveUserRateLimitPerMin(req.user), windowMs: 60 * 1000, bucket });

// A malformed or unknown id, a soft-deleted agent and a system/org agent all come back null or
// ownerless from findById, so assertAgentAccess answers 404 for every one of them.
async function findOwnedAgent(id: string, userId: string) {
  const agent = await agentRepository.findById(id);
  try {
    assertAgentAccess(agent, userId, 'own');
    return agent;
  } catch (error) {
    if (error instanceof ForbiddenError) throw new NotFoundError('Agent not found');
    throw error;
  }
}

const getRoute = nextRouteForContract(getAgentContract, {
  rateLimit: perUserRateLimit('GET /api/v1/agents/[id]'),
}).get(async (req, res) => {
  const agent = await agentRepository.findById(req.validatedParams.id);
  assertAgentAccess(agent, req.user.id, 'view');
  return res.json(toPublicAgent(agent, req.user.id));
});

const updateRoute = nextRouteForContract(updateAgentContract, {
  rateLimit: perUserRateLimit('PATCH /api/v1/agents/[id]'),
}).patch(async (req, res) => {
  const { id } = await findOwnedAgent(req.validatedParams.id, req.user.id);
  const body = req.validated;

  // Only the fields that were sent are written; an omitted one stays absent rather than set undefined.
  const fields = {
    name: body.name,
    description: body.description,
    systemPrompt: body.system_prompt,
    preferredModel: body.preferred_model,
    temperature: body.temperature,
    maxTokens: body.max_tokens,
    allowedTools: body.allowed_tools,
    deniedTools: body.denied_tools,
    triggerWords: body.trigger_words,
  };
  // A null clears the field back to the default; the request schema allows it only on these three.
  const reset = (['preferredModel', 'temperature', 'maxTokens'] as const).filter(field => fields[field] === null);
  const changes: Partial<IAgent> = Object.fromEntries(Object.entries(fields).filter(([, value]) => value != null));
  try {
    validateAgentUpdate(changes, v1FieldLabel);
  } catch (error) {
    throw toV1AgentError(error);
  }

  const updated = await agentRepository.update(
    { id, ...changes },
    reset.length ? { new: true, unset: reset } : { new: true }
  );
  if (!updated) throw new NotFoundError('Agent not found');

  return res.json(toPublicAgent(updated, req.user.id));
});

const deleteRoute = nextRouteForContract(deleteAgentContract, {
  rateLimit: perUserRateLimit('DELETE /api/v1/agents/[id]'),
}).delete(async (req, res) => {
  const agent = await findOwnedAgent(req.validatedParams.id, req.user.id);
  await deleteAgent(agent, req.user.id);
  return res.status(204).end();
});

export const config = {
  api: { externalResolver: true },
};

export default dispatchByMethod({ GET: getRoute, PATCH: updateRoute, DELETE: deleteRoute });
