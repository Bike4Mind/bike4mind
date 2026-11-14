import { Request } from 'express';
import { baseApi } from '@client/server/middlewares/baseApi';
import { AGENTS_WRITE_SCOPES } from '@server/agents/agentScopes';
import { transferCreditsToAgent } from '@server/agents/transferCreditsToAgent';
import { BadRequestError } from '@bike4mind/utils';

const handler = baseApi({ requiredScopes: AGENTS_WRITE_SCOPES }).post<Request<{}, {}, { amount: number }>>(
  async (req, res) => {
    const { id } = req.query;
    const { amount } = req.body;

    if (!amount || amount <= 0) {
      throw new BadRequestError('Invalid transfer amount. Amount must be greater than 0.');
    }

    const result = await transferCreditsToAgent(id as string, req.user!.id, amount);

    return res.json({
      success: true,
      message: `Successfully transferred ${amount.toLocaleString()} credits to agent "${result.agentName}"`,
      userCredits: result.userCredits,
      agentCredits: result.agentCredits,
    });
  }
);

export default handler;
