/**
 * POST /api/v1/agents/{id}/transfer-credits - the public twin of POST /api/agents/[id]/transfer-credits,
 * over the same transferCreditsToAgent. A sharee or stranger gets the 404 an unknown id gets, and a
 * balance below the amount is a 422 tagged insufficient_credits rather than the SPA route's 400.
 */
import { insufficientCreditsError, transferAgentCreditsContract } from '@bike4mind/common';
import { findOwnedAgent } from '@server/agents/v1AgentRoute';
import { InsufficientTransferBalanceError, transferCreditsToAgent } from '@server/agents/transferCreditsToAgent';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { type ContractRequest, nextRouteForContract } from '@server/middlewares/defineNextRoute';

const handler = nextRouteForContract(transferAgentCreditsContract, {
  rateLimit: perUserRateLimit('POST /api/v1/agents/[id]/transfer-credits'),
}).post(async (req: ContractRequest<typeof transferAgentCreditsContract>, res) => {
  const agent = await findOwnedAgent(req.validatedParams.id, req.user.id);
  const { amount } = req.validated;

  try {
    const result = await transferCreditsToAgent(agent.id, req.user.id, amount);
    return res.json({
      transferred: amount,
      user_credits: result.userCredits,
      agent_credits: result.agentCredits,
    });
  } catch (error) {
    if (error instanceof InsufficientTransferBalanceError) throw insufficientCreditsError(error.message);
    throw error;
  }
});

export default handler;
