import { dispatchWithLogger } from '@bike4mind/server-utils/queueHandlers/utils';
import { dispatchQuestCallback } from '@bike4mind/server-utils/generationCallback/dispatchQuestCallback';
import { getImageGeneration } from '@server/imageGenerations/imageGeneration';

export const dispatch = dispatchWithLogger(async (event, context, logger) => {
  logger.debug('Starting image generation dispatch', {
    recordCount: event.Records.length,
    requestId: context.awsRequestId,
  });

  const body = JSON.parse(event.Records[0].body);
  try {
    await getImageGeneration().process({ body, logger });
  } finally {
    // Also on a throw: process() may have written the terminal status before failing.
    await dispatchQuestCallback(body.questId, logger);
  }
});
