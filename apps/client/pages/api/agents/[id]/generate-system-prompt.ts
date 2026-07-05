import { Request } from 'express';
import { baseApi } from '@client/server/middlewares/baseApi';
import {
  agentRepository,
  agentOpsSettingsRepository,
  apiKeyRepository,
  adminSettingsRepository,
} from '@bike4mind/database';
import { IAgent, IMessage } from '@bike4mind/common';
import { NotFoundError, ForbiddenError, BadRequestError, getSettingsByNames } from '@bike4mind/utils';
import { getAvailableModels, getLlmByModel } from '@bike4mind/llm-adapters';
import { apiKeyService } from '@bike4mind/services';

interface GenerateSystemPromptResponse {
  success: boolean;
  systemPrompt: string;
  message: string;
}

// Helper function to create the input data for the PromptCrafter
const createAgentMetadataForPrompt = (agent: IAgent): string => {
  // Use the same structure as the import/export JSON data
  const agentData = {
    name: agent.name || '',
    description: agent.description || '',
    triggerWords: agent.triggerWords || [],
    isPublic: agent.isPublic || false,
    useOwnCredits: agent.useOwnCredits || false,
    personality: {
      majorMotivation: agent.personality?.majorMotivation || '',
      minorMotivation: agent.personality?.minorMotivation || '',
      flaw: agent.personality?.flaw || '',
      quirk: agent.personality?.quirk || '',
      description: agent.personality?.description || '',
      emotionalIntelligence: agent.personality?.emotionalIntelligence || '',
      communicationPattern: agent.personality?.communicationPattern || '',
      memoryStyle: agent.personality?.memoryStyle || '',
      culturalFlavor: agent.personality?.culturalFlavor || '',
      energyLevel: agent.personality?.energyLevel || '',
      humorStyle: agent.personality?.humorStyle || '',
      backstoryElement: agent.personality?.backstoryElement || '',
      problemSolvingApproach: agent.personality?.problemSolvingApproach || '',
      personalMission: agent.personality?.personalMission || '',
      activeProject: agent.personality?.activeProject || '',
      secretAmbition: agent.personality?.secretAmbition || '',
      coreValues: agent.personality?.coreValues || '',
      legacyAspiration: agent.personality?.legacyAspiration || '',
      growthChallenge: agent.personality?.growthChallenge || '',
      personalityComplexity: agent.personality?.personalityComplexity || 'simple',
      generationTimestamp: agent.personality?.generationTimestamp || '',
      uniqueId: agent.personality?.uniqueId || '',
    },
    visual: {
      style: agent.visual?.style || '',
      generationPrompt: agent.visual?.generationPrompt || '',
    },
    identity: {
      gender: agent.identity?.gender || 'prefer-not-to-say',
      pronouns: {
        subject: agent.identity?.pronouns?.subject || '',
        object: agent.identity?.pronouns?.object || '',
        possessive: agent.identity?.pronouns?.possessive || '',
        possessiveAdjective: agent.identity?.pronouns?.possessiveAdjective || '',
        reflexive: agent.identity?.pronouns?.reflexive || '',
      },
      customPronouns: agent.identity?.customPronouns || '',
    },
    capabilities: (() => {
      try {
        if (agent.capabilities && agent.capabilities.length > 0) {
          const parsed = JSON.parse(agent.capabilities[0]);
          return {
            responseStyle: parsed.responseStyle || 'friendly',
            specialBehaviors: parsed.specialBehaviors || [],
          };
        }
      } catch (error) {
        console.error('Error parsing agent capabilities:', error);
      }
      return {
        responseStyle: 'friendly',
        specialBehaviors: [],
      };
    })(),
  };

  return JSON.stringify(agentData, null, 2);
};

// Helper function to check rate limiting
const checkRateLimit = async (agent: IAgent, rateLimitSeconds: number): Promise<void> => {
  if (rateLimitSeconds <= 0) return; // No rate limiting

  const lastGeneration = (agent as { systemPrompt?: string; updatedAt: Date }).systemPrompt
    ? new Date(agent.updatedAt)
    : null;
  if (lastGeneration) {
    const timeSinceLastGeneration = Date.now() - lastGeneration.getTime();
    const timeRemainingMs = rateLimitSeconds * 1000 - timeSinceLastGeneration;

    if (timeRemainingMs > 0) {
      const timeRemainingSec = Math.ceil(timeRemainingMs / 1000);
      throw new BadRequestError(
        `Rate limit exceeded. Please wait ${timeRemainingSec} seconds before generating another system prompt.`
      );
    }
  }
};

