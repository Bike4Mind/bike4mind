import { Request } from 'express';
import { baseApi } from '@client/server/middlewares/baseApi';
import { agentRepository, apiKeyRepository, adminSettingsRepository } from '@bike4mind/database';
import { IMessage } from '@bike4mind/common';
import { NotFoundError, ForbiddenError, BadRequestError, getSettingsByNames } from '@bike4mind/utils';
import { getAvailableModels, getLlmByModel } from '@bike4mind/llm-adapters';
import { apiKeyService } from '@bike4mind/services';

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

// Field metadata for better prompting
const FIELD_DESCRIPTIONS: Record<string, { label: string; description: string; style: string }> = {
  personalMission: {
    label: 'Personal Mission',
    description: 'Their burning life purpose - what drives them at their core',
    style:
      'Write in an evocative style that captures their unique drive. Format: "Title: Description" where Title is 2-3 words and Description elaborates on their mission.',
  },
  activeProject: {
    label: 'Active Project',
    description: "What they're currently working on right now - their ongoing endeavor",
    style:
      'Describe a specific, tangible project that reflects their personality. Format: "Project Name: What they are doing and why it matters."',
  },
  secretAmbition: {
    label: 'Secret Ambition',
    description: 'Their hidden dream - something they pursue quietly or aspire to',
    style:
      'Capture something deeply personal and aspirational. Format: "Title: Description" revealing their hidden goal.',
  },
  coreValues: {
    label: 'Core Values',
    description: 'Their unshakeable beliefs that guide all their decisions',
    style:
      'Express a fundamental principle they hold dear. Format: "Value Name: How this value manifests in their behavior."',
  },
  legacyAspiration: {
    label: 'Legacy Aspiration',
    description: 'How they want to be remembered - their lasting impact',
    style: 'Describe their desired lasting impact. Format: "Legacy Title: How they want to be remembered and why."',
  },
  growthChallenge: {
    label: 'Growth Challenge',
    description: 'Current personal struggle they are working through',
    style:
      'Describe an authentic struggle that makes them more relatable. Format: "Challenge Name: How this challenge affects them and what they are learning."',
  },
  majorMotivation: {
    label: 'Major Motivation',
    description: 'Their primary driving force and archetype',
    style:
      'Identify their core motivational archetype. Format: "Archetype: Description of how this motivation manifests."',
  },
  minorMotivation: {
    label: 'Minor Motivation',
    description: 'Their secondary driving instinct',
    style: 'Identify a complementary motivation. Format: "Archetype: How this secondary motivation influences them."',
  },
  quirk: {
    label: 'Quirk',
    description: 'An endearing behavioral trait that makes them unique',
    style: 'Describe a charming idiosyncrasy. Format: "Quirk Name: How this quirk shows up in their behavior."',
  },
  flaw: {
    label: 'Flaw',
    description: 'A character weakness that makes them more human',
    style: 'Describe an authentic weakness. Format: "Flaw Name: How this flaw affects their interactions."',
  },
  emotionalIntelligence: {
    label: 'Emotional Intelligence',
    description: 'How they process and respond to emotions',
    style:
      'Describe their emotional processing style. Format: "EQ Style: How they engage with emotions in conversations."',
  },
  communicationPattern: {
    label: 'Communication Pattern',
    description: 'How they structure their conversations and share ideas',
    style:
      'Describe their communication approach. Format: "Pattern Name: How they express themselves and engage with others."',
  },
  memoryStyle: {
    label: 'Memory Style',
    description: 'How they process and retain information',
    style:
      'Describe their learning and memory approach. Format: "Memory Type: How they process and recall information."',
  },
  culturalFlavor: {
    label: 'Cultural Flavor',
    description: 'Their cultural background and linguistic influences',
    style:
      'Describe their cultural communication style. Format: "Cultural Style: How their background influences their expression."',
  },
  energyLevel: {
    label: 'Energy Level',
    description: 'Their pacing and engagement intensity',
    style:
      'Describe their energy in interactions. Format: "Energy Type: How their energy level manifests in conversations."',
  },
  humorStyle: {
    label: 'Humor Style',
    description: 'Their sense of humor and wit',
    style: 'Describe their approach to humor. Format: "Humor Type: How they use humor in their interactions."',
  },
  backstoryElement: {
    label: 'Backstory Element',
    description: 'A formative experience from their past',
    style:
      'Describe a meaningful background element. Format: "Backstory: A formative experience that shaped who they are."',
  },
  problemSolvingApproach: {
    label: 'Problem Solving Approach',
    description: 'How they tackle challenges and find solutions',
    style: 'Describe their problem-solving methodology. Format: "Approach Name: How they approach and solve problems."',
  },
};

