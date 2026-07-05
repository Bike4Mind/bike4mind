import { withEventContext } from '@server/events/utils';
import { NotebookCurationEvents } from '@server/utils/eventBus';
import { Session, User } from '@bike4mind/database';
import { sendToQueue } from '@server/utils/sqs';
import { Resource } from 'sst';

export const handler = withEventContext(async (event, logger) => {
  const {
    sessionId,
    userId,
    curationJobId,
    batchJobId,
    batchIndex,
    batchTotal,
    curationType,
    artifactTypes,
    exportFormat,
    customNotebookName,
  } = NotebookCurationEvents.Start.schema.parse(event.properties);

  logger.updateMetadata({
    sessionId,
    userId,
    curationJobId,
    batchJobId: batchJobId || 'none',
    batchIndex: batchIndex ?? -1,
    batchTotal: batchTotal ?? 1,
    curationType: curationType || 'transcript',
    artifactTypes: artifactTypes || 'all',
    exportFormat: exportFormat || 'markdown',
    customNotebookName: customNotebookName || 'default',
  });

  const batchInfo = batchJobId ? ` [Batch ${batchIndex! + 1}/${batchTotal}]` : '';
  logger.info(
    `Processing notebook curation start event for session ${sessionId}${batchInfo} (type: ${curationType || 'transcript'}, artifacts: ${artifactTypes && artifactTypes.length > 0 ? artifactTypes.join(', ') : 'all'}, format: ${exportFormat || 'markdown'})`
  );

  try {
    const session = await Session.findById(sessionId);
    if (!session) {
      logger.warn(`Session ${sessionId} not found`);
      return;
    }

    const user = await User.findById(userId ?? session.userId);
    if (!user) {
      logger.error(`User not found`);
      return;
    }

    const queueUrl = Resource.notebookCurationQueue?.url;
    if (!queueUrl) throw new Error('Curation queue URL not found');

    const messageId = await sendToQueue(queueUrl, {
      sessionId,
      userId: userId ?? session.userId,
      curationJobId,
      batchJobId,
      batchIndex,
      batchTotal,
      curationType,
      artifactTypes,
      exportFormat,
      customNotebookName,
    });

    logger.info(`Successfully queued notebook curation for session ${sessionId}, messageId: ${messageId}`);
  } catch (error) {
    logger.error(`Failed to queue notebook curation for ${sessionId}:`, error);

    try {
      await NotebookCurationEvents.Error.publish({
        curationJobId,
        sessionId,
        userId,
        error: error instanceof Error ? error.message : 'Unknown error',
        stage: 'loading',
      });
    } catch (publishError) {
      logger.error('Failed to publish error event:', publishError);
    }

    throw error;
  }
});
