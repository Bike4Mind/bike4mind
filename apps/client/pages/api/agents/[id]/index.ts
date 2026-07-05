import { Request } from 'express';
import { baseApi } from '@client/server/middlewares/baseApi';
import {
  agentRepository,
  fabFileRepository,
  User,
  userRepository,
  creditTransactionRepository,
} from '@bike4mind/database';
import {
  IAgent,
  IAgentCapabilities,
  supportedChatModels,
  supportedImageModels,
  CreditHolderType,
  isImageServeable,
} from '@bike4mind/common';
import { NotFoundError, ForbiddenError, BadRequestError } from '@bike4mind/utils';
import { getFilesStorage } from '@server/utils/storage';
import { creditService } from '@bike4mind/services';
import {
  validateToolList,
  validateMaxIterations,
  validateDefaultThoroughness,
  validateStringList,
  validateDefaultVariables,
  validateTriggerWords,
} from '@server/utils/agentValidation';

// Helper function to refresh avatar URL for a single agent
const refreshAgentAvatarUrl = async (agent: IAgent): Promise<IAgent> => {
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
      const now = new Date();

      // Check if the current URL is expired or will expire soon (within 5 minutes)
      const shouldRefresh =
        !fabFile.fileUrlExpireAt || fabFile.fileUrlExpireAt.getTime() <= now.getTime() + 5 * 60 * 1000;

      if (shouldRefresh) {
        // Generate new signed URL
        const newSignedUrl = await getFilesStorage().getSignedUrl(filePath);

        if (newSignedUrl) {
          // Update the FabFile with the new URL and expiration
          const newExpireAt = new Date(now.getTime() + 3600 * 1000);
          await fabFileRepository.update({
            ...fabFile,
            fileUrl: newSignedUrl,
            fileUrlExpireAt: newExpireAt,
          });

          // Return agent with updated portrait URL
          return {
            ...agent,
            visual: {
              ...agent.visual,
              portraitUrl: newSignedUrl,
            },
          };
        }
      }
    }
  } catch (error) {
    console.error(`Error refreshing avatar URL for agent ${agent.name}:`, error);
  }

  return agent;
};

