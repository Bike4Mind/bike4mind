/**
 * POST /api/v1/agents/{id}/generate-system-prompt - the public twin of
 * POST /api/agents/[id]/generate-system-prompt, over the same generateAgentSystemPrompt, which also
 * saves the prompt and applies the admin-set per-agent generation interval. The SPA route reports
 * every failure as a 400 body; here a typed error keeps its status and a provider failure is a 502.
 */
import { generateAgentSystemPromptContract } from '@bike4mind/common';
import { generateAgentSystemPrompt } from '@server/agents/authoring/generateAgentSystemPrompt';
import { AUTHORING_RATE_LIMIT_BUCKET, findOwnedAgent } from '@server/agents/v1AgentRoute';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { toV1AuthoringError } from '@server/agents/v1AgentErrors';
import { logSystemPromptGenerationFailure } from '@server/agents/systemPromptRateLimit';
import { assertAiAccessAllowed } from '@server/auth/assertAiAccessAllowed';
import { assertOutboundActionAllowed } from '@server/auth/assertOutboundActionAllowed';
import { type ContractRequest, nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { withRequestCompletionQuota } from '@server/utils/withRequestCompletionQuota';

const handler = nextRouteForContract(generateAgentSystemPromptContract, {
  rateLimit: perUserRateLimit(AUTHORING_RATE_LIMIT_BUCKET),
}).post(
  withRequestCompletionQuota(async (req: ContractRequest<typeof generateAgentSystemPromptContract>, res) => {
    await assertOutboundActionAllowed(req.user, req);
    assertAiAccessAllowed(req.user);
    const agent = await findOwnedAgent(req.validatedParams.id, req.user.id);

    try {
      return res.json({ system_prompt: await generateAgentSystemPrompt(agent, req.user.id, req.logger) });
    } catch (error) {
      logSystemPromptGenerationFailure(req.logger, 'Error generating agent system prompt:', error);
      throw toV1AuthoringError(error);
    }
  })
);

export default handler;
