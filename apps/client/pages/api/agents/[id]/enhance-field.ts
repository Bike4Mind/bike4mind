import { withRequestCompletionQuota } from '@server/utils/withRequestCompletionQuota';
import { Request } from 'express';
import { baseApi } from '@client/server/middlewares/baseApi';
import { AGENTS_WRITE_SCOPES } from '@server/agents/agentScopes';
import { assertAgentAccess } from '@server/agents/assertAgentAccess';
import { assertAiAccessAllowed } from '@server/auth/assertAiAccessAllowed';
import { agentRepository } from '@bike4mind/database';
import { NotFoundError, ForbiddenError, BadRequestError } from '@bike4mind/utils';
import { enhanceAgentField } from '@server/agents/authoring/enhanceAgentField';

interface EnhanceFieldRequest {
  fieldName: string;
  currentValue: string;
  agentName?: string;
}

interface EnhanceFieldResponse {
  success: boolean;
  enhancedValue: string;
  message: string;
}

const handler = baseApi({ requiredScopes: AGENTS_WRITE_SCOPES }).post<
  Request<{ id: string }, EnhanceFieldResponse, EnhanceFieldRequest>
>(
  withRequestCompletionQuota(async (req, res) => {
    assertAiAccessAllowed(req.user);
    const { id } = req.query;
    const userId = req.user!.id;
    const { fieldName, currentValue, agentName } = req.body;

    // Validate the id parameter
    if (!id || typeof id !== 'string') {
      throw new BadRequestError('Invalid agent ID');
    }

    // Validate required fields
    if (!fieldName || typeof fieldName !== 'string') {
      throw new BadRequestError('Field name is required');
    }

    if (!currentValue || typeof currentValue !== 'string' || currentValue.trim().length === 0) {
      throw new BadRequestError('Current value is required for enhancement');
    }

    // Find the agent
    const agent = await agentRepository.findById(id);
    assertAgentAccess(agent, userId, 'own');

    try {
      const enhancedValue = await enhanceAgentField(agent, userId, { fieldName, currentValue, agentName }, req.logger);

      res.json({
        success: true,
        enhancedValue,
        message: 'Field enhanced successfully',
      });
    } catch (error) {
      req.logger.error('Error enhancing field:', error);

      // Re-throw known error types to let baseApi handle them with correct status codes
      if (error instanceof BadRequestError || error instanceof NotFoundError || error instanceof ForbiddenError) {
        throw error;
      }

      // For unknown errors, provide user-friendly message
      let errorMessage = 'Failed to enhance field. Please try again.';
      if (error instanceof Error) {
        if (error.message.includes('API key') || error.message.includes('model')) {
          errorMessage = 'AI service temporarily unavailable. Please try again later.';
        } else if (error.message.includes('credits')) {
          errorMessage = 'Insufficient credits to enhance field.';
        }
      }

      // Return 500 for server errors, not 400
      res.status(500).json({
        success: false,
        enhancedValue: '',
        message: errorMessage,
      });
    }
  })
);

export default handler;