const handler = baseApi()
  .get<Request<{}, {}, {}, { id: string }>>(async (req, res) => {
    const { id } = req.query;

    const agent = await agentRepository.findById(id as string);
    if (!agent) {
      throw new NotFoundError('Agent not found');
    }

    // Check permission (user must own the agent or be shared)
    const isSharedWithUser = agent.users?.some((u: { userId: string }) => u.userId === req.user!.id);
    if (agent.userId !== req.user!.id && !isSharedWithUser) {
      throw new ForbiddenError("You don't have permission to view this agent");
    }

    // Refresh avatar URL before returning
    const agentWithRefreshedAvatar = await refreshAgentAvatarUrl(agent);

    res.json(agentWithRefreshedAvatar);
  })
  .put(async (req, res) => {
    const { id } = req.query;
    const agentData = req.body as Partial<IAgent>;

    // Find the agent
    const agent = await agentRepository.findById(id as string);
    if (!agent) {
      throw new NotFoundError('Agent not found');
    }

    // Check ownership
    if (agent.userId !== req.user!.id) {
      throw new ForbiddenError("You don't have permission to update this agent");
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

    // Reject malformed trigger words before they reach MongoDB - keeps the
    // PUT route in sync with POST and stops a silent regression where a
    // valid create is followed by a malformed edit.
    if (agentData.triggerWords !== undefined) {
      agentData.triggerWords = validateTriggerWords(agentData.triggerWords);
    }

    // Orchestration fields - mirror the POST endpoint bounds so PUT can't
    // bypass the array-size / max-iteration guards.
    if (agentData.allowedTools !== undefined) {
      agentData.allowedTools = validateToolList(agentData.allowedTools, 'allowedTools');
    }
    if (agentData.deniedTools !== undefined) {
      agentData.deniedTools = validateToolList(agentData.deniedTools, 'deniedTools');
    }
    if (agentData.maxIterations !== undefined) {
      agentData.maxIterations = validateMaxIterations(agentData.maxIterations);
    }
    if (agentData.defaultThoroughness !== undefined) {
      agentData.defaultThoroughness = validateDefaultThoroughness(agentData.defaultThoroughness);
    }
    if (agentData.defaultVariables !== undefined) {
      agentData.defaultVariables = validateDefaultVariables(agentData.defaultVariables);
    }
    if (agentData.exclusiveMcpServers !== undefined) {
      agentData.exclusiveMcpServers = validateStringList(agentData.exclusiveMcpServers, 'exclusiveMcpServers');
    }
    if (agentData.fallbackModels !== undefined) {
      agentData.fallbackModels = validateStringList(agentData.fallbackModels, 'fallbackModels');
    }

    // Handle capabilities conversion if it's in the old format
    if (
      agentData.capabilities &&
      typeof agentData.capabilities === 'object' &&
      !Array.isArray(agentData.capabilities)
    ) {
      // Convert capabilities object to string array
      const capabilitiesObj = agentData.capabilities as unknown as IAgentCapabilities;
      agentData.capabilities = [
        JSON.stringify({
          triggerWords: capabilitiesObj.triggerWords || agent.triggerWords,
          responseStyle: capabilitiesObj.responseStyle || 'friendly',
          specialBehaviors: capabilitiesObj.specialBehaviors || [],
        }),
      ];
    }

    // Make sure we're passing the ID correctly
    agentData.id = id as string;

    // Update the agent with { new: true } to return the updated document
    const updatedAgent = await agentRepository.update(agentData, { new: true });

    if (!updatedAgent) {
      // If the update didn't return a document, fetch the latest
      const refreshedAgent = await agentRepository.findById(id as string);
      return res.json(refreshedAgent);
    }

    res.json(updatedAgent);
  })
  .delete(async (req, res) => {
    const { id } = req.query;

    // Find the agent
    const agent = await agentRepository.findById(id as string);
    if (!agent) {
      throw new NotFoundError('Agent not found');
    }

    // Check ownership
    if (agent.userId !== req.user!.id) {
      throw new ForbiddenError("You don't have permission to delete this agent");
    }

    // Reclaim agent credits back to owning user before deletion.
    // claimCredits atomically zeroes the agent balance and returns the claimed amount -
    // concurrent DELETE requests will get 0 on the second call, preventing double credit grant.
    const creditsToReclaim = await agentRepository.claimCredits(id as string);
    if (creditsToReclaim > 0) {
      try {
        // Credit user first: if subsequent agent debit fails, user has extra credits (recoverable)
        // rather than losing credits permanently (agent debited but user never credited).
        await creditService.addCredits(
          {
            ownerId: req.user!.id,
            ownerType: CreditHolderType.User,
            credits: creditsToReclaim,
            type: 'received_credit',
            senderId: agent.id,
            senderType: CreditHolderType.Agent,
            description: 'Credits returned from deleted agent',
          },
          { db: { creditTransactions: creditTransactionRepository }, creditHolderMethods: userRepository }
        );
        await creditService.subtractCredits(
          {
            type: 'transfer_credit',
            ownerId: agent.id,
            ownerType: CreditHolderType.Agent,
            credits: creditsToReclaim,
            description: 'Agent credit reclaim on deletion',
            recipientId: req.user!.id,
            recipientType: CreditHolderType.User,
          },
          { db: { creditTransactions: creditTransactionRepository }, creditHolderMethods: agentRepository }
        );
      } catch (err) {
        // Non-atomic: log for manual reconciliation but still block deletion if reclaim failed
        console.error('Agent credit reclaim failed — manual reconciliation may be needed', {
          agentId: agent.id,
          userId: req.user!.id,
          credits: creditsToReclaim,
          err,
        });
        throw err;
      }
    }

    // Delete the agent
    await agentRepository.delete(id as string);

    // Clean up any users who had this agent selected as their custom Slack agent
    try {
      await User.updateMany({ 'slackSettings.customAgentId': id }, { $unset: { 'slackSettings.customAgentId': '' } });
    } catch (error) {
      console.error('Failed to clean up agent references:', error);
      // Don't fail the request - agent is already deleted
    }

    res.status(204).end();
  });

export default handler;
