import { z } from 'zod';
import { dispatchWithLogger } from '@server/queueHandlers/utils';
import {
  sessionAgentConfigRepository,
  sessionRepository,
  agentRepository,
  questRepository,
  userRepository,
  apiKeyRepository,
  adminSettingsRepository,
  imageModerationIncidentRepository,
  usageEventRepository,
  organizationRepository,
  Connection,
} from '@bike4mind/database';
import { ClientMessageSender, getSettingsByNames } from '@bike4mind/utils';
import { Logger } from '@bike4mind/observability';
import { Resource } from 'sst';
import { apiKeyService, agentProactiveMessagingService } from '@bike4mind/services';
import { getFilesStorage, getGeneratedImageStorage } from '@server/utils/storage';

const agentProactiveMessageQueuePayload = z.object({
  sessionAgentConfigId: z.string(),
});

/**
 * Processes a proactive message task from the queue
 */
async function processAgentProactiveMessage(payload: { sessionAgentConfigId: string }, logger: Logger): Promise<void> {
  try {
    logger.info(`Processing proactive message for config ${payload.sessionAgentConfigId}`);

    const config = await sessionAgentConfigRepository.findById(payload.sessionAgentConfigId);

    if (!config || !config.proactiveMessaging.enabled) {
      logger.info(`Proactive messaging disabled or config not found, skipping`);
      return;
    }

    const agent = await agentRepository.findById(config.agentId);
    if (!agent) {
      logger.error(`Agent ${config.agentId} not found`);
      return;
    }

    const session = await sessionRepository.findById(config.sessionId);
    if (!session || session.deletedAt) {
      logger.error(`Session ${config.sessionId} not found or deleted`);
      return;
    }

    const agentIds = await sessionRepository.getAttachedAgents(config.sessionId);
    if (!agentIds.includes(config.agentId)) {
      logger.info(`Agent ${config.agentId} no longer attached to session, skipping`);
      return;
    }

    const user = await userRepository.findById(config.userId);
    if (!user) {
      logger.error(`User ${config.userId} not found`);
      return;
    }

    const apiKeyTable = await apiKeyService.getEffectiveLLMApiKeys(config.userId, {
      db: {
        apiKeys: apiKeyRepository,
        adminSettings: adminSettingsRepository,
      },
      getSettingsByNames,
    });

    const clientMessageSender = new ClientMessageSender(
      {
        connections: {
          findByUserId: (userId: string) => Connection.find({ userId }),
          deleteByConnectionId: async (connectionId: string) => {
            await Connection.deleteOne({ connectionId });
          },
        },
      },
      logger
    );

    const recentMessages = await questRepository.getMostRecentChatHistory(config.sessionId, 10);

    await agentProactiveMessagingService.generateAndSendProactiveMessage({
      config,
      agent,
      session,
      user,
      logger,
      recentMessages: recentMessages.reverse(), // Reverse to get chronological order
      db: {
        quests: questRepository,
        sessions: sessionRepository,
        sessionAgentConfigs: sessionAgentConfigRepository,
        apiKeys: apiKeyRepository,
        adminSettings: adminSettingsRepository,
        // Audit trail for images blocked by the image_generation/edit_image tools'
        // moderation gate. The gate itself is unconditional (constructed
        // inline in the tool) - this only wires the incident record, not the block.
        imageModerationIncidents: imageModerationIncidentRepository,
        // Record tool-internal operational llm.complete spend (blog draft, deep research,
        // file edit, notebook gen) that runs inside a proactive message.
        usageEvents: usageEventRepository,
        organizations: organizationRepository,
      },
      apiKeyTable,
      storage: getFilesStorage(),
      imageGenerateStorage: getGeneratedImageStorage(),
    });

    await clientMessageSender.sendToClient(config.userId, Resource.websocket.managementEndpoint, {
      action: 'invalidate_query',
      queryKey: ['chat-history', config.sessionId],
    });

    await clientMessageSender.sendToClient(config.userId, Resource.websocket.managementEndpoint, {
      action: 'invalidate_query',
      queryKey: ['recent-proactive-messages'],
    });

    logger.info(`Successfully processed proactive message for agent ${config.agentId}`);
  } catch (error) {
    logger.error('Error processing proactive message:', error as Error);
    throw error;
  }
}

/**
 * Queue handler for agent proactive messages; processes tasks asynchronously.
 */
export const dispatch = dispatchWithLogger(async (event, _context, logger) => {
  const body = event.Records[0].body;
  const payload = agentProactiveMessageQueuePayload.parse(JSON.parse(body));

  logger.info(
    `🤖 [AGENT_PROACTIVE_MESSAGE_QUEUE] Processing proactive message for config ${payload.sessionAgentConfigId}`
  );

  await processAgentProactiveMessage(payload, logger);

  logger.info(
    `✅ [AGENT_PROACTIVE_MESSAGE_QUEUE] Completed proactive message for config ${payload.sessionAgentConfigId}`
  );
});
