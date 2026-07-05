// packages/client/pages/api/agents/index.ts
import { Request } from 'express';
import { baseApi } from '@client/server/middlewares/baseApi';
import { agentRepository, userRepository, withTransaction, fabFileRepository } from '@bike4mind/database';
import {
  IAgent,
  IAgentCapabilities,
  IAgentDocument,
  supportedChatModels,
  supportedImageModels,
  UserLevelType,
  isImageServeable,
} from '@bike4mind/common';
import { BadRequestError } from '@bike4mind/utils';
import { getFilesStorage } from '@server/utils/storage';
import {
  validateToolList,
  validateMaxIterations,
  validateDefaultThoroughness,
  validateStringList,
  validateDefaultVariables,
  validateTriggerWords,
} from '@server/utils/agentValidation';

// Extend IAgent to include systemPrompt temporarily
interface IAgentWithSystemPrompt extends IAgent {
  systemPrompt?: string;
}

// Helper function to refresh avatar URLs for agents
const refreshAgentAvatarUrls = async (agents: IAgent[]): Promise<IAgent[]> => {
  const refreshedAgents = await Promise.all(
    agents.map(async agent => {
      // Skip if no portrait URL
      if (!agent.visual?.portraitUrl) {
        return agent;
      }

      try {
        // Extract the filename from the S3 URL
        // URLs look like: https://bucket.s3.region.amazonaws.com/filename.ext?params
        const url = new URL(agent.visual.portraitUrl);
        const pathname = url.pathname; // This gives us "/filename.ext"
        const filename = pathname.substring(1); // Remove the leading "/"

        if (!filename || !filename.includes('.')) {
          return agent;
        }

        // The filePath in the database should be just the filename (without fab-files/ prefix)
        const filePath = filename;

        // Find the corresponding FabFile to get proper signed URL
        const fabFile = await fabFileRepository.findOne({ filePath });
        // Don't re-mint a signed URL for a held/blocked avatar image.
        if (fabFile && fabFile.filePath && isImageServeable(fabFile)) {
          // Check if the current URL is expired (older than 50 minutes)
          const now = new Date();
          const isExpired = !fabFile.fileUrlExpireAt || fabFile.fileUrlExpireAt <= now;

          if (isExpired) {
            // Generate a new signed URL
            const newSignedUrl = await getFilesStorage().getSignedUrl(fabFile.filePath);

            if (newSignedUrl) {
              // Update the FabFile with the new URL and expiration
              const newExpireAt = new Date(now.getTime() + 3600 * 1000);
              await fabFileRepository.update({
                ...fabFile,
                fileUrl: newSignedUrl,
                fileUrlExpireAt: newExpireAt,
              });

              // Return the agent with the new URL
              return {
                ...agent,
                visual: {
                  ...agent.visual,
                  portraitUrl: newSignedUrl,
                },
              };
            }
          } else {
            // URL is still valid, use the existing one
            return {
              ...agent,
              visual: {
                ...agent.visual,
                portraitUrl: fabFile.fileUrl || agent.visual.portraitUrl,
              },
            };
          }
        }
      } catch (error) {
        console.error(`Error refreshing avatar URL for agent ${agent.name}:`, error);
      }

      return agent;
    })
  );

  return refreshedAgents;
};

