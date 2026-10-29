import { assertMediaModelAdmission } from '@server/billing/assertMediaModelAdmission';
import {
  adminSettingsRepository,
  apiKeyRepository,
  Connection,
  creditTransactionRepository,
  defineAbilitiesFor,
  fabFileChunkRepository,
  fabFileRepository,
  organizationRepository,
  questRepository,
  Session,
  sessionRepository,
  usageEventRepository,
  userRepository,
} from '@bike4mind/database';
import { SQSService } from '@bike4mind/utils';
import { RekognitionImageModerationService } from '@bike4mind/utils/imageModeration';
import { Logger } from '@bike4mind/observability';
import { logEvent } from '@server/utils/analyticsLog';
import { ImageEditService } from '@bike4mind/services/llm/ImageEdit';
import { getFilesStorage, getGeneratedImageStorage } from '@bike4mind/server-utils/utils/storage/index';
import { saveGeneratedAssetToFiles } from '@bike4mind/server-utils/utils/saveGeneratedAssetToFiles';
import { fabFilesService } from '@bike4mind/services';
import { getSourceQueueUrl } from '@bike4mind/server-utils/utils/dlqRegistry';
import { createAttachmentLakeAccess } from '@server/dataLakes/attachmentLakeAccess';
import type { IUserDocument } from '@bike4mind/common';
import { Resource } from 'sst';
import { imageModerationIncidents } from '@server/moderation/imageModerationIncidents';
import { imageCreditHolds } from '@server/billing/imageCreditHolds';

let _imageEdit: ImageEditService | undefined;
export const getImageEdit = (): ImageEditService => {
  if (!_imageEdit) {
    const filesStorage = getFilesStorage();
    _imageEdit = new ImageEditService({
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
      // Owner-wide lake arms for the reference-image lookup, parity with imageGeneration - a
      // lake-only anchor the workbench admitted must still resolve as an edit input.
      resolveLakeAccess: (user: IUserDocument, logger: Logger) => createAttachmentLakeAccess(user, logger)(),
      creditHolds: imageCreditHolds,
      assertModelAdmission: assertMediaModelAdmission,
      startImageEditProcess: async body => {
        const queue = new SQSService();
        const queueUrl = getSourceQueueUrl('imageEditQueue');
        await queue.sendMessage(queueUrl, body);
      },
      deleteFabFile: async (userId: string, fileId: string) => {
        await fabFilesService.deleteFabFile(
          userId,
          { id: fileId },
          {
            db: {
              fabFiles: fabFileRepository,
              fabFileChunks: fabFileChunkRepository,
              users: userRepository,
              sessions: sessionRepository,
            },
            storage: filesStorage,
          }
        );
      },
      wsHttpsUrl: Resource.websocket.managementEndpoint,
      logEvent: logEvent,
      storage: getGeneratedImageStorage(),
      fabFileStorage: filesStorage,
      saveGeneratedAsset: saveGeneratedAssetToFiles,
      abilityGetter: defineAbilitiesFor,
    });
  }
  return _imageEdit;
};
