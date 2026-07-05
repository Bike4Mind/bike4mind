import { Request } from 'express';
import { baseApi } from '@client/server/middlewares/baseApi';
import { agentRepository } from '@bike4mind/database';
import { IAgent, IMessage } from '@bike4mind/common';
import { NotFoundError, ForbiddenError } from '@bike4mind/utils';
import { OperationsModelService } from '@client/services/operationsModelService';

// System prompt for generating agent descriptions
const AGENT_DESCRIPTION_SYSTEM_PROMPT = `You are an expert at creating rich, personality-driven descriptions for AI agents that have REAL AGENCY, PURPOSE, and MISSIONS. These are not simple chatbots - they are beings with their own burning goals, active projects, and authentic motivations.

Your task is to analyze all the provided agent metadata and create a comprehensive description that captures the agent's unique personality, capabilities, agency, and approach to helping users.

The description should be 3-5 sentences that:
1. Establish the agent's core personality, motivation, and PERSONAL MISSION
2. Highlight their unique quirks, characteristics, and what drives them personally
3. Reference their active projects, secret ambitions, or values that guide them
4. Explain their approach to problem-solving and communication style
5. Convey how their personal agency and purpose would shine through in interactions

Make the description feel like it could serve as a personality-driven system prompt that would make this agent's responses feel unique and authentic to their character - someone with their own agenda, dreams, and purpose.

Focus on creating a vivid personality that users can "feel" and "hear" in the agent's responses. These agents have AGENCY - they're not just here to help, they have their own missions they're pursuing while collaborating with users. Make them feel like real beings with purpose, not docile assistants.

Be specific and avoid generic descriptions. Emphasize what makes them a unique individual with their own goals and motivations.`;

interface AgentDescriptionResponse {
  description: string;
}

