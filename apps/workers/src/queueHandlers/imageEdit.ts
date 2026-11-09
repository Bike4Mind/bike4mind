import { dispatchWithLogger } from '@bike4mind/server-utils/queueHandlers/utils';
import { Connection, questRepository } from '@bike4mind/database';
import { publishPushNotification, sessionDeepLink } from '@server/utils/pushNotifications';
import { publishImageQuestReadyPush } from './generationPush';
import { dispatchQuestCallback } from '@bike4mind/server-utils/generationCallback/dispatchQuestCallback';
import { getImageEdit } from '@server/imageGenerations/imageEdit';

export const dispatch = dispatchWithLogger(async (event, context, logger) => {
  logger.debug('Starting image edit dispatch', {
    recordCount: event.Records.length,
    requestId: context.awsRequestId,
  });

  const body = JSON.parse(event.Records[0].body);
  try {
    await getImageEdit().process({ body, logger });
  } finally {
    // Also on a throw: process() may have written the terminal status before failing.
    await dispatchQuestCallback(body.questId, logger);
  }

  await publishImageQuestReadyPush(
    body,
    'edit',
    {
      connections: Connection,
      findQuest: questId => questRepository.findById(questId),
      sessionDeepLink,
      publish: event => publishPushNotification(event, logger),
    },
    logger
  );
});
