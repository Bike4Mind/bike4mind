import {
  adminSettingsRepository,
  apiKeyRepository,
  Connection,
  creditTransactionRepository,
  defineAbilitiesFor,
  organizationRepository,
  questRepository,
  Session,
  usageEventRepository,
  userRepository,
} from '@bike4mind/database';
import { VideoGenerationService } from '@bike4mind/services';
import { SQSService } from '@bike4mind/utils';
import { Logger } from '@bike4mind/observability';
import { logEvent } from '@server/utils/analyticsLog';
import { dispatchWithLogger } from '@server/queueHandlers/utils';
import { getGeneratedImageStorage } from '@server/utils/storage';
import { getSourceQueueUrl } from '@server/utils/dlqRegistry';
import { SessionEvents } from '@server/utils/eventBus';
import { Resource } from 'sst';

let _videoGeneration: VideoGenerationService | undefined;
export const getVideoGeneration = (): VideoGenerationService => {
  if (!_videoGeneration) {
    _videoGeneration = new VideoGenerationService({
      db: {
        sessions: Session,
        quests: questRepository,
        connections: Connection,
        adminSettings: adminSettingsRepository,
        apiKeys: apiKeyRepository,
        users: userRepository,
        creditTransactions: creditTransactionRepository,
        usageEvents: usageEventRepository,
        organizations: organizationRepository,
      },
      startVideoGenerationProcess: async body => {
        const queueLogger = new Logger({ metadata: { handler: 'videoGeneration', phase: 'enqueue' } });
        const queueUrl = getSourceQueueUrl('videoGenerationQueue');
        queueLogger.debug('Queueing video generation', {
          environment: process.env.NODE_ENV,
          queueUrl,
          bodyKeys: Object.keys(body),
          promptPreview: body.prompt?.substring(0, 100),
        });

        try {
          const queue = new SQSService();
          const result = await queue.sendMessage(queueUrl, body);
          queueLogger.debug('Message queued successfully', { result });
        } catch (error) {
          queueLogger.error('Failed to queue message', { error });
          throw error;
        }
      },
      wsHttpsUrl: Resource.websocket.managementEndpoint,
      logEvent: logEvent,
      storage: getGeneratedImageStorage(), // Reuse the same storage bucket for videos
      abilityGetter: defineAbilitiesFor,
      invokeSessionAutoNaming: async (sessionId: string, userId: string) => {
        await SessionEvents.AutoName.publish({
          sessionId,
          userId,
        });
      },
    });
  }
  return _videoGeneration;
};

export const dispatch = dispatchWithLogger(async (event, context, logger) => {
  logger.debug('Starting video generation dispatch', {
    recordCount: event.Records.length,
    requestId: context.awsRequestId,
  });

  await getVideoGeneration().process({
    body: JSON.parse(event.Records[0].body),
    logger,
  });
});
