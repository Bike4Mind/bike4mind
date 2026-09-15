import { withEventContext } from '@server/events/utils';
import { NotebookCurationEvents } from '@server/utils/eventBus';
import { FabFile } from '@bike4mind/database';
import { logEvent } from '@server/utils/analyticsLog';
import { CurationEvents } from '@bike4mind/common';

/**
 * Event handler that logs analytics when a notebook curation is completed
 */
export const handler = withEventContext(async (event, logger) => {
  const {
    sessionId,
    userId,
    curationJobId,
    curatedFileId,
    artifactCount,
    messageCount,
    tokensProcessed,
    curationType,
    exportFormat,
    artifactTypes,
  } = NotebookCurationEvents.Complete.schema.parse(event.properties);

  logger.updateMetadata({
    sessionId,
    userId,
    curationJobId,
    curatedFileId,
    artifactCount,
    messageCount,
    tokensProcessed,
    curationType,
    exportFormat,
    artifactTypes,
  });

  logger.info(
    `Logging analytics for completed notebook curation: session ${sessionId}, type: ${curationType || 'transcript'}, format: ${exportFormat || 'markdown'}, artifacts: ${artifactCount}, messages: ${messageCount}`
  );

  logger.info('DEBUG: Event values received:', {
    curationType,
    exportFormat,
    curationType_type: typeof curationType,
    exportFormat_type: typeof exportFormat,
    curationType_isUndefined: curationType === undefined,
    exportFormat_isUndefined: exportFormat === undefined,
  });

  try {
    const curatedFile = await FabFile.findById(curatedFileId);

    if (!curatedFile) {
      logger.warn(`Curated file ${curatedFileId} not found, logging analytics without file metadata`);
    }

    const fileName = curatedFile?.fileName || '';
    const mimeType = curatedFile?.mimeType || '';
    const fileSize = curatedFile?.fileSize || 0;

    // Determine file extension from the export format or filename
    let fileExtension = '';
    const actualExportFormat = exportFormat || 'markdown';
    const actualCurationType = curationType || 'transcript';

    logger.info('DEBUG: Actual values after defaulting:', {
      actualCurationType,
      actualExportFormat,
      fileName,
      mimeType,
    });

    if (fileName) {
      if (fileName.endsWith('.md')) {
        fileExtension = 'md';
      } else if (fileName.endsWith('.txt')) {
        fileExtension = 'txt';
      } else if (fileName.endsWith('.html')) {
        fileExtension = 'html';
      }
    }

    // Fallback to export format if we couldn't determine from filename
    if (!fileExtension) {
      if (actualExportFormat === 'markdown') {
        fileExtension = 'md';
      } else if (actualExportFormat === 'txt') {
        fileExtension = 'txt';
      } else if (actualExportFormat === 'html') {
        fileExtension = 'html';
      }
    }

    await logEvent({
      type: CurationEvents.NOTEBOOK_CURATED,
      userId,
      counterValue: 1,
      metadata: {
        sessionId,
        curationJobId,
        curatedFileId,
        curationType: actualCurationType,
        exportFormat: actualExportFormat,
        artifactCount,
        messageCount,
        tokensProcessed,
        artifactTypes,
        fileExtension,
        mimeType,
        fileSize,
        fileName,
      },
    });

    logger.info(
      `Successfully logged curation analytics: type=${actualCurationType}, format=${actualExportFormat}, artifacts=${artifactCount}`
    );
  } catch (error) {
    logger.error(`Failed to log curation analytics for session ${sessionId}:`, error);
    // Don't throw - we don't want to fail the curation process if analytics logging fails
  }
});
