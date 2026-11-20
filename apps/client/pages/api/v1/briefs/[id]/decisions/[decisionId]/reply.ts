/**
 * POST /api/v1/briefs/{id}/decisions/{decisionId}/reply - answer an agent's question from a brief. The reply
 * starts an agent run in the question's notebook, exactly as if the user had typed it there. JWT only;
 * another user's brief, a missing decision and an approval decision are all `404`.
 */
import {
  BRIEF_QUESTION_CLOSED_ERROR_CODE,
  BILLING_ORGANIZATION_MISMATCH_ERROR_CODE,
  BadGatewayError,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ORG_TOOL_NOT_ALLOWED_ERROR_CODE,
  replyToBriefDecisionContract,
} from '@bike4mind/common';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import {
  adminSettingsRepository,
  agentExecutionRepository,
  assistantBriefRepository,
  questRepository,
} from '@bike4mind/database';
import { assertAiAccessAllowed } from '@bike4mind/server-utils/auth/assertAiAccessAllowed';
import { HEADLESS_CONNECTION_ID } from '@bike4mind/server-utils/utils/headlessConnection';
import { resolveDefaultChatModel } from '@bike4mind/server-utils/utils/chatCompletionDefaults';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { resolveCallerDefaultModel } from '@server/utils/callerModelList';
import { startAgentExecution } from '@server/utils/startAgentExecution';
import { questionStateFor } from '@server/briefs/serializeBrief';

const closed = () =>
  new ConflictError('This question was already answered or the conversation moved on.', {
    errorCode: BRIEF_QUESTION_CLOSED_ERROR_CODE,
  });

const route = nextRouteForContract(replyToBriefDecisionContract, {
  rateLimit: perUserRateLimit('POST /api/v1/briefs/[id]/decisions/[decisionId]/reply'),
}).post(async (req, res) => {
  assertAiAccessAllowed(req.user);
  const { id: briefId, decisionId } = req.validatedParams;
  const { text, choiceIndex } = req.validated;
  const userId = req.user.id;

  const brief = await assistantBriefRepository.findByIdForUser(briefId, userId);
  const decision = brief?.decisions.find(d => d.id === decisionId);
  const question = decision?.question;
  if (!decision || !question) throw new NotFoundError('Question not found');
  if (choiceIndex !== undefined && choiceIndex >= question.options.length) {
    throw new BadRequestError('choiceIndex is not one of the question options.');
  }

  const [live] = await questRepository.findQuestionStates([question.questId]);
  if (questionStateFor(decision.repliedAt, live) !== 'open') throw closed();

  // Continue on the model the agent asked with, else the same default ladder as POST /api/v1/agent-executions.
  let model = await agentExecutionRepository.findLatestModelBySessionId(question.sessionId, userId);
  if (!model) {
    const settings = await getSettingsMap({ adminSettings: adminSettingsRepository });
    const resolved = await resolveDefaultChatModel({
      configuredModel: getSettingsValue('DefaultAPIModel', settings),
      userId,
      logger: req.logger,
    });
    model = resolved.model;
  }
  model = await resolveCallerDefaultModel(model, req.user, req.logger, { organizationId: null });

  const claimedAt = new Date();
  if (!(await assistantBriefRepository.claimDecisionReply(briefId, userId, decisionId, claimedAt))) throw closed();

  const release = () => assistantBriefRepository.releaseDecisionReply(briefId, userId, decisionId, claimedAt);
  let result: Awaited<ReturnType<typeof startAgentExecution>>;
  try {
    result = await startAgentExecution(
      {
        userId,
        sessionId: question.sessionId,
        questId: question.sessionId,
        query: text,
        model,
        connectionId: HEADLESS_CONNECTION_ID,
        apiKeyInfo: undefined,
      },
      req.logger
    );
  } catch (error) {
    await release();
    throw error;
  }

  if (!result.ok) {
    // An unconfirmed dispatch may still start the run, so its claim stays: releasing it could send the reply twice.
    if (!result.dispatchUnconfirmed) await release();
    switch (result.reason) {
      case 'session_not_found':
      case 'organization_not_found':
        throw new NotFoundError('Question not found');
      case 'billing_organization_mismatch':
        throw new ForbiddenError(result.message, { errorCode: BILLING_ORGANIZATION_MISMATCH_ERROR_CODE });
      case 'org_tool_not_allowed':
        throw new ForbiddenError(result.message, { errorCode: ORG_TOOL_NOT_ALLOWED_ERROR_CODE });
      case 'billing_key_stale':
        throw new BadRequestError(result.message);
      case 'confidence_overrides_forbidden':
        throw new ForbiddenError(result.message);
      case 'concurrent_limit':
        throw new ConflictError(result.message);
      case 'dispatch_failed':
        throw new BadGatewayError(result.message);
    }
  }

  if (choiceIndex !== undefined) {
    // The run already started, so a failed chip mark must not turn the 202 into a 500.
    await questRepository.selectSuggestedChoice(question.questId, choiceIndex).catch(error => {
      req.logger.warn('[briefs] Reply sent but marking the chosen option failed', {
        questId: question.questId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  return res.status(202).json({ executionId: result.executionId, sessionId: question.sessionId });
});

export const config = {
  api: { externalResolver: true },
};

export default route;
