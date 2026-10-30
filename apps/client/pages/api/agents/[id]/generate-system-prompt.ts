import { withRequestCompletionQuota } from '@server/utils/withRequestCompletionQuota';
import { Request } from 'express';
import { baseApi } from '@client/server/middlewares/baseApi';
import { AGENTS_WRITE_SCOPES } from '@server/agents/agentScopes';
import { assertAgentAccess } from '@server/agents/assertAgentAccess';
import { assertAiAccessAllowed } from '@server/auth/assertAiAccessAllowed';
import { agentRepository } from '@bike4mind/database';
import { ForbiddenError, BadRequestError } from '@bike4mind/utils';
import { generateAgentSystemPrompt } from '@server/agents/authoring/generateAgentSystemPrompt';

interface GenerateSystemPromptResponse {
  success: boolean;
  systemPrompt: string;
  message: string;
}

const handler = baseApi({ requiredScopes: AGENTS_WRITE_SCOPES }).post<
  Request<{ id: string }, GenerateSystemPromptResponse, {}>
>(
  withRequestCompletionQuota(async (req, res) => {
    assertAiAccessAllowed(req.user);
    const { id } = req.query;
    const userId = req.user!.id;

    // Validate the id parameter
    if (!id || typeof id !== 'string') {
      throw new BadRequestError('Invalid agent ID');
    }

    // Find the agent
    const agent = await agentRepository.findById(id);
    assertAgentAccess(agent, userId, 'own');

    try {
      const systemPrompt = await generateAgentSystemPrompt(agent, userId, req.logger);

      res.json({
        success: true,
        systemPrompt,
        message: 'System prompt generated successfully',
      });
    } catch (error) {
      req.logger.error('Error generating system prompt:', error);

      // Provide user-friendly error messages
      let errorMessage = 'Failed to generate system prompt. Please try again.';
      if (error instanceof BadRequestError || error instanceof ForbiddenError) {
        errorMessage = error.message;
      } else if (error instanceof Error) {
        if (error.message.includes('API key') || error.message.includes('model')) {
          errorMessage = 'AI service temporarily unavailable. Please try again later.';
        } else if (error.message.includes('credits')) {
          errorMessage = 'Insufficient credits to generate system prompt.';
        }
      }

      res.status(400).json({
        success: false,
        systemPrompt: '',
        message: errorMessage,
      });
    }
  })
);

export default handler;
