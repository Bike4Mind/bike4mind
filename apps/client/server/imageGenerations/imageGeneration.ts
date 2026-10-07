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
  sessionRepository,
  usageEventRepository,
  userRepository,
} from '@bike4mind/database';
import { ImageGenerationService } from '@bike4mind/services/llm/ImageGeneration';
import { SQSService } from '@bike4mind/utils';
import { RekognitionImageModerationService } from '@bike4mind/utils/imageModeration';
import { Logger } from '@bike4mind/observability';
import { logEvent } from '@server/utils/analyticsLog';
import { getFilesStorage, getGeneratedImageStorage } from '@server/utils/storage';
import imageLogger from '@client/app/utils/imageLogger';
import { getSourceQueueUrl } from '@server/utils/dlqRegistry';
import { SessionEvents } from '@server/utils/eventBus';
import { createAttachmentLakeAccess } from '@server/queueHandlers/agentExecutor.attachmentLakeAccess';
import type { IUserDocument } from '@bike4mind/common';
import { Resource } from 'sst';

let _imageGeneration: ImageGenerationService | undefined;
export const getImageGeneration = (): ImageGenerationService => {
  if (!_imageGeneration) {
    _imageGeneration = new ImageGenerationService({
      db: {
        // findById stays on the model (unchanged reads); the counter lives on the repository.
        sessions: {
          findById: Session.findById.bind(Session),
          incrementImageCount: sessionRepository.incrementImageCount.bind(sessionRepository),
        },
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
      // Owner-wide lake arms for the input-image lookup, parity with the chat/agent attachment
      // doors - a lake-only image the workbench admitted must still resolve as an image-gen input.
      resolveLakeAccess: (user: IUserDocument, logger: Logger) => createAttachmentLakeAccess(user, logger)(),
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
