import { Logger } from '@bike4mind/observability';
import { IUserDocument, isImageServeable } from '@bike4mind/common';
import { Quest, Session } from '@bike4mind/database';
import { isValidObjectId } from '@server/utils/objectId';
import { isFeatureEnabled } from '@server/middlewares/featureFlag';
import { invokeMcpHandler } from '@server/utils/invokeMcpHandler';
import { getSelectedRepositoriesForMcp } from '@server/integrations/github/github-repo-helper';
import { GitHubResource, JiraResource, ConfluenceResource, TOKEN_EXPIRATION_MS } from '@bike4mind/slack';
import { JIRA_UPLOAD_ATTACHMENT, CONFLUENCE_UPLOAD_ATTACHMENT } from '@bike4mind/mcp/atlassian/constants';

export { TOKEN_EXPIRATION_MS };

/**
 * Atomically takes the pending action off the quest so exactly one confirm can execute it: two
 * concurrent clicks (or a click racing a retry) both read the action, but only one claim matches.
 * Matching on `ts` binds the claim to the action the caller read, not a newer one that replaced it.
 * Callers claim after their pre-execution checks and immediately before executing; the action is
 * consumed even if execution then fails.
 */
export async function claimPendingAction(questId: string, pendingActionTs: number): Promise<boolean> {
  const claimed = await Quest.findOneAndUpdate(
    { _id: questId, 'pendingAction.ts': pendingActionTs },
    { $unset: { pendingAction: 1 } }
  );
  return claimed !== null;
}

/**
 * Whether `userId` is the person whose request produced the quest's pending action. A Confirm/Cancel
 * button posted in a shared Slack channel is clickable by anyone there, so the click handler must
 * check this before acting. The requester is the turn's actor (promptMeta.session.userId), which can
 * differ from the session owner when a turn is routed into someone else's shared notebook; a quest
 * written before promptMeta existed falls back to the session owner, the rule the web executor
 * (pages/api/mcp/confirm.ts) applies.
 */
export async function isPendingActionRequester(questId: string, userId: string): Promise<boolean> {
  if (!isValidObjectId(questId)) return false;
  const quest = await Quest.findById(questId).select('sessionId promptMeta.session.userId');
  if (!quest) return false;
  const requesterId = quest.promptMeta?.session?.userId;
  if (requesterId) return requesterId === userId;
  if (!isValidObjectId(quest.sessionId)) return false;
  const session = await Session.findById(quest.sessionId).select('userId');
  return session?.userId?.toString() === userId;
}

export interface PendingActionResult {
  success: boolean;
  message: string;
}

export const MCP_DISABLED_MESSAGE = 'MCP integrations are turned off by your administrator.';

/**
 * Execute a pending action stored on a Quest.
 * Called only from the Slack Confirm button handler (interactive.ts); model output must never
 * reach this, since executing is what the human click authorizes.
 * `expectedTs` is the `ts` of the action the button displayed; undefined only for a button rendered
 * before it carried one. Keep in sync with the web executor (pages/api/mcp/confirm.ts).
 */
