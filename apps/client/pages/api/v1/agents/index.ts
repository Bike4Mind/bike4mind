/**
 * GET  /api/v1/agents - the public, cursor-paginated twin of GET /api/agents.
 * POST /api/v1/agents - the public twin of POST /api/agents, over the same createAgent.
 *
 * Auth mode, scopes and validation come from `listAgentsContract` / `createAgentContract`; the SPA
 * routes under /api/agents are unchanged. Every response renders through toPublicAgent.
 */
import { createAgentContract, listAgentsContract } from '@bike4mind/common';
import { agentRepository } from '@bike4mind/database';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { dispatchByMethod } from '@server/middlewares/dispatchByMethod';
import { rateLimit } from '@server/middlewares/rateLimit';
import { resolveUserRateLimitPerMin } from '@server/utils/userRateTier';
import { decodeCursor, encodeCursor } from '@server/utils/cursorPagination';
import { isValidObjectId } from '@server/utils/objectId';
import { UnprocessableEntityError } from '@server/utils/errors';
import { validateToolList } from '@server/utils/agentValidation';
import { createAgent } from '@server/agents/createAgent';
import { toPublicAgent } from '@server/agents/toPublicAgent';
import { toV1AgentError } from '@server/agents/v1AgentErrors';

const CURSOR_SCOPE = 'v1.agents';
const perUserRateLimit = (bucket: string) =>
  rateLimit({ limit: req => resolveUserRateLimitPerMin(req.user), windowMs: 60 * 1000, bucket });

const listRoute = nextRouteForContract(listAgentsContract, {
  rateLimit: perUserRateLimit('GET /api/v1/agents'),
}).get(async (req, res) => {
  const { limit, cursor } = req.validatedQuery;
  const afterId = cursor === undefined ? undefined : decodeCursor(cursor, CURSOR_SCOPE);
  // A cursor carries the last id this endpoint served, so anything else was not minted here.
  if (afterId !== undefined && !isValidObjectId(afterId)) {
    throw new UnprocessableEntityError('Invalid cursor');
  }

  // Same reach as GET /api/v1/agents/{id} (assertAgentAccess 'view'), so every listed id can be fetched.
  const page = await agentRepository.listAccessibleAfterId(req.user.id, { afterId, limit });
  const lastId = page.data.at(-1)?.id;

  return res.json({
    data: page.data.map(agent => toPublicAgent(agent, req.user.id)),
    next_cursor: page.hasMore && lastId ? encodeCursor(CURSOR_SCOPE, String(lastId)) : null,
  });
});

const createRoute = nextRouteForContract(createAgentContract, {
  rateLimit: perUserRateLimit('POST /api/v1/agents'),
}).post(async (req, res) => {
  const body = req.validated;

  // useOwnCredits/currentCredits are never sent, so createAgent's credit debit is never taken.
  let agent;
  try {
    // createAgent names the stored camelCase field in its errors, so check here under the caller's spelling.
    validateToolList(body.allowed_tools, 'allowed_tools');
    validateToolList(body.denied_tools, 'denied_tools');
    ({ agent } = await createAgent(
      {
        name: body.name,
        description: body.description,
        systemPrompt: body.system_prompt,
        preferredModel: body.preferred_model,
        temperature: body.temperature,
        maxTokens: body.max_tokens,
        allowedTools: body.allowed_tools,
        deniedTools: body.denied_tools,
        triggerWords: body.trigger_words,
      },
      req.user.id
    ));
  } catch (error) {
    throw toV1AgentError(error);
  }

  return res.status(201).json(toPublicAgent(agent, req.user.id));
});

export const config = {
  api: { externalResolver: true },
};

export default dispatchByMethod({ GET: listRoute, POST: createRoute });
