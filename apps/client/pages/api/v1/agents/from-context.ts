/**
 * POST /api/v1/agents/from-context - the public twin of POST /api/agents/create-from-context, over the
 * same createAgentFromContext. A notebook the caller cannot create agents in is the 404 an unknown id
 * gets, and a model failure is a 502 rather than the SPA route's 500 body.
 */
import { createAgentFromContextContract, isTerminalCreditRefusal } from '@bike4mind/common';
import { sessionRepository } from '@bike4mind/database';
import { NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { isValidObjectId } from '@bike4mind/server-utils/utils/objectId';
import { assertAiAccessAllowed } from '@bike4mind/server-utils/auth/assertAiAccessAllowed';
import { assertAgentLimit } from '@server/agents/createAgent';
import { canCreateAgentInSession, createAgentFromContext } from '@server/agents/createAgentFromContext';
import { toPublicAgent } from '@server/agents/toPublicAgent';
import { toV1AuthoringError } from '@server/agents/v1AgentErrors';
import { assertOutboundActionAllowed } from '@server/auth/assertOutboundActionAllowed';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { type ContractRequest, nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { withRequestCompletionQuota } from '@server/utils/withRequestCompletionQuota';

const handler = nextRouteForContract(createAgentFromContextContract, {
  rateLimit: perUserRateLimit('POST /api/v1/agents/from-context'),
}).post(
  withRequestCompletionQuota(async (req: ContractRequest<typeof createAgentFromContextContract>, res) => {
    await assertOutboundActionAllowed(req.user, req);
    assertAiAccessAllowed(req.user);
    const { agent_name: agentName, session_id: sessionId } = req.validated;

    // A malformed id, a missing notebook and one the caller cannot create agents in are one answer.
    const session = isValidObjectId(sessionId) ? await sessionRepository.findById(sessionId) : null;
    if (!session || !canCreateAgentInSession(session, req.user.id)) throw new NotFoundError('Session not found');

    // Ahead of the model call, so a caller at the cap pays for nothing.
    await assertAgentLimit(req.user);

    try {
      const agent = await createAgentFromContext({
        req,
        user: req.user,
        logger: req.logger,
        agentName,
        sessionId,
      });
      return res.status(201).json(toPublicAgent(agent, req.user.id));
    } catch (error) {
      if (!isTerminalCreditRefusal(error)) req.logger.error('Error creating agent from context:', error);
      throw toV1AuthoringError(error);
    }
  })
);

export default handler;
