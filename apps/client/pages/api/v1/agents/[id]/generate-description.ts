/**
 * POST /api/v1/agents/{id}/generate-description - the public twin of
 * POST /api/agents/[id]/generate-description, over the same generateAgentDescription. The description is
 * returned, not saved. A provider failure is a 502 rather than the SPA route's 500 body.
 */
import { generateAgentDescriptionContract } from '@bike4mind/common';
import { generateAgentDescription } from '@server/agents/authoring/generateAgentDescription';
import { AUTHORING_RATE_LIMIT_BUCKET, findOwnedAgent } from '@server/agents/v1AgentRoute';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { toV1AuthoringError } from '@server/agents/v1AgentErrors';
import { assertAiAccessAllowed } from '@server/auth/assertAiAccessAllowed';
import { assertOutboundActionAllowed } from '@server/auth/assertOutboundActionAllowed';
import { type ContractRequest, nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { withRequestCompletionQuota } from '@server/utils/withRequestCompletionQuota';

const handler = nextRouteForContract(generateAgentDescriptionContract, {
  rateLimit: perUserRateLimit(AUTHORING_RATE_LIMIT_BUCKET),
}).post(
  withRequestCompletionQuota(async (req: ContractRequest<typeof generateAgentDescriptionContract>, res) => {
    await assertOutboundActionAllowed(req.user, req);
    assertAiAccessAllowed(req.user);
    const agent = await findOwnedAgent(req.validatedParams.id, req.user.id);

    try {
      return res.json({ description: await generateAgentDescription(agent, req.logger) });
    } catch (error) {
      req.logger.error('Error generating agent description:', error);
      throw toV1AuthoringError(error);
    }
  })
);

export default handler;
