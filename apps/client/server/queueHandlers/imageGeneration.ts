import {
  adminSettingsRepository,
  apiKeyRepository,
  Connection,
  creditTransactionRepository,
  defineAbilitiesFor,
  fabFileRepository,
  imageModerationIncidentRepository,
  organizationRepository,
  questRepository,
  Session,
  usageEventRepository,
  userRepository,
} from '@bike4mind/database';
import { ImageGenerationService } from '@bike4mind/services';
import { RekognitionImageModerationService, SQSService } from '@bike4mind/utils';
import { Logger } from '@bike4mind/observability';
import { logEvent } from '@server/utils/analyticsLog';
import { dispatchWithLogger } from '@server/queueHandlers/utils';
import { getFilesStorage, getGeneratedImageStorage } from '@server/utils/storage';
import imageLogger from '@client/app/utils/imageLogger';
import { getSourceQueueUrl } from '@server/utils/dlqRegistry';
import { SessionEvents } from '@server/utils/eventBus';
import { Resource } from 'sst';

let _imageGeneration: ImageGenerationService | undefined;
export const getImageGeneration = (): ImageGenerationService => {
  if (!_imageGeneration) {
    _imageGeneration = new ImageGenerationService({
      db: {
        sessions: Session,
        quests: questRepository,
        connections: Connection,
        adminSettings: adminSettingsRepository,
        apiKeys: apiKeyRepository,
        users: userRepository,
        fabFiles: fabFileRepository,
        creditTransactions: creditTransactionRepository,
        usageEvents: usageEventRepository,
        organizations: organizationRepository,
        imageModerationIncidents: imageModerationIncidentRepository,
      },
      imageProcessorLambdaName: Resource.ImageProcessor.name,
      imageModerationService: new RekognitionImageModerationService(Logger.globalInstance),
      startImageGenerationProcess: async body => {
        const queueUrl = getSourceQueueUrl('imageGenerationQueue');
        imageLogger.log('Queueing image generation', {
          environment: process.env.NODE_ENV,
          queueUrl,
          bodyKeys: Object.keys(body),
          promptPreview: body.prompt?.substring(0, 100),
          fabFileIds: body.fabFileIds,
        });

        try {
          const queue = new SQSService();
          const result = await queue.sendMessage(queueUrl, body);
          imageLogger.log('Message queued successfully', { result });
        } catch (error) {
          imageLogger.error('Failed to queue message', { error });
          throw error;
        }
      },
      wsHttpsUrl: Resource.websocket.managementEndpoint,
      logEvent: logEvent,
      storage: getGeneratedImageStorage(),
      fabFileStorage: getFilesStorage(),
      abilityGetter: defineAbilitiesFor,
      invokeSessionAutoNaming: async (sessionId: string, userId: string) => {
        await SessionEvents.AutoName.publish({
          sessionId,
          userId,
        });
      },
      invokeSummarizeSession: async (sessionId, trigger) => {
        await SessionEvents.Summarize.publish({
          sessionId,
          callTagging: true,
          trigger,
        });
      },
    });
  }
  return _imageGeneration;
};

export const dispatch = dispatchWithLogger(async (event, context, logger) => {
  logger.debug('Starting image generation dispatch', {
    recordCount: event.Records.length,
    requestId: context.awsRequestId,
  });

  await getImageGeneration().process({
    body: JSON.parse(event.Records[0].body),
    logger,
  });
});
