import { IFabFileDocument, isImageServeable } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { getSlackDeps } from '../di/registry';
import { getCuratedFiles } from './listCuratedFiles';
import { SlackClient } from '../SlackClient';

/**
 * Share a curated file to a Slack channel.
 *
 * Extracted from InternalResource.handleShareIntent so it can be invoked
 * as a standalone tool by the LLM via the system prompt.
 */

export interface ShareCuratedFileParams {
  userId: string;
  fileName?: string;
  channel: string;
  threadTs?: string;
  slackClient: SlackClient;
  logger: Logger;
}

export interface ShareCuratedFileResult {
  success: boolean;
  message: string;
  data?: { fileId?: string; presignedUrl?: string };
  /** When multiple matches are found, the formatted list of matches */
  matchList?: string;
}

const SMALL_FILE_THRESHOLD = 10 * 1024 * 1024; // 10 MB

/**
 * Download file content from storage
 */
async function getFileContent(filePath: string, logger: Logger): Promise<Buffer> {
  const { storage } = getSlackDeps();
  const content = await storage.filesStorage.download(filePath);
  logger.info('File content downloaded', { filePath, sizeBytes: content.length });
  return content;
}

/**
 * Generate a presigned URL for downloading a file
 */
async function getPresignedUrl(filePath: string, fileName?: string): Promise<string> {
  const { storage } = getSlackDeps();
  return storage.filesStorage.getSignedUrl(filePath, 'get', {
    expiresIn: 604800, // 7 days
    ResponseContentDisposition: fileName ? `attachment; filename="${fileName}"` : undefined,
  });
}

/**
 * Find a curated file by name or get the latest one.
 */
async function findFile(
  userId: string,
  fileName?: string,
  logger?: Logger
): Promise<{ file: IFabFileDocument | null; matchList?: string }> {
  if (fileName) {
    const files = await getCuratedFiles(userId, { fileName, limit: 5 }, logger);

    if (!files || files.length === 0) {
      return { file: null };
    }

    let matchList: string | undefined;
    if (files.length > 1) {
      matchList = files
        .map((f, i) => {
          const createdDate = f.createdAt ? new Date(f.createdAt).toLocaleDateString() : 'Unknown';
          return `${i + 1}. *${f.fileName}* - ${createdDate}`;
        })
        .join('\n');
    }

    return { file: files[0], matchList };
  }

  // Get latest curated file
  const files = await getCuratedFiles(userId, { limit: 1 }, logger);
  return { file: files.length > 0 ? files[0] : null };
}

/**
 * Share a curated file to Slack - either by direct upload (small files)
 * or via a presigned download link (large files).
 */
export async function shareCuratedFile(params: ShareCuratedFileParams): Promise<ShareCuratedFileResult> {
  const { userId, fileName, channel, threadTs, slackClient, logger } = params;

  try {
    const { file: fabFile, matchList } = await findFile(userId, fileName, logger);

    if (!fabFile) {
      const hint = fileName
        ? `❌ No curated file found matching "${fileName}". Try \`@agent list files\` to see available files.`
        : '❌ No curated files found. Please curate a notebook in the app first.';
      return { success: false, message: hint };
    }

    if (!fabFile.filePath) {
      return { success: false, message: '❌ Curated file not found.' };
    }

    // Refuse to download/share a held/blocked uploaded image.
    if (!isImageServeable(fabFile)) {
      return { success: false, message: '❌ This file is not available right now.' };
    }

    // Show match disambiguation if multiple results
    if (matchList) {
      return {
        success: true,
        message: `🔍 Found multiple files matching "${fileName}":\n\n${matchList}\n\n💡 Please be more specific, or I'll share the most recent one: "${fabFile.fileName}"`,
        matchList,
      };
    }

    const fileContent = await getFileContent(fabFile.filePath, logger);
    const actualFileName = fabFile.fileName;
    const fileSizeMB = fileContent.length / 1024 / 1024;

    // Small file: Upload directly to Slack
    if (fileContent.length < SMALL_FILE_THRESHOLD) {
      logger.info('Uploading file directly to Slack', {
        fileName: actualFileName,
        fileSizeMB: fileSizeMB.toFixed(2),
      });

      const uploadResult = await slackClient.uploadFile({
        channel,
        filename: actualFileName,
        content: fileContent,
        threadTs,
        initialComment: `📔 *${actualFileName}* (${fileSizeMB.toFixed(1)} MB)`,
      });

      if (uploadResult.success) {
        return {
          success: true,
          message: 'File uploaded',
          data: { fileId: uploadResult.fileId },
        };
      }
      return { success: false, message: '❌ Failed to upload file to Slack' };
    }

    // Large file: Generate presigned URL
    logger.info('File too large, generating presigned URL', {
      fileName: actualFileName,
      fileSizeMB: fileSizeMB.toFixed(2),
    });

    const presignedUrl = await getPresignedUrl(fabFile.filePath, actualFileName);
    const expiresAt = new Date(Date.now() + 604800 * 1000).toLocaleDateString();

    return {
      success: true,
      message:
        `📔 *${actualFileName}* (${fileSizeMB.toFixed(1)} MB)\n` +
        `File is too large for direct upload.\n` +
        `🔗 <${presignedUrl}|Download File>\n` +
        `⏰ Link expires on ${expiresAt}`,
      data: { presignedUrl },
    };
  } catch (error) {
    logger.error('Failed to share curated file', { error, userId });
    return { success: false, message: '❌ Sorry, I encountered an error sharing your file.' };
  }
}
