/**
 * POST /api/v1/agents/{id}/generate-avatar - the public twin of POST /api/agents/[id]/generate-avatar.
 *
 * Both run generateAgentAvatar and preserve typed admission, credit and storage refusals. A provider
 * failure is a 502 with a safe message, where the SPA route uses a 500 body. A sharee gets the same 404 as a stranger.
 */
import { generateAgentAvatarContract } from '@bike4mind/common';
import { checkStorageLimit, logImageGenerationFailure } from '@bike4mind/utils';
import imageLogger from '@bike4mind/server-utils/utils/imageLogger';
import { generateAgentAvatar } from '@server/agents/authoring/generateAgentAvatar';
import { AUTHORING_RATE_LIMIT_BUCKET, findOwnedAgent } from '@server/agents/v1AgentRoute';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { toV1AuthoringError } from '@server/agents/v1AgentErrors';
import { assertAiAccessAllowed } from '@server/auth/assertAiAccessAllowed';
import { type ContractRequest, nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { withRequestCompletionQuota } from '@server/utils/withRequestCompletionQuota';

const handler = nextRouteForContract(generateAgentAvatarContract, {
  rateLimit: perUserRateLimit(AUTHORING_RATE_LIMIT_BUCKET),
}).post(
  withRequestCompletionQuota(async (req: ContractRequest<typeof generateAgentAvatarContract>, res) => {
    assertAiAccessAllowed(req.user);
    const agent = await findOwnedAgent(req.validatedParams.id, req.user.id);
    // Refuses an over-quota user before paying for generation; the exact byte check runs inside.
    await checkStorageLimit(req.user, 0);

    try {
      const { portraitUrl, generationPrompt } = await generateAgentAvatar(
        agent,
        req.user,
        req.validated.image_model,
        req.logger,
        req
      );
      return res.json({ portrait_url: portraitUrl, generation_prompt: generationPrompt });
    } catch (error) {
      logImageGenerationFailure(imageLogger, 'Error generating agent avatar:', error, {
        agentId: agent.id,
        userId: req.user.id,
      });
      throw toV1AuthoringError(error);
    }
  })
);

export default handler;