const handler = baseApi()
  .get<Request<{}, {}, {}, Record<string, string>>>(async (req, res) => {
    const { query = '', page = '1', limit = '10', orderBy = 'updatedAt', orderDirection = 'desc' } = req.query;

    // Parse query parameters
    const pageNum = parseInt(page, 10);
    const limitNum = parseInt(limit, 10);

    // Search for agents
    const result = await agentRepository.searchAccessible(
      req.user!.id,
      query,
      {},
      { page: pageNum, limit: limitNum },
      { by: orderBy as 'createdAt' | 'updatedAt', direction: orderDirection as 'asc' | 'desc' }
    );

    const data: IAgent[] = result.data;

    // Refresh avatar URLs for all agents BEFORE returning response
    const agentsWithRefreshedAvatars = await refreshAgentAvatarUrls(data);

    res.json({
      ...result,
      data: agentsWithRefreshedAvatars,
    });
  })
  .post(async (req, res) => {
    try {
      const agentData = req.body as Partial<IAgentWithSystemPrompt>;

      // Validate required fields
      if (!agentData.name) {
        throw new BadRequestError('Agent name is required');
      }

      // Validate model config fields
      if (agentData.preferredModel && !supportedChatModels.safeParse(agentData.preferredModel).success) {
        throw new BadRequestError(`Invalid model: ${agentData.preferredModel}`);
      }
      if (agentData.preferredImageModel && !supportedImageModels.safeParse(agentData.preferredImageModel).success) {
        throw new BadRequestError(`Invalid image model: ${agentData.preferredImageModel}`);
      }
      if (agentData.temperature !== undefined && (agentData.temperature < 0 || agentData.temperature > 2)) {
        throw new BadRequestError('Temperature must be between 0 and 2');
      }
      if (agentData.maxTokens !== undefined && (agentData.maxTokens < 1 || agentData.maxTokens > 128000)) {
        throw new BadRequestError('Max tokens must be between 1 and 128000');
      }

      // Reject malformed trigger words before they reach MongoDB - the chat
      // mention parser can't read handles with leading/trailing hyphens or
      // non-alphanumeric chars beyond `_-`, and persisting one is a silent
      // routing failure for the user.
      const validatedTriggerWords = validateTriggerWords(agentData.triggerWords);

      // Orchestration fields - bound shape and length to prevent a malformed
      // caller writing unbounded blobs to MongoDB.
      const validatedAllowedTools = validateToolList(agentData.allowedTools, 'allowedTools');
      const validatedDeniedTools = validateToolList(agentData.deniedTools, 'deniedTools');
      const validatedMaxIterations = validateMaxIterations(agentData.maxIterations);
      const validatedDefaultThoroughness = validateDefaultThoroughness(agentData.defaultThoroughness);
      const validatedDefaultVariables = validateDefaultVariables(agentData.defaultVariables);
      const validatedExclusiveMcpServers = validateStringList(agentData.exclusiveMcpServers, 'exclusiveMcpServers');
      const validatedFallbackModels = validateStringList(agentData.fallbackModels, 'fallbackModels');

      // Always use a default description if empty or undefined
      // This ensures the MongoDB schema validation passes
      const description = agentData.description?.trim() ? agentData.description.trim() : 'No description provided';

      // Parse capabilities if provided as an object
      let capabilitiesObj: IAgentCapabilities = {
        triggerWords: validatedTriggerWords || ['@help'],
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
      return await withTransaction(async () => {
        const userId = req.user!.id;
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
          throw new BadRequestError(`Agent limit reached for your tier (${limit} max)`);
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
          user.currentCredits = (user.currentCredits || 0) - agentData.currentCredits;
          await userRepository.update(user);
          updatedUserCredits = user.currentCredits;

          console.log(
            `Deducted ${agentData.currentCredits} credits from user ${userId}. New balance: ${user.currentCredits}`
          );
        }

        // Extract and ensure string types for visual properties
        const visualStyle: string = agentData.visual?.style || 'modern';
        const visualGenerationPrompt: string = agentData.visual?.generationPrompt || '';

        // Prepare the agent data with proper type safety
        const agentCreateData = {
          name: agentData.name!, // We validated this above
          description,
          userId: req.user!.id,
          ...(agentData.projectId && { projectId: agentData.projectId }),
          triggerWords: validatedTriggerWords || ['@help'],
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
          ...(validatedAllowedTools && { allowedTools: validatedAllowedTools }),
          ...(validatedDeniedTools && { deniedTools: validatedDeniedTools }),
          ...(validatedMaxIterations && { maxIterations: validatedMaxIterations }),
          ...(validatedDefaultThoroughness && { defaultThoroughness: validatedDefaultThoroughness }),
          ...(validatedDefaultVariables && { defaultVariables: validatedDefaultVariables }),
          ...(validatedExclusiveMcpServers && { exclusiveMcpServers: validatedExclusiveMcpServers }),
          ...(validatedFallbackModels && { fallbackModels: validatedFallbackModels }),
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

        // Return agent and updated user credits
        return res.status(201).json({
          ...agent,
          userCredits: updatedUserCredits,
        });
      });
    } catch (error: any) {
      console.error('Error creating agent:', error);
      if (error.name === 'BadRequestError' || error.statusCode === 400) {
        return res.status(400).json({ error: error.message });
      }
      res.status(500).json({ error: 'Failed to create agent', details: error.message });
    }
  });

export default handler;
