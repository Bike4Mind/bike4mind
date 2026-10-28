/**
 * POST /api/v1/agents/{id}/generate-avatar - the public twin of POST /api/agents/[id]/generate-avatar.
 *
 * Both run generateAgentAvatar. Unlike the SPA route, a failure keeps its real status: a typed error
 * (unknown image model, storage quota) passes through and a provider failure is a 502 with a safe
 * message, where the SPA route flattens them to a 500 body. A sharee gets the same 404 as a stranger.
 */
import { generateAgentAvatarContract } from '@bike4mind/common';
import { checkStorageLimit } from '@bike4mind/utils';
import { generateAgentAvatar } from '@server/agents/authoring/generateAgentAvatar';
import { AUTHORING_RATE_LIMIT_BUCKET, findOwnedAgent, perUserRateLimit } from '@server/agents/v1AgentRoute';
import { toV1AuthoringError } from '@server/agents/v1AgentErrors';
import { assertAiAccessAllowed } from '@server/auth/assertAiAccessAllowed';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';

const handler = nextRouteForContract(generateAgentAvatarContract, {
  rateLimit: perUserRateLimit(AUTHORING_RATE_LIMIT_BUCKET),
}).post(async (req, res) => {
  assertAiAccessAllowed(req.user);
  const agent = await findOwnedAgent(req.validatedParams.id, req.user.id);
  // Refuses an over-quota user before paying for generation; the exact byte check runs inside.
  await checkStorageLimit(req.user, 0);

  try {
    const { portraitUrl, generationPrompt } = await generateAgentAvatar(
      agent,
      req.user,
      req.validated.image_model,
      req.logger
    );
    return res.json({ portrait_url: portraitUrl, generation_prompt: generationPrompt });
  } catch (error) {
    req.logger.error('Error generating agent avatar:', error);
    throw toV1AuthoringError(error);
  }
});

export default handler;
