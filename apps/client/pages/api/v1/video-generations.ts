/**
 * POST /api/v1/video-generations - queue a Sora video generation; the caller polls the
 * returned quest. Also served at the legacy `/api/ai/generate-video`
 * (pages/api/ai/generate-video.ts re-exports this).
 *
 * Auth mode, the `ai:generate` scope and body validation all come from `generateVideoContract`.
 * `callbackUrl` replaces the poll with a push (server/generationCallback).
 */

import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { getVideoGeneration } from '@server/queueHandlers/videoGeneration';
import { generateVideoContract, GenerateVideoInvokeParams, redactSessionForClient } from '@bike4mind/common';
import { getOrCreateSession } from '@server/managers/sessionManager';
import { resolveBillingOrgId } from '@server/utils/orgAccess';
import { armGenerationCallback, resolveGenerationCallback } from '@server/generationCallback/armGenerationCallback';

const handler = nextRouteForContract(generateVideoContract).post(async (req, res) => {
  const { sessionId: reqSessionId, sessionName, callbackUrl, ...invokeParams } = req.validated;
  const callback = await resolveGenerationCallback(req, callbackUrl);

  req.logger.updateMetadata({
    userId: req.user?.id,
    userEmail: req.user?.email,
    model: invokeParams.model,
    seconds: invokeParams.seconds,
    size: invokeParams.size,
    sessionId: reqSessionId,
    questId: invokeParams.questId,
    promptPreview: invokeParams.prompt?.substring(0, 100) + '...',
  });

  const { sessionId, asyncPromises, session } = await getOrCreateSession({
    sessionId: reqSessionId,
    sessionName,
    projectId: invokeParams.projectId,
    user: req.user,
    ability: req.ability,
    logger: req.logger,
  });

  // null = personal account, undefined = the caller's own org; any org the caller isn't a member of is rejected.
  const effectiveOrgId = await resolveBillingOrgId(req, invokeParams.organizationId);

  const invokeBody: GenerateVideoInvokeParams = {
    ...invokeParams,
    sessionId,
    organizationId: effectiveOrgId,
  };

  const quest = await getVideoGeneration().invoke({
    userId: req.user.id,
    body: invokeBody,
  });

  await armGenerationCallback(quest.id, callback, req.logger);

  await Promise.all(asyncPromises);

  return res.json({ quest, session: redactSessionForClient(session) });
});

export default handler;