export async function executePendingAction(
  questId: string,
  dbUser: IUserDocument,
  logger: Logger,
  expectedTs?: number
): Promise<PendingActionResult> {
  // The flag gates tool loading, but an action created before an admin turned it off is still on the quest.
  if (!(await isFeatureEnabled('EnableMCPServer'))) {
    return { success: false, message: MCP_DISABLED_MESSAGE };
  }

  const questWithPending = await Quest.findById(questId);

  if (!questWithPending?.pendingAction) {
    return { success: false, message: 'No pending action found — it may have already been processed.' };
  }

  const pendingAction = questWithPending.pendingAction;

  if (expectedTs !== undefined && expectedTs !== pendingAction.ts) {
    logger.warn('[PendingActionExecutor] Pending action replaced since it was displayed', { questId });
    return { success: false, message: 'This action was replaced by a newer one. Please review it again.' };
  }

  if (pendingAction.ts && Date.now() - pendingAction.ts > TOKEN_EXPIRATION_MS) {
    logger.warn('[PendingActionExecutor] Pending action expired', {
      questId,
      tokenAgeMs: Date.now() - pendingAction.ts,
      maxAgeMs: TOKEN_EXPIRATION_MS,
    });
    await claimPendingAction(questId, pendingAction.ts);
    return { success: false, message: 'This action has expired. Please start the request again.' };
  }

  logger.info('[PendingActionExecutor] Executing pending action', {
    userId: dbUser.id,
    questId,
    tool: pendingAction.tool,
    paramsKeys: Object.keys(pendingAction.params || {}),
  });

  try {
    let resource: GitHubResource | JiraResource | ConfluenceResource;
    if (pendingAction.tool.startsWith('jira_')) {
      resource = new JiraResource(dbUser, logger);
    } else if (pendingAction.tool.startsWith('confluence_')) {
      resource = new ConfluenceResource(dbUser, logger);
    } else {
      resource = new GitHubResource(dbUser, logger);
    }

    const envVariables = await resource.getMcpEnvVariables();

    const mcpName =
      pendingAction.tool.startsWith('jira_') || pendingAction.tool.startsWith('confluence_') ? 'atlassian' : 'github';

    const selectedRepositories = await getSelectedRepositoriesForMcp(dbUser.id, mcpName);

    // Unescape newlines in body if present (AI sometimes generates escaped \n)
    const toolParams = { ...pendingAction.params };
    if (typeof toolParams.body === 'string') {
      toolParams.body = toolParams.body.replace(/\\n/g, '\n');
    }

    // Handle file uploads - fetch content from S3 (via fabFileId) or Slack URL
    const fabFileId = toolParams.fabFileId as string | undefined;
    const slackFileUrl = toolParams.slackFileUrl as string | undefined;
    const existingContent = toolParams.content as string | undefined;
    const hasContent = existingContent && typeof existingContent === 'string' && existingContent.length > 100;

    // Try to fetch from S3 using fabFileId (preferred)
    if (
      (pendingAction.tool === JIRA_UPLOAD_ATTACHMENT || pendingAction.tool === CONFLUENCE_UPLOAD_ATTACHMENT) &&
      fabFileId &&
      !hasContent
    ) {
      logger.info('[PendingActionExecutor] Fetching FAB file from S3', { fabFileId, filename: toolParams.filename });

      try {
        const { FabFile } = await import('@bike4mind/database');
        const { getFilesStorage } = await import('@server/utils/storage');

        const fabFile = await FabFile.findById(fabFileId);
        // Explicit skip before attempting the download, not a throw relying on the
        // surrounding try/catch: a thrown error here would be swallowed and fall through
        // to the slackFileUrl fallback, conflating "blocked image" with "download failed".
        if (fabFile && !isImageServeable(fabFile)) {
          logger.warn('[PendingActionExecutor] Skipping FAB file attachment: image not serveable', { fabFileId });
        } else if (fabFile?.filePath) {
          const fileBuffer = await getFilesStorage().download(fabFile.filePath);
          toolParams.content = fileBuffer.toString('base64');
          if (!toolParams.mimeType && fabFile.mimeType) {
            toolParams.mimeType = fabFile.mimeType;
          }
          logger.info('[PendingActionExecutor] Downloaded FAB file from S3', {
            fabFileId,
            filename: toolParams.filename,
            sizeBytes: fileBuffer.length,
            mimeType: toolParams.mimeType,
          });
        } else {
          logger.warn('[PendingActionExecutor] FAB file not found or has no filePath', { fabFileId });
        }
      } catch (fabError) {
        logger.error('[PendingActionExecutor] Failed to download FAB file from S3', {
          fabFileId,
          error: fabError instanceof Error ? fabError.message : String(fabError),
        });
      }
    }

    // Fallback to downloading from Slack URL
    const hasContentAfterFab =
      toolParams.content && typeof toolParams.content === 'string' && toolParams.content.length > 100;
    if (
      (pendingAction.tool === JIRA_UPLOAD_ATTACHMENT || pendingAction.tool === CONFLUENCE_UPLOAD_ATTACHMENT) &&
      slackFileUrl &&
      !hasContentAfterFab
    ) {
      logger.info('[PendingActionExecutor] Downloading Slack file for upload', {
        slackFileUrl: slackFileUrl.substring(0, 50) + '...',
        filename: toolParams.filename,
      });

      try {
        const response = await fetch(slackFileUrl);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        const arrayBuffer = await response.arrayBuffer();
        const fileBuffer = Buffer.from(arrayBuffer);
        toolParams.content = fileBuffer.toString('base64');
        logger.info('[PendingActionExecutor] Downloaded file from URL', {
          filename: toolParams.filename,
          sizeBytes: fileBuffer.length,
        });
      } catch (fileError) {
        logger.error('[PendingActionExecutor] Failed to download file', {
          error: fileError instanceof Error ? fileError.message : String(fileError),
        });
        return {
          success: false,
          message: `Failed to download file: ${fileError instanceof Error ? fileError.message : 'Unknown error'}`,
        };
      }
    }

    logger.info('[PendingActionExecutor] Executing MCP tool', {
      tool: pendingAction.tool,
      mcpName,
      selectedRepoCount: selectedRepositories?.length ?? 0,
    });

    // Claimed only once every pre-execution check has passed, so a fixable failure above leaves the
    // action in place for another click.
    if (!(await claimPendingAction(questId, pendingAction.ts))) {
      return { success: false, message: 'No pending action found \u2014 it may have already been processed.' };
    }

    const result = await invokeMcpHandler<unknown>({
      envVariables,
      name: mcpName,
      toolName: pendingAction.tool,
      toolArgs: { ...toolParams, _executeFromButton: true },
      action: 'callTool',
      selectedRepositories,
    });

    let resultData: Record<string, unknown> = {};
    if (typeof result === 'string') {
      try {
        resultData = JSON.parse(result);
      } catch {
        resultData = { message: result };
      }
    } else {
      resultData = result as Record<string, unknown>;
    }

    // Handle nested content structure from MCP
    const mcpIsError = resultData?.isError === true;
    const content = resultData?.content as Array<{ text?: string }> | undefined;
    if (content?.[0]?.text) {
      const rawText = content[0].text;
      try {
        resultData = JSON.parse(rawText);
      } catch {
        resultData = { message: rawText };
      }
    }

    const url = resultData?.url || resultData?.html_url || resultData?.link;
    const hasError =
      mcpIsError ||
      resultData?.error ||
      (typeof resultData?.message === 'string' && resultData.message.startsWith('Error:'));
    const isSuccess = !hasError && (url || resultData?.success !== false);

    logger.info('[PendingActionExecutor] MCP execution result', {
      success: isSuccess,
      url,
      hasError,
      mcpIsError,
      resultKeys: Object.keys(resultData || {}),
    });

    if (isSuccess) {
      const successMessage = buildSuccessMessage(pendingAction, resultData, url as string | undefined);
      return { success: true, message: successMessage };
    } else {
      return {
        success: false,
        message: `Failed: ${resultData?.error || resultData?.message || 'Unknown error'}`,
      };
    }
  } catch (error) {
    logger.error('[PendingActionExecutor] Execution failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      success: false,
      message: `Failed to execute: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Cancel a pending action on a Quest by clearing the pendingAction field.
 * With `expectedTs` (a Slack Cancel button) only that action is cleared, so a stale button cannot
 * clear a newer one; without it (the model's cancel tool, a legacy button) whatever is pending goes.
 */
export async function cancelPendingActionOnQuest(
  questId: string,
  logger: Logger,
  expectedTs?: number
): Promise<PendingActionResult> {
  if (expectedTs !== undefined) {
    if (!(await claimPendingAction(questId, expectedTs))) {
      return { success: false, message: 'This action was already processed or replaced by a newer one.' };
    }
    logger.info('[PendingActionExecutor] Cleared pendingAction on cancel', { questId, cleared: true });
    return { success: true, message: 'Cancelled. Let me know if you need anything else.' };
  }

  try {
    const result = await Quest.findByIdAndUpdate(questId, { $unset: { pendingAction: 1 } });
    logger.info('[PendingActionExecutor] Cleared pendingAction on cancel', {
      questId,
      cleared: !!result,
    });
  } catch (error) {
    logger.error('[PendingActionExecutor] Failed to clear pendingAction on cancel', {
      error: error instanceof Error ? error.message : String(error),
      questId,
    });
  }

  return { success: true, message: 'Cancelled. Let me know if you need anything else.' };
}

/**
 * Build a human-readable success message based on tool type and result data.
 */
function buildSuccessMessage(
  pendingAction: { tool: string; params: Record<string, unknown> },
  resultData: Record<string, unknown>,
  url: string | undefined
): string {
  const title = (resultData?.title || pendingAction.params?.title || '') as string;
  const issueNumber = resultData?.issue_number || resultData?.number;
  const jiraKey = resultData?.key as string | undefined;
  const confluencePageID = (resultData?.pageId || resultData?.id || pendingAction.params?.pageId || '') as string;

  let msg = '✅ ';

  if (pendingAction.tool === 'create_issue') {
    const repo =
      pendingAction.params?.owner && pendingAction.params?.repo
        ? `${pendingAction.params.owner}/${pendingAction.params.repo}`
        : '';
    msg += `Issue #${issueNumber} created`;
    if (repo) msg += ` in \`${repo}\``;
    if (title) msg += `\n"${title}"`;
  } else if (pendingAction.tool === 'update_issue') {
    const repo =
      pendingAction.params?.owner && pendingAction.params?.repo
        ? `${pendingAction.params.owner}/${pendingAction.params.repo}`
        : '';
    const action =
      pendingAction.params?.state === 'closed'
        ? 'closed'
        : pendingAction.params?.state === 'open'
          ? 'reopened'
          : 'updated';
    msg += `Issue #${issueNumber} ${action}`;
    if (repo) msg += ` in \`${repo}\``;
    if (title) msg += `\n"${title}"`;
  } else if (pendingAction.tool === 'jira_create_issue') {
    msg += jiraKey ? `Ticket ${jiraKey} created` : 'Ticket created';
    if (title) msg += `\n"${title}"`;
  } else if (
    pendingAction.tool === 'jira_update_issue' ||
    pendingAction.tool === 'jira_update_issue_transition' ||
    pendingAction.tool === 'jira_assign_issue'
  ) {
    const issueKey = (pendingAction.params?.issueKey || jiraKey) as string | undefined;
    msg += issueKey ? `Ticket ${issueKey} updated` : 'Ticket updated';
    if (title) msg += `\n"${title}"`;
  } else if (pendingAction.tool === 'jira_delete_issue') {
    const issueKey = (pendingAction.params?.issueKey || jiraKey) as string | undefined;
    msg += issueKey ? `Ticket ${issueKey} deleted` : 'Ticket deleted';
  } else if (pendingAction.tool === 'confluence_create_page') {
    msg += 'Page created';
    if (title) msg += `\n"${title}"`;
    if (confluencePageID) msg += `\nPage ID: ${confluencePageID}`;
  } else if (pendingAction.tool === 'confluence_update_page') {
    msg += 'Page updated';
    if (title) msg += `\n"${title}"`;
    if (confluencePageID) msg += `\nPage ID: ${confluencePageID}`;
  } else if (pendingAction.tool === 'confluence_delete_page') {
    const pageId = pendingAction.params?.pageId;
    msg += pageId ? `Page ${pageId} deleted` : 'Page deleted';
  } else if (pendingAction.tool === JIRA_UPLOAD_ATTACHMENT) {
    const issueKey = pendingAction.params?.issueKey;
    const attachment = resultData?.attachment as Record<string, unknown> | undefined;
    const filename = attachment?.filename || pendingAction.params?.filename;
    const sizeFormatted = (attachment?.sizeFormatted || '') as string;
    msg += `📎 Attachment uploaded to ${issueKey}`;
    if (filename) msg += `\n"${filename}"`;
    if (sizeFormatted) msg += ` (${sizeFormatted})`;
  } else if (pendingAction.tool === CONFLUENCE_UPLOAD_ATTACHMENT) {
    const pageId = pendingAction.params?.pageId;
    const attachment = resultData?.attachment as Record<string, unknown> | undefined;
    const filename = attachment?.filename || pendingAction.params?.filename;
    const sizeFormatted = (attachment?.sizeFormatted || '') as string;
    msg += `📎 Attachment uploaded to page ${pageId}`;
    if (filename) msg += `\n"${filename}"`;
    if (sizeFormatted) msg += ` (${sizeFormatted})`;
  } else {
    msg += 'Action completed';
    if (title) msg += `\n"${title}"`;
  }

  if (url) msg += `\n${url}`;

  return msg;
}