const handler = baseApi().post<Request<{ id: string }, GenerateSystemPromptResponse, {}>>(async (req, res) => {
  const { id } = req.query;
  const userId = req.user!.id;

  // Validate the id parameter
  if (!id || typeof id !== 'string') {
    throw new BadRequestError('Invalid agent ID');
  }

  // Find the agent
  const agent = await agentRepository.findById(id);
  if (!agent) {
    throw new NotFoundError('Agent not found');
  }

  // Check ownership
  if (agent.userId !== userId) {
    throw new ForbiddenError("You don't have permission to modify this agent");
  }

  try {
    // Get agent operations settings
    const settings = await agentOpsSettingsRepository.getSettings();

    // Check if system prompt generation is enabled
    if (settings && !settings.isEnabled) {
      throw new BadRequestError('System prompt generation is currently disabled');
    }

    // Check rate limiting
    const rateLimitSeconds = settings?.rateLimitSeconds || 60;
    await checkRateLimit(agent, rateLimitSeconds);

    // Get the active meta-prompt
    const metaPrompt = await agentOpsSettingsRepository.getActiveMetaPrompt();

    if (!metaPrompt) {
      throw new BadRequestError(
        'No active meta-prompt found. Please contact an administrator to configure system prompt generation.'
      );
    }

    // Prepare the agent metadata for the PromptCrafter
    const agentMetadata = createAgentMetadataForPrompt(agent);

    // Build the user prompt with agent metadata
    const userPrompt = `Please generate a comprehensive system prompt for this agent based on their metadata:

${agentMetadata}

Please create a detailed system prompt that captures this agent's personality, communication style, capabilities, and unique characteristics. Make sure to include their agency, purpose, and what makes them a unique being with their own goals and motivations.`;

    // Create messages for the LLM
    const messages: IMessage[] = [
      {
        role: 'system' as const,
        content: metaPrompt.content,
      },
      {
        role: 'user' as const,
        content: userPrompt as string,
      },
    ];

    // Get API keys and available models
    const apiKeyTable = await apiKeyService.getEffectiveLLMApiKeys(userId, {
      db: {
        adminSettings: adminSettingsRepository,
        apiKeys: apiKeyRepository,
      },
      getSettingsByNames,
    });
    const models = await getAvailableModels(apiKeyTable);

    // Get the configured model from settings, or default to Claude 4 Opus
    const preferredModelId = settings?.generationLlmModel || 'claude-opus-4-20250514';
    const modelInfo =
      models.find(m => m.id === preferredModelId) ||
      models.find(m => m.id === 'claude-opus-4-20250514') ||
      models.find(m => m.id === 'claude-sonnet-4-6') ||
      models[0];

    if (!modelInfo) {
      throw new BadRequestError('No available LLM model found for system prompt generation');
    }

    const llm = getLlmByModel(apiKeyTable, { modelInfo, logger: req.logger, endUserId: userId });
    if (!llm) {
      throw new BadRequestError('Failed to initialize LLM backend for system prompt generation');
    }

    let generatedSystemPrompt = '';

    // Generate the system prompt
    req.logger.info(`Generating system prompt for agent ${agent.name} using model ${modelInfo.id}`);

    await llm.complete(
      modelInfo.id,
      messages,
      {
        temperature: 0.7, // Good balance for creative but consistent prompts
        maxTokens: 4000, // Allow for comprehensive system prompts
        stream: false, // No streaming for this use case
      },
      async (texts: (string | null | undefined)[]) => {
        if (texts[0]) {
          generatedSystemPrompt += texts[0];
        }
      }
    );

    if (!generatedSystemPrompt.trim()) {
      throw new BadRequestError('Failed to generate system prompt. Please try again.');
    }

    // Clean up the generated system prompt
    const cleanSystemPrompt = generatedSystemPrompt.trim();

    // Update the agent with the new system prompt
    const updateData = {
      ...agent,
      systemPrompt: cleanSystemPrompt,
    };

    const updatedAgent = await agentRepository.update(updateData);

    if (!updatedAgent) {
      throw new BadRequestError('Failed to save generated system prompt');
    }

    // Update usage tracking in settings (if settings exist)
    if (settings) {
      await agentOpsSettingsRepository.createOrUpdateSettings({
        ...settings,
        totalGenerationsCount: (settings.totalGenerationsCount || 0) + 1,
        lastGenerationAt: new Date(),
      });
    }

    req.logger.info(
      `Successfully generated system prompt for agent ${agent.name} (${cleanSystemPrompt.length} characters)`
    );

    res.json({
      success: true,
      systemPrompt: cleanSystemPrompt,
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
});

export default handler;
