import {
  adminSettingsRepository,
  apiKeyRepository,
  Connection,
  creditTransactionRepository,
  defineAbilitiesFor,
  fabFileChunkRepository,
  fabFileRepository,
  imageModerationIncidentRepository,
  organizationRepository,
  questRepository,
  Session,
  sessionRepository,
  usageEventRepository,
  userRepository,
} from '@bike4mind/database';
import { RekognitionImageModerationService, SQSService } from '@bike4mind/utils';
import { Logger } from '@bike4mind/observability';
import { logEvent } from '@server/utils/analyticsLog';
import { dispatchWithLogger } from '@server/queueHandlers/utils';
import { ImageEditService } from '@bike4mind/services';
import { getFilesStorage, getGeneratedImageStorage } from '@server/utils/storage';
import { fabFilesService } from '@bike4mind/services';
import { getSourceQueueUrl } from '@server/utils/dlqRegistry';
import { Resource } from 'sst';

let _imageEdit: ImageEditService | undefined;
export const getImageEdit = (): ImageEditService => {
  if (!_imageEdit) {
    const filesStorage = getFilesStorage();
    _imageEdit = new ImageEditService({
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
      abilityGetter: defineAbilitiesFor,
    });
  }
  return _imageEdit;
};

export const dispatch = dispatchWithLogger(async (event, context, logger) => {
  logger.debug('Starting image edit dispatch', {
    recordCount: event.Records.length,
    requestId: context.awsRequestId,
  });

  await getImageEdit().process({
    body: JSON.parse(event.Records[0].body),
    logger,
  });
});
