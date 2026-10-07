import { dispatchWithLogger } from '@server/queueHandlers/utils';
import { dispatchQuestCallback } from '@server/generationCallback/dispatchQuestCallback';
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
});
