import { Logger } from '@bike4mind/observability';
import { IUserDocument, isImageServeable } from '@bike4mind/common';
import { fabFileRepository } from '@bike4mind/database';
import { ConfluenceResource, GitHubResource, JiraResource } from '@bike4mind/slack';
import { ATLASSIAN_CONFIRMABLE_TOOLS } from '@bike4mind/mcp/atlassian/constants';
import { GITHUB_CONFIRMABLE_TOOLS } from '@bike4mind/mcp/github/constants';
import { getFilesStorage } from '@server/utils/storage';

/**
 * Shared by the two pending-action executors - the web confirm route (pages/api/mcp/confirm.ts) and
 * the Slack Confirm button (executePendingAction) - so they route and load files identically.
 */

export type PendingActionTarget = {
  mcpName: 'github' | 'atlassian';
  resource: GitHubResource | JiraResource | ConfluenceResource;
};

/**
 * The MCP server and credentials a pending action executes against, or null when the tool is not a
 * confirmable write tool. A pending action's tool name is data, so only an allowlisted name may run.
 */
export function resolvePendingActionTarget(
  tool: string,
  user: IUserDocument,
  logger: Logger
): PendingActionTarget | null {
  if (GITHUB_CONFIRMABLE_TOOLS.has(tool)) {
    return { mcpName: 'github', resource: new GitHubResource(user, logger) };
  }
  if (ATLASSIAN_CONFIRMABLE_TOOLS.has(tool)) {
    const resource = tool.startsWith('jira_') ? new JiraResource(user, logger) : new ConfluenceResource(user, logger);
    return { mcpName: 'atlassian', resource };
  }
  return null;
}

export type FabFileAttachment =
  { status: 'loaded'; content: string; mimeType?: string } | { status: 'unavailable' } | { status: 'forbidden' };

/**
 * Loads a stored file for an attachment upload, scoped to what `user` may read. `forbidden` means the
 * id does not resolve to a file the user can access (missing and not-shared look the same on
 * purpose) and the upload must be refused, even when a `slackFileUrl` fallback exists: a stale or
 * malformed id fails closed rather than silently swapping the source. `unavailable` means the file is the user's but has no
 * serveable bytes (held/blocked image, no stored path, download failure); the caller may fall back
 * to another source.
 */
export async function loadFabFileAttachment(
  fabFileId: string,
  user: IUserDocument,
  logger: Logger
): Promise<FabFileAttachment> {
  const fabFile = await fabFileRepository.shareable.findAccessibleById(user, fabFileId);
  if (!fabFile) {
    logger.warn('[PendingAction] FAB file not accessible to the confirming user', { fabFileId, userId: user.id });
    return { status: 'forbidden' };
  }
  if (!isImageServeable(fabFile)) {
    logger.warn('[PendingAction] Skipping FAB file attachment: image not serveable', { fabFileId });
    return { status: 'unavailable' };
  }
  if (!fabFile.filePath) {
    logger.warn('[PendingAction] FAB file has no filePath', { fabFileId });
    return { status: 'unavailable' };
  }

  try {
    const fileBuffer = await getFilesStorage().download(fabFile.filePath);
    logger.info('[PendingAction] Downloaded FAB file from storage', { fabFileId, sizeBytes: fileBuffer.length });
    return { status: 'loaded', content: fileBuffer.toString('base64'), mimeType: fabFile.mimeType };
  } catch (error) {
    logger.error('[PendingAction] Failed to download FAB file from storage', {
      fabFileId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { status: 'unavailable' };
  }
}
