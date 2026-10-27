import { assertMediaModelAdmission } from '@server/billing/assertMediaModelAdmission';
import {
  adminSettingsRepository,
  apiKeyRepository,
  Connection,
  creditTransactionRepository,
  defineAbilitiesFor,
  fabFileRepository,
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
import { logEvent } from '@bike4mind/server-utils/utils/analyticsLog';
import { getFilesStorage, getGeneratedImageStorage } from '@bike4mind/server-utils/utils/storage/index';
import { saveGeneratedAssetToFiles } from '@bike4mind/server-utils/utils/saveGeneratedAssetToFiles';
import imageLogger from '@bike4mind/server-utils/utils/imageLogger';
import { getSourceQueueUrl } from '@bike4mind/server-utils/utils/dlqRegistry';
import { SessionEvents } from '@server/utils/eventBus';
import { createAttachmentLakeAccess } from '@server/dataLakes/attachmentLakeAccess';
import type { IUserDocument } from '@bike4mind/common';
import { Resource } from 'sst';
import { imageModerationIncidents } from '@server/moderation/imageModerationIncidents';
import { imageCreditHolds } from '@server/billing/imageCreditHolds';

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
        imageModerationIncidents,
      },
      imageProcessorLambdaName: Resource.ImageProcessor.name,
      imageModerationService: new RekognitionImageModerationService(Logger.globalInstance),
      // Owner-wide lake arms for the input-image lookup, parity with the chat/agent attachment
      // doors - a lake-only image the workbench admitted must still resolve as an image-gen input.
      resolveLakeAccess: (user: IUserDocument, logger: Logger) => createAttachmentLakeAccess(user, logger)(),
      creditHolds: imageCreditHolds,
      assertModelAdmission: assertMediaModelAdmission,
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
      saveGeneratedAsset: saveGeneratedAssetToFiles,
      abilityGetter: defineAbilitiesFor,
      invokeSessionAutoNaming: async (sessionId: string, userId: string) => {
        await SessionEvents.AutoName.publish({
          sessionId,
          userId,
        });
      },
      invokeSummarizeSession: async (sessionId, trigger, payerId) => {
        await SessionEvents.Summarize.publish({
          sessionId,
          callTagging: true,
          trigger,
          payerId,
        });
      },
    });
  }
  return _imageGeneration;
};
