import { baseApi } from '@server/middlewares/baseApi';
import { getVideoGeneration } from '@server/queueHandlers/videoGeneration';
import { Request } from 'express';
import { z } from 'zod';
import { GenerateVideoRequestBodySchema, GenerateVideoInvokeParams, ApiKeyScope } from '@bike4mind/common';
import { getOrCreateSession } from '@server/managers/sessionManager';
import { resolveBillingOrgId } from '@server/utils/orgAccess';

type GenerateVideoRequestBody = z.infer<typeof GenerateVideoRequestBodySchema>;

type GenerateVideoRequest = Request<unknown, unknown, GenerateVideoRequestBody>;

// Gate API-key callers on `ai:generate` so this billable action is auditable, mirroring
// generate-image.ts. Scope checks apply only to API-key requests; browser/JWT sessions fall
// through untouched (see apiKeyAuth).
const handler = baseApi({ requiredScopes: [ApiKeyScope.AI_GENERATE] }).post(async (req: GenerateVideoRequest, res) => {
  req.logger.updateMetadata({
    userId: req.user?.id,
    userEmail: req.user?.email,
    bodyKeys: Object.keys(req.body || {}).join(', '),
    model: req.body.model,
    seconds: req.body.seconds,
    size: req.body.size,
    sessionId: req.body.sessionId,
    questId: req.body.questId,
    promptPreview: req.body?.prompt?.substring(0, 100) + '...',
  });

  const { sessionId: reqSessionId, sessionName, ...invokeParams } = req.body;

  const { sessionId, asyncPromises, session } = await getOrCreateSession({
    sessionId: reqSessionId,
    sessionName: sessionName,
    projectId: invokeParams.projectId,
    user: req.user,
    ability: req.ability,
    logger: req.logger,
  });

  try {
    req.logger.log(`[DEBUG API] Calling videoGeneration.invoke...`);
    const startTime = performance.now();

    // Resolve the billing org from the client-supplied value, rejecting any org the caller is
    // not a member of. null = personal account, undefined = fall back to the caller's own org.
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

    const endTime = performance.now();

    req.logger.updateMetadata({
      duration: `${endTime - startTime}ms`,
      questStatus: quest?.status,
      questType: quest?.type,
      hasReply: !!quest?.reply,
      hasVideos: !!quest?.videos?.length,
    });

    req.logger.log(`[DEBUG API] videoGeneration.invoke completed in ${endTime - startTime}ms`);

    await Promise.all(asyncPromises);

    const response = {
      quest,
      session,
    };

    return res.json(response);
  } catch (error) {
    req.logger.error(`[DEBUG API] Error in generate-video endpoint:`, {
      error,
      errorMessage: error instanceof Error ? error.message : 'Unknown error',
      userId: req.user?.id,
    });
    throw error;
  }
});

export default handler;