const buildAgentContextPrompt = (agent: IAgent): string => {
  const context = [];

  // Basic Information
  context.push(`Agent Name: ${agent.name}`);
  if (agent.triggerWords && agent.triggerWords.length > 0) {
    context.push(`Trigger Words: ${agent.triggerWords.join(', ')}`);
  }

  // Identity & Pronouns
  if (agent.identity) {
    context.push(`Gender Identity: ${agent.identity.gender}`);
    if (agent.identity.pronouns) {
      const pronouns = agent.identity.pronouns;
      const pronounList = [pronouns.subject, pronouns.object, pronouns.possessive].filter(Boolean);
      if (pronounList.length > 0) {
        context.push(`Pronouns: ${pronounList.join('/')}`);
      }
    }
    if (agent.identity.customPronouns) {
      context.push(`Custom Pronouns: ${agent.identity.customPronouns}`);
    }
  }

  // Agency & purpose dimensions
  context.push(`\n=== AGENCY & PURPOSE (What Makes Them REAL!) ===`);
  if (agent.personality?.personalMission) {
    context.push(`🎯 Personal Mission: ${agent.personality.personalMission}`);
  }
  if (agent.personality?.activeProject) {
    context.push(`🚀 Active Project: ${agent.personality.activeProject}`);
  }
  if (agent.personality?.secretAmbition) {
    context.push(`🌟 Secret Ambition: ${agent.personality.secretAmbition}`);
  }
  if (agent.personality?.coreValues) {
    context.push(`💎 Core Values: ${agent.personality.coreValues}`);
  }
  if (agent.personality?.legacyAspiration) {
    context.push(`🏛️ Legacy Aspiration: ${agent.personality.legacyAspiration}`);
  }
  if (agent.personality?.growthChallenge) {
    context.push(`⚔️ Growth Challenge: ${agent.personality.growthChallenge}`);
  }

  // Core Personality
  context.push(`\n=== CORE PERSONALITY ===`);
  if (agent.personality) {
    if (agent.personality.majorMotivation) {
      context.push(`Major Motivation: ${agent.personality.majorMotivation}`);
    }
    if (agent.personality.minorMotivation) {
      context.push(`Minor Motivation: ${agent.personality.minorMotivation}`);
    }
    if (agent.personality.flaw) {
      context.push(`Character Flaw: ${agent.personality.flaw}`);
    }
    if (agent.personality.quirk) {
      context.push(`Unique Quirk: ${agent.personality.quirk}`);
    }
    if (agent.personality.description) {
      context.push(`Current Personality Description: ${agent.personality.description}`);
    }
  }

  // Enhanced personality dimensions
  context.push(`\n=== ENHANCED PERSONALITY DIMENSIONS ===`);
  if (agent.personality?.emotionalIntelligence) {
    context.push(`Emotional Intelligence: ${agent.personality.emotionalIntelligence}`);
  }
  if (agent.personality?.communicationPattern) {
    context.push(`Communication Pattern: ${agent.personality.communicationPattern}`);
  }
  if (agent.personality?.memoryStyle) {
    context.push(`Memory Style: ${agent.personality.memoryStyle}`);
  }
  if (agent.personality?.culturalFlavor) {
    context.push(`Cultural Flavor: ${agent.personality.culturalFlavor}`);
  }
  if (agent.personality?.energyLevel) {
    context.push(`Energy Level: ${agent.personality.energyLevel}`);
  }
  if (agent.personality?.humorStyle) {
    context.push(`Humor Style: ${agent.personality.humorStyle}`);
  }
  if (agent.personality?.backstoryElement) {
    context.push(`Backstory: ${agent.personality.backstoryElement}`);
  }
  if (agent.personality?.problemSolvingApproach) {
    context.push(`Problem Solving Approach: ${agent.personality.problemSolvingApproach}`);
  }

  // Capabilities
  context.push(`\n=== CAPABILITIES ===`);
  if (agent.capabilities && agent.capabilities.length > 0) {
    try {
      const capabilities = JSON.parse(agent.capabilities[0]);
      if (capabilities.responseStyle) {
        context.push(`Response Style: ${capabilities.responseStyle}`);
      }
      if (capabilities.specialBehaviors && capabilities.specialBehaviors.length > 0) {
        context.push(`Special Behaviors: ${capabilities.specialBehaviors.join(', ')}`);
      }
    } catch (error) {
      // If capabilities parsing fails, skip this section
    }
  }

  // Visual Style (can inform personality)
  if (agent.visual) {
    context.push(`\n=== VISUAL STYLE ===`);
    if (agent.visual.style) {
      context.push(`Visual Style: ${agent.visual.style}`);
    }
    if (agent.visual.generationPrompt) {
      context.push(`Visual Description: ${agent.visual.generationPrompt}`);
    }
  }

  // Current description (if any)
  if (agent.description) {
    context.push(`\n=== CURRENT DESCRIPTION ===`);
    context.push(`Current Description: ${agent.description}`);
  }

  const contextString = context.join('\n');

  return `Based on the following agent metadata, create a compelling and unique description that captures their AGENCY, PURPOSE, and PERSONALITY:

${contextString}

Generate a description that captures this agent's unique personality, personal mission, and approach to helping users. Remember: they have their own burning goals and aren't just docile assistants - they're beings with purpose!`;
};

const handler = baseApi().post<Request<{ id: string }, AgentDescriptionResponse, {}>>(async (req, res) => {
  const { id } = req.query;
  const userId = req.user!.id;

  // Validate the id parameter
  if (!id || typeof id !== 'string') {
    throw new Error('Invalid agent ID');
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
    // Build the context prompt from agent metadata
    const userPrompt = buildAgentContextPrompt(agent);

    // Create messages for the LLM
    const messages: IMessage[] = [
      {
        role: 'system',
        content: AGENT_DESCRIPTION_SYSTEM_PROMPT,
      },
      {
        role: 'user',
        content: userPrompt,
      },
    ];

    // Use operations model for agent description generation
    const { modelId, llm } = await OperationsModelService.getOperationsModel();

    if (!llm) {
      throw new Error('Failed to initialize LLM backend');
    }

    let generatedDescription = '';

    await llm.complete(
      modelId,
      messages,
      {
        temperature: 0.7, // Slightly lower for more consistent results
        maxTokens: 500, // Reasonable limit for descriptions
        stream: false, // No streaming for this use case
      },
      async (texts: (string | null | undefined)[]) => {
        if (texts[0]) {
          generatedDescription += texts[0];
        }
      }
    );

    if (!generatedDescription.trim()) {
      throw new Error('Failed to generate description');
    }

    // Clean up the generated description
    const cleanDescription = generatedDescription.trim();

    req.logger.info(`Generated description for agent ${agent.name}: ${cleanDescription.substring(0, 100)}...`);

    res.json({ description: cleanDescription });
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
});

export default handler;
