import { withRequestCompletionQuota } from '@server/utils/withRequestCompletionQuota';
import { Request } from 'express';
import { baseApi } from '@client/server/middlewares/baseApi';
import { AGENTS_WRITE_SCOPES } from '@server/agents/agentScopes';
import { assertAgentLimit } from '@server/agents/createAgent';
import { canCreateAgentInSession, createAgentFromContext } from '@server/agents/createAgentFromContext';
import { sessionRepository } from '@bike4mind/database';
import { IAgent, UnprocessableEntityError, isTerminalCreditRefusal } from '@bike4mind/common';
import { BadRequestError, ForbiddenError, NotFoundError } from '@bike4mind/utils';
import { isValidObjectId } from '@bike4mind/server-utils/utils/objectId';
import { assertAiAccessAllowed } from '@bike4mind/server-utils/auth/assertAiAccessAllowed';
import { assertOutboundActionAllowed } from '@server/auth/assertOutboundActionAllowed';

interface CreateFromContextRequest {
  agentName: string;
  sessionId: string;
}

interface CreateFromContextResponse {
  success: boolean;
  agent?: IAgent;
  message: string;
}

const handler = baseApi({ requiredScopes: AGENTS_WRITE_SCOPES }).post<
  Request<{}, CreateFromContextResponse, CreateFromContextRequest>
>(
  withRequestCompletionQuota(async (req, res) => {
    await assertOutboundActionAllowed(req.user, req);
    assertAiAccessAllowed(req.user);
    const { agentName, sessionId } = req.body;
    const authenticatedUserId = req.user!.id;

    // Validate request
    if (!agentName || !sessionId) {
      throw new BadRequestError('Agent name and session ID are required');
    }

    // A malformed id has always answered 404 here (the error handler remapped the cast); the
    // 400 below is this route's answer for a well-formed id that matches nothing.
    if (!isValidObjectId(sessionId)) throw new NotFoundError('Session not found');

    // Verify user owns the session OR has shared access
    const session = await sessionRepository.findById(sessionId);
    if (!session) {
      throw new BadRequestError('Session not found');
    }

    if (!canCreateAgentInSession(session, authenticatedUserId)) {
      req.logger.warn(
        `User ${authenticatedUserId} denied creating agent in session ${sessionId} - insufficient permissions`
      );
      throw new ForbiddenError('You do not have permission to create agents in this session');
    }

    // Outside the try below, which turns every error into a 500; also ahead of the LLM generation.
    await assertAgentLimit(req.user!);

    try {
      const savedAgent = await createAgentFromContext({
        req,
        user: req.user!,
        logger: req.logger,
        agentName,
        sessionId,
      });

      return res.status(200).json({
        success: true,
        agent: savedAgent,
        message: `Agent "${agentName}" created successfully!`,
      });
    } catch (error) {
      // The credit reservation and model admission keep their own statuses rather than collapsing into the generic 500.
      if (
        error instanceof UnprocessableEntityError ||
        error instanceof ForbiddenError ||
        error instanceof BadRequestError ||
        isTerminalCreditRefusal(error)
      ) {
        throw error;
      }
      req.logger.error(`Error creating agent from context:`, error);

      return res.status(500).json({
        success: false,
        message: error instanceof Error && error.message ? error.message : 'Failed to create agent from context',
      });
    }
  })
);

export default handler;
