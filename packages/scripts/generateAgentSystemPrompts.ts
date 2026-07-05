import {
  agentRepository,
  agentOpsSettingsRepository,
  adminSettingsRepository,
  apiKeyRepository,
} from '@bike4mind/database';
import { IAgent, IMessage } from '@bike4mind/common';
import { getSettingsByNames } from '@bike4mind/utils';
import { getAvailableModels, getLlmByModel } from '@bike4mind/llm-adapters';
import { Logger } from '@bike4mind/observability';
import { apiKeyService } from '@bike4mind/services';
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';

dotenv.config();

// Build the PromptCrafter input payload from an agent's metadata.
const createAgentMetadataForPrompt = (agent: IAgent): string => {
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

const generateSystemPrompt = async (
  agent: IAgent,
  metaPrompt: { content: string },
  logger: Logger
): Promise<string> => {
  const agentMetadata = createAgentMetadataForPrompt(agent);

  const userPrompt = `Please generate a comprehensive system prompt for this agent based on their metadata:

${agentMetadata}

Please create a detailed system prompt that captures this agent's personality, communication style, capabilities, and unique characteristics. Make sure to include their agency, purpose, and what makes them a unique being with their own goals and motivations.`;

  const messages: IMessage[] = [
    {
      role: 'system' as const,
      content: metaPrompt.content,
    },
    {
      role: 'user' as const,
      content: userPrompt,
    },
  ];

  // This script targets user-owned agents only; org-scoped and system agents
  // are skipped upstream, so agent.userId must be set.
  if (!agent.userId) {
    throw new Error(`generateSystemPrompt requires a user-owned agent; received agent ${agent.id} with no userId`);
  }
  const apiKeyTable = await apiKeyService.getEffectiveLLMApiKeys(agent.userId, {
    db: {
      adminSettings: adminSettingsRepository,
      apiKeys: apiKeyRepository,
    },
    getSettingsByNames,
  });
  const models = await getAvailableModels(apiKeyTable);

  // Get the configured model from settings, or default to Claude
  const settings = await agentOpsSettingsRepository.getSettings();
  const preferredModelId = settings?.generationLlmModel || 'claude-opus-4-20250514';
  const modelInfo =
    models.find(m => m.id === preferredModelId) ||
    models.find(m => m.id === 'claude-opus-4-20250514') ||
    models.find(m => m.id === 'claude-sonnet-4-6') ||
    models[0];

  if (!modelInfo) {
    throw new Error('No available LLM model found for system prompt generation');
  }

  const llm = getLlmByModel(apiKeyTable, { modelInfo, logger });
  if (!llm) {
    throw new Error('Failed to initialize LLM backend for system prompt generation');
  }

  let generatedSystemPrompt = '';

  logger.info(`Generating system prompt for agent ${agent.name} using model ${modelInfo.id}`);

  await llm.complete(
    modelInfo.id,
    messages,
    {
      temperature: 0.7,
      maxTokens: 4000,
      stream: false,
    },
    async (texts: (string | null | undefined)[]) => {
      if (texts[0]) {
        generatedSystemPrompt += texts[0];
      }
    }
  );

  if (!generatedSystemPrompt.trim()) {
    throw new Error('Failed to generate system prompt. Please try again.');
  }

  return generatedSystemPrompt.trim();
};

async function main() {
  const logger = new Logger();

  try {
    const mongoUri = process.env.MONGODB_URI;
    if (!mongoUri) {
      throw new Error('MONGODB_URI not set in environment variables');
    }

    await mongoose.connect(mongoUri);
    console.log('Connected to MongoDB');

    const settings = await agentOpsSettingsRepository.getSettings();

    if (settings && !settings.isEnabled) {
      console.warn('System prompt generation is currently disabled in settings');
    }

    const metaPrompt = await agentOpsSettingsRepository.getActiveMetaPrompt();
    if (!metaPrompt) {
      throw new Error('No active meta-prompt found. Please configure system prompt generation in the admin settings.');
    }

    const allAgents = await agentRepository.find({});
    const agentsWithoutPrompts = allAgents.filter(agent => !agent.systemPrompt || agent.systemPrompt.trim() === '');

    console.log(`Found ${agentsWithoutPrompts.length} agents without system prompts`);

    if (agentsWithoutPrompts.length === 0) {
      console.log('All agents already have system prompts!');
      return;
    }

    let successCount = 0;
    let errorCount = 0;

    for (const agent of agentsWithoutPrompts) {
      try {
        console.log(`\nProcessing agent: ${agent.name} (${agent.id})`);

        const systemPrompt = await generateSystemPrompt(agent, metaPrompt, logger);

        const updateData = {
          ...agent,
          systemPrompt,
        };

        const updatedAgent = await agentRepository.update(updateData);

        if (updatedAgent) {
          console.log(`✅ Successfully generated system prompt for ${agent.name} (${systemPrompt.length} characters)`);
          successCount++;
        } else {
          console.error(`❌ Failed to save system prompt for ${agent.name}`);
          errorCount++;
        }

        // Add a small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch (error) {
        console.error(`❌ Error processing agent ${agent.name}:`, error);
        errorCount++;
      }
    }

    console.log('\n=== Migration Complete ===');
    console.log(`✅ Success: ${successCount} agents`);
    console.log(`❌ Errors: ${errorCount} agents`);

    // Update usage tracking in settings (if settings exist)
    if (settings && successCount > 0) {
      await agentOpsSettingsRepository.createOrUpdateSettings({
        ...settings,
        totalGenerationsCount: (settings.totalGenerationsCount || 0) + successCount,
        lastGenerationAt: new Date(),
      });
    }
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB');
  }
}

main().catch(console.error);
