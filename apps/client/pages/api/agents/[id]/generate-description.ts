import { withRequestCompletionQuota } from '@server/utils/withRequestCompletionQuota';
import { Request } from 'express';
import { baseApi } from '@client/server/middlewares/baseApi';
import { AGENTS_WRITE_SCOPES } from '@server/agents/agentScopes';
import { assertAgentAccess } from '@server/agents/assertAgentAccess';
import { assertAiAccessAllowed } from '@server/auth/assertAiAccessAllowed';
import { assertOutboundActionAllowed } from '@server/auth/assertOutboundActionAllowed';
import { agentRepository } from '@bike4mind/database';
import { generateAgentDescription } from '@server/agents/authoring/generateAgentDescription';

interface AgentDescriptionResponse {
  description: string;
}

const handler = baseApi({ requiredScopes: AGENTS_WRITE_SCOPES }).post<
  Request<{ id: string }, AgentDescriptionResponse, {}>
>(
  withRequestCompletionQuota(async (req, res) => {
    await assertOutboundActionAllowed(req.user, req);
    assertAiAccessAllowed(req.user);
    const { id } = req.query;
    const userId = req.user!.id;

    // Validate the id parameter
    if (!id || typeof id !== 'string') {
      throw new Error('Invalid agent ID');
    }

    // Find the agent
    const agent = await agentRepository.findById(id);
    assertAgentAccess(agent, userId, 'own');

    try {
      const description = await generateAgentDescription(agent, req.logger);

      res.json({ description });
    } catch (error) {
      req.logger.error('Error generating agent description:', error);

      // Provide user-friendly error messages
      let errorMessage = 'Failed to generate description. Please try again.';
      if (error instanceof Error) {
        if (error.message.includes('API key') || error.message.includes('model')) {
          errorMessage = 'AI service temporarily unavailable. Please try again later.';
        } else if (error.message.includes('credits')) {
          errorMessage = 'Insufficient credits to generate description.';
        }
      }

      res.status(500).json({ error: errorMessage });
    }
  })
);

export default handler;
