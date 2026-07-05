import { IFabFileDocument } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { getSlackDb } from '../di/registry';

/**
 * List curated files for a user.
 *
 * Extracted from InternalResource.handleListIntent so it can be invoked
 * as a standalone tool by the LLM via the system prompt.
 */

export interface ListCuratedFilesParams {
  userId: string;
  limit?: number;
  fileName?: string;
}

export interface ListCuratedFilesResult {
  success: boolean;
  message: string;
  files?: IFabFileDocument[];
}

/**
 * Search curated files from the database
 */
export async function getCuratedFiles(
  userId: string,
  options?: { limit?: number; fileName?: string },
  logger?: Logger
): Promise<IFabFileDocument[]> {
  const limit = options?.limit || 5;
  const fileName = options?.fileName || '';

  const { fabFileRepository } = getSlackDb();
  const result = await fabFileRepository.search(
    userId,
    fileName,
    { curated: true },
    { page: 1, limit },
    { by: 'createdAt', direction: 'desc' }
  );

  logger?.info('Retrieved curated files', {
    userId,
    count: result.data?.length || 0,
  });

  return result.data || [];
}

/**
 * List curated files and return a formatted Slack message.
 */
export async function listCuratedFiles(params: ListCuratedFilesParams): Promise<ListCuratedFilesResult> {
  const { userId, limit = 5 } = params;

  const files = await getCuratedFiles(userId, { limit });

  if (!files || files.length === 0) {
    return {
      success: false,
      message: '📚 No curated files found. Curate a notebook in the app first!',
    };
  }

  const fileList = files
    .map((file, index) => {
      const createdDate = file.createdAt ? new Date(file.createdAt).toLocaleDateString() : 'Unknown';
      const fileSizeKB = file.fileSize ? (file.fileSize / 1024).toFixed(1) : '?';
      return `${index + 1}. ${createdDate} (${fileSizeKB} KB) - ${file.fileName}`;
    })
    .join('\n');

  return {
    success: true,
    message: `📚 *Your ${files.length} Most Recent Curated Files:*\n\n${fileList}\n\n💡 *To share:* \`@agent share ${files[0].fileName}\``,
    files,
  };
}
