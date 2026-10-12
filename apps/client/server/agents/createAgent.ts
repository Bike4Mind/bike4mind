import { agentRepository, userRepository, withTransaction } from '@bike4mind/database';
import {
  AGENT_LIMIT_REACHED_ERROR_CODE,
  IAgent,
  IAgentCapabilities,
  IAgentDocument,
  UserLevelType,
} from '@bike4mind/common';
import { BadRequestError } from '@bike4mind/utils';
import { AgentValidationError, validateAgentUpdate } from '@server/utils/agentValidation';

/**
 * Validates and creates an agent owned by `userId`, enforcing the per-tier agent cap and, when
 * `useOwnCredits` is set, debiting the allocation from the owner in the same transaction.
 * Shared by POST /api/agents and POST /api/v1/agents. Throws BadRequestError on any rejection: an
 * AgentValidationError for an invalid body field, and the tier cap carries `errorCode: agent_limit_reached`.
 * `label` renames a field in an error message (see validateAgentUpdate).
 */
export async function createAgent(agentData: Partial<IAgent>, userId: string, label?: (field: string) => string) {
  // Validate required fields
  if (!agentData.name) {
    throw new AgentValidationError('Agent name is required');
  }

  // Normalizes agentData in place, so the fields below read the validated values.
  validateAgentUpdate(agentData, label);

  // Always use a default description if empty or undefined
  // This ensures the MongoDB schema validation passes
  const description = agentData.description?.trim() ? agentData.description.trim() : 'No description provided';

  // Parse capabilities if provided as an object
  let capabilitiesObj: IAgentCapabilities = {
    triggerWords: agentData.triggerWords || ['@help'],
    responseStyle: 'friendly',
    specialBehaviors: [],
  };

  if (agentData.capabilities && agentData.capabilities.length > 0) {
    try {
      const parsedCapabilities = JSON.parse(agentData.capabilities[0]);
      capabilitiesObj = {
        ...capabilitiesObj,
        ...parsedCapabilities,
      };
    } catch (parseError) {
      console.error('Error parsing capabilities JSON:', parseError);
    }
  }

  // Use a transaction to handle credit deduction if using own credits
  // to ensure atomicity between deducting user credits and creating the agent
  return withTransaction(async () => {
    const user = await userRepository.findById(userId);

    if (!user) {
      throw new BadRequestError('User not found');
    }

    // Enforce per-tier agent count limit
    const AGENT_LIMITS: Record<UserLevelType, number> = {
      DemoUser: 2,
      PaidUser: 10,
      VIPUser: 20,
      ManagerUser: 50,
      AdminUser: Infinity,
    };
    const activeCount = await agentRepository.countByUserId(userId);
    const limit = AGENT_LIMITS[user.level ?? 'DemoUser'];
    if (activeCount >= limit) {
      throw new BadRequestError(`Agent limit reached for your tier (${limit} max)`, {
        errorCode: AGENT_LIMIT_REACHED_ERROR_CODE,
      });
    }

    let updatedUserCredits = user.currentCredits || 0;

    // Check if we need to deduct credits from the user
    if (agentData.useOwnCredits && agentData.currentCredits && agentData.currentCredits > 0) {
      // Check if user has enough credits
      if ((user.currentCredits || 0) < agentData.currentCredits) {
        throw new BadRequestError(
          `Insufficient credits. You have ${user.currentCredits || 0} credits, but tried to allocate ${agentData.currentCredits}.`
        );
      }

      // Deduct credits from user
      const updatedUser = await userRepository.incrementCredits(user.id, -agentData.currentCredits);
      if (!updatedUser) {
        throw new BadRequestError('User not found');
      }
      updatedUserCredits = updatedUser.currentCredits ?? 0;

      console.log(
        `Deducted ${agentData.currentCredits} credits from user ${userId}. New balance: ${updatedUserCredits}`
      );
    }

    // Extract and ensure string types for visual properties
    const visualStyle: string = agentData.visual?.style || 'modern';
    const visualGenerationPrompt: string = agentData.visual?.generationPrompt || '';

    // Prepare the agent data with proper type safety
    const agentCreateData = {
      name: agentData.name!, // We validated this above
      description,
      userId: userId,
      ...(agentData.projectId && { projectId: agentData.projectId }),
      triggerWords: agentData.triggerWords || ['@help'],
      isPublic: agentData.isPublic || false,
      capabilities: [
        JSON.stringify({
          triggerWords: capabilitiesObj.triggerWords,
          responseStyle: capabilitiesObj.responseStyle,
          specialBehaviors: capabilitiesObj.specialBehaviors,
        }),
      ],
      systemPrompt: agentData.systemPrompt || '', // Add system prompt support
      ...(agentData.preferredModel && { preferredModel: agentData.preferredModel }),
      ...(agentData.preferredImageModel && { preferredImageModel: agentData.preferredImageModel }),
      ...(agentData.temperature !== undefined && { temperature: agentData.temperature }),
      ...(agentData.maxTokens !== undefined && { maxTokens: agentData.maxTokens }),
      // Orchestration fields. Presence of ANY field routes the agent through
      // the ReAct executor with the inline permission card.
      ...(agentData.allowedTools && { allowedTools: agentData.allowedTools }),
      ...(agentData.deniedTools && { deniedTools: agentData.deniedTools }),
      ...(agentData.maxIterations && { maxIterations: agentData.maxIterations }),
      ...(agentData.defaultThoroughness && { defaultThoroughness: agentData.defaultThoroughness }),
      ...(agentData.defaultVariables && { defaultVariables: agentData.defaultVariables }),
      ...(agentData.exclusiveMcpServers && { exclusiveMcpServers: agentData.exclusiveMcpServers }),
      ...(agentData.fallbackModels && { fallbackModels: agentData.fallbackModels }),
      personality: {
        majorMotivation: agentData.personality?.majorMotivation || 'Helping users',
        minorMotivation: agentData.personality?.minorMotivation || 'Learning',
        flaw: agentData.personality?.flaw || 'None',
        quirk: agentData.personality?.quirk || 'None',
        description: agentData.personality?.description || 'Helpful assistant',
        // Enhanced personality dimensions
        emotionalIntelligence: agentData.personality?.emotionalIntelligence || '',
        communicationPattern: agentData.personality?.communicationPattern || '',
        memoryStyle: agentData.personality?.memoryStyle || '',
        culturalFlavor: agentData.personality?.culturalFlavor || '',
        energyLevel: agentData.personality?.energyLevel || '',
        humorStyle: agentData.personality?.humorStyle || '',
        backstoryElement: agentData.personality?.backstoryElement || '',
        problemSolvingApproach: agentData.personality?.problemSolvingApproach || '',
        // Agency & Purpose dimensions
        personalMission: agentData.personality?.personalMission || '',
        activeProject: agentData.personality?.activeProject || '',
        secretAmbition: agentData.personality?.secretAmbition || '',
        coreValues: agentData.personality?.coreValues || '',
        legacyAspiration: agentData.personality?.legacyAspiration || '',
        growthChallenge: agentData.personality?.growthChallenge || '',
        // Meta information
        personalityComplexity: agentData.personality?.personalityComplexity || 'moderate',
        generationTimestamp: agentData.personality?.generationTimestamp || new Date().toISOString(),
        uniqueId: agentData.personality?.uniqueId || '',
      },
      visual: {
        portraitUrl: agentData.visual?.portraitUrl || '',
        style: visualStyle,
        generationPrompt: visualGenerationPrompt,
      },
      identity: {
        gender: agentData.identity?.gender || 'prefer-not-to-say',
        pronouns: {
          subject: agentData.identity?.pronouns?.subject || '',
          object: agentData.identity?.pronouns?.object || '',
          possessive: agentData.identity?.pronouns?.possessive || '',
          possessiveAdjective: agentData.identity?.pronouns?.possessiveAdjective || '',
          reflexive: agentData.identity?.pronouns?.reflexive || '',
        },
        customPronouns: agentData.identity?.customPronouns || '',
      },
      useOwnCredits: agentData.useOwnCredits || false,
      currentCredits: agentData.currentCredits || 0,
      isGlobalRead: false,
      isGlobalWrite: false,
      users: [],
      groups: [],
    } as Omit<IAgentDocument, 'id' | 'createdAt' | 'updatedAt'>;

    // Now create the agent with the specified credits
    const agent = await agentRepository.create(agentCreateData);

    return { agent, userCredits: updatedUserCredits };
  });
}
