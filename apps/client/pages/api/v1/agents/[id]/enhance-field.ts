/**
 * POST /api/v1/agents/{id}/enhance-field - the public twin of POST /api/agents/[id]/enhance-field, over
 * the same enhanceAgentField. The enhanced text is returned, not saved. A provider failure is a 502
 * rather than the SPA route's 500 body.
 */
import { enhanceAgentFieldContract } from '@bike4mind/common';
import { enhanceAgentField } from '@server/agents/authoring/enhanceAgentField';
import { AUTHORING_RATE_LIMIT_BUCKET, findOwnedAgent } from '@server/agents/v1AgentRoute';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { toV1AuthoringError } from '@server/agents/v1AgentErrors';
import { assertAiAccessAllowed } from '@server/auth/assertAiAccessAllowed';
import { type ContractRequest, nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { withRequestCompletionQuota } from '@server/utils/withRequestCompletionQuota';

const handler = nextRouteForContract(enhanceAgentFieldContract, {
  rateLimit: perUserRateLimit(AUTHORING_RATE_LIMIT_BUCKET),
}).post(
  withRequestCompletionQuota(async (req: ContractRequest<typeof enhanceAgentFieldContract>, res) => {
    assertAiAccessAllowed(req.user);
    const agent = await findOwnedAgent(req.validatedParams.id, req.user.id);
    const { field_name, current_value, agent_name } = req.validated;

    try {
      const enhanced = await enhanceAgentField(
        agent,
        req.user.id,
        { fieldName: field_name, currentValue: current_value, agentName: agent_name },
        req.logger
      );
      return res.json({ enhanced_value: enhanced });
    } catch (error) {
      req.logger.error('Error enhancing agent field:', error);
      throw toV1AuthoringError(error);
    }
  })
);

export default handler;