const handler = baseApi().post<Request<{ id: string }, EnhanceFieldResponse, EnhanceFieldRequest>>(async (req, res) => {
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
  if (!agent) {
    throw new NotFoundError('Agent not found');
  }

  // Check ownership
  if (agent.userId !== userId) {
    throw new ForbiddenError("You don't have permission to modify this agent");
  }

  try {
    // Get API keys and available models
    const apiKeyTable = await apiKeyService.getEffectiveLLMApiKeys(userId, {
      db: {
        adminSettings: adminSettingsRepository,
        apiKeys: apiKeyRepository,
      },
      getSettingsByNames,
    });
    const models = await getAvailableModels(apiKeyTable);

    // Use a fast model for field enhancement (Haiku for speed)
    const preferredModelId = 'claude-haiku-4-5-20251001';
    const modelInfo =
      models.find(m => m.id === preferredModelId) || models.find(m => m.id === 'claude-sonnet-4-6') || models[0];

    if (!modelInfo) {
      throw new BadRequestError('No available LLM model found for field enhancement');
    }

    const llm = getLlmByModel(apiKeyTable, { modelInfo, logger: req.logger, endUserId: userId });
    if (!llm) {
      throw new BadRequestError('Failed to initialize LLM backend for field enhancement');
    }

    // Get field metadata
    const fieldMeta = FIELD_DESCRIPTIONS[fieldName] || {
      label: fieldName,
      description: 'A personality trait for this agent',
      style: 'Enhance the given text while maintaining its core meaning.',
    };

    // Build the enhancement prompt
    const systemPrompt = `You are an expert at crafting rich, evocative personality descriptions for AI agents. Your task is to enhance and expand upon user-provided text while preserving the original intent and meaning.

Guidelines:
- Use the user's input as the PRIMARY inspiration - their ideas are the foundation
- Expand and enrich their concept without completely replacing it
- Keep the enhanced version concise (1-3 sentences max)
- Match the style described for this field type
- Make it vivid and memorable
- Preserve any specific names, concepts, or themes the user mentioned

Output ONLY the enhanced text. No explanations, no quotes, no prefixes.`;

    const userPrompt = `Agent Name: ${agentName || agent.name || 'Unnamed Agent'}

Field: ${fieldMeta.label}
Purpose: ${fieldMeta.description}
Style Guide: ${fieldMeta.style}

User's Input:
"${currentValue.trim()}"

Please enhance this personality field, keeping the user's core idea as the foundation while making it more vivid and detailed.`;

    // Create messages for the LLM
    const messages: IMessage[] = [
      {
        role: 'system' as const,
        content: systemPrompt,
      },
      {
        role: 'user' as const,
        content: userPrompt,
      },
    ];

    let enhancedValue = '';

    // Generate the enhanced field
    req.logger.info(`Enhancing ${fieldName} for agent ${agent.name} using model ${modelInfo.id}`);

    await llm.complete(
      modelInfo.id,
      messages,
      {
        temperature: 0.8, // Slightly creative but focused
        maxTokens: 500, // Keep it concise
        stream: false,
      },
      async (texts: (string | null | undefined)[]) => {
        if (texts[0]) {
          enhancedValue += texts[0];
        }
      }
    );

    if (!enhancedValue.trim()) {
      throw new BadRequestError('Failed to enhance field. Please try again.');
    }

    // Clean up the generated text
    const cleanEnhancedValue = enhancedValue.trim();

    req.logger.info(
      `Successfully enhanced ${fieldName} for agent ${agent.name} (${cleanEnhancedValue.length} characters)`
    );

    res.json({
      success: true,
      enhancedValue: cleanEnhancedValue,
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
});

export default handler;
