import { Quest, Session } from '@bike4mind/database';
import { MCP_ACTION_REPLACED_ERROR_CODE } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import { assertMcpServerEnabled } from '@server/utils/mcpServerFlag';
import { isValidObjectId } from '@bike4mind/server-utils/utils/objectId';
import { invokeMcpHandler } from '@bike4mind/server-utils/utils/invokeMcpHandler';
import { claimPendingAction } from '@bike4mind/server-utils/utils/pendingActionExecutor';
import { loadFabFileAttachment, resolvePendingActionTarget } from '@bike4mind/server-utils/utils/pendingActionTarget';
import { assertCustomMcpEnabled } from '@bike4mind/server-utils/mcpConnections/customMcpAccess';
import { customMcpToolHost, isCustomToolStillOffered } from '@bike4mind/server-utils/mcpConnections/customMcpToolHost';
import { describeCustomCallFailure } from '@bike4mind/server-utils/mcpConnections/describeRemoteMcpError';
import { downloadAttachmentUrl } from '@bike4mind/server-utils/utils/downloadAttachmentUrl';
import { getSelectedRepositoriesForMcp } from '@bike4mind/server-utils/integrations/github/github-repo-helper';
import { JIRA_UPLOAD_ATTACHMENT, CONFLUENCE_UPLOAD_ATTACHMENT } from '@bike4mind/mcp/atlassian/constants';

// Token expiration time (15 minutes) - must match ChatCompletionProcess.ts
const TOKEN_EXPIRATION_MS = 15 * 60 * 1000;

type ActingUser = Parameters<typeof resolvePendingActionTarget>[1];

/**
 * `reason` names the lifecycle outcomes the public API reports as stable error codes; `not_found`
 * also covers a quest or session the caller does not own, so a foreign id is indistinguishable
 * from a missing one.
 */
export type PendingActionOutcome = {
  status: number;
  body: Record<string, unknown>;
  reason?: 'not_found' | 'replaced' | 'expired' | 'already_resolved';
};

/**
 * Confirms or cancels the MCP pending action on a quest on behalf of `user`. Shared by the web route
 * (POST /api/mcp/confirm) and the public approve/deny routes (/api/v1/pending-actions), so ownership,
 * replacement, expiry and claim-once checks cannot drift apart. The caller is authenticated by the
 * route; this authorizes it against the session's owner and trusts nothing else in the request.
 */
export async function resolveMcpPendingAction({
  user,
  questId,
  sessionId,
  confirmed,
  pendingActionTs,
  logger,
}: {
  user: ActingUser;
  questId: string;
  sessionId: string;
  confirmed: boolean;
  pendingActionTs: number;
  logger: Logger;
}): Promise<PendingActionOutcome> {
  const session = isValidObjectId(sessionId) ? await Session.findById(sessionId) : null;
  if (!session) {
    logger.error('[MCP Pending Action] Session not found', { sessionId });
    return { status: 404, body: { error: 'Session not found' }, reason: 'not_found' };
  }

  if (session.userId?.toString() !== user.id?.toString()) {
    logger.error('[MCP Pending Action] User mismatch - session belongs to different user', {
      sessionUserId: session.userId,
      requestUserId: user.id,
    });
    return { status: 403, body: { error: 'Unauthorized access to session' }, reason: 'not_found' };
  }

  const quest = isValidObjectId(questId) ? await Quest.findById(questId) : null;
  if (!quest) {
    logger.error('[MCP Pending Action] Quest not found', { questId });
    return { status: 404, body: { error: 'Quest not found' }, reason: 'not_found' };
  }

  if (quest.sessionId !== sessionId) {
    logger.error('[MCP Pending Action] Session mismatch', {
      questSessionId: quest.sessionId,
      requestSessionId: sessionId,
    });
    return { status: 403, body: { error: 'Unauthorized access to quest' }, reason: 'not_found' };
  }

  const pendingAction = quest.pendingAction;
  if (!pendingAction) {
    logger.warn('[MCP Pending Action] No pending action on quest', { questId });
    return { status: 400, body: { error: 'No pending action found' }, reason: 'already_resolved' };
  }

  // Checked before Cancel and expiry too, so a stale card can neither run nor clear a newer action.
  if (pendingActionTs !== pendingAction.ts) {
    logger.warn('[MCP Pending Action] Pending action replaced since it was displayed', { questId });
    return {
      status: 409,
      body: {
        error: 'This action was replaced by a newer one. Please review it again.',
        errorCode: MCP_ACTION_REPLACED_ERROR_CODE,
      },
      reason: 'replaced',
    };
  }

  if (pendingAction.ts && Date.now() - pendingAction.ts > TOKEN_EXPIRATION_MS) {
    logger.warn('[MCP Pending Action] Pending action expired', {
      questId,
      age: Date.now() - pendingAction.ts,
      maxAge: TOKEN_EXPIRATION_MS,
    });
    await claimPendingAction(questId, pendingAction.ts);
    return { status: 400, body: { error: 'This action has expired. Please request it again.' }, reason: 'expired' };
  }

  if (!confirmed) {
    if (!(await claimPendingAction(questId, pendingAction.ts))) {
      logger.warn('[MCP Pending Action] Pending action already claimed before cancel', { questId });
      return { status: 409, body: { error: 'This action has already been processed.' }, reason: 'already_resolved' };
    }
    logger.info('[MCP Pending Action] User cancelled action', { questId, tool: pendingAction.tool });
    return { status: 200, body: { success: true, message: 'Action cancelled' } };
  }

  // A custom connector action never reaches the built-in routing below. The host call re-checks policy
  // and passes `approved: true` because this click is the approval.
  if (pendingAction.customConnector) {
    const { connectionId, displayName } = pendingAction.customConnector;
    // Before the claim, so a disabled feature leaves the action in place.
    await assertCustomMcpEnabled(user);
    // Also before the claim: a connection or tool that is no longer usable would fail after the
    // action was consumed, and the user could not retry.
    if (!(await isCustomToolStillOffered(user.id, connectionId, pendingAction.tool))) {
      logger.warn('[MCP Pending Action] Custom connector tool is no longer available', { questId });
      return { status: 409, body: { error: `${displayName} no longer offers this action.` } };
    }
    if (!(await claimPendingAction(questId, pendingAction.ts))) {
      logger.warn('[MCP Pending Action] Pending action already claimed', { questId });
      return { status: 409, body: { error: 'This action has already been processed.' }, reason: 'already_resolved' };
    }
    try {
      const { result } = await customMcpToolHost.callTool({
        connectionId,
        userId: user.id,
        toolName: pendingAction.tool,
        args: pendingAction.params,
        approved: true,
      });
      return {
        status: 200,
        body: result.isError
          ? { success: false, message: `${displayName} reported an error running ${pendingAction.tool}` }
          : { success: true, message: `${displayName}: ${pendingAction.tool} completed` },
      };
    } catch (error) {
      logger.error('[MCP Pending Action] Custom connector call failed', {
        tool: pendingAction.tool,
        error: error instanceof Error ? error.message : String(error),
      });
      // Never the server's own text: describeCustomCallFailure maps to fixed lines.
      return { status: 200, body: { success: false, message: describeCustomCallFailure(error) } };
    }
  }

  // After the cancel branch: cancelling executes nothing, so it stays available with the flag off.
  await assertMcpServerEnabled();

  // Keep in sync with executePendingAction (packages/server-utils/src/utils/pendingActionExecutor.ts), the Slack
  // executor: same routing and file loading (pendingActionTarget.ts), expiry and claim-before-invoke
  // ordering. Only this route checks the selected repositories before invoking.
  const target = resolvePendingActionTarget(pendingAction.tool, user, logger);
  if (!target) {
    logger.warn('[MCP Pending Action] Refusing a pending action for a non-confirmable tool', {
      questId,
      tool: pendingAction.tool,
    });
    return { status: 400, body: { error: 'This action cannot be confirmed.' } };
  }
  const { mcpName, resource } = target;

  try {
    const envVariables = await resource.getMcpEnvVariables();

    // Get selected repositories for GitHub security filtering
    const selectedRepositories = await getSelectedRepositoriesForMcp(user.id, mcpName);

    // Unescape newlines in body if present (AI sometimes generates escaped \n)
    const toolParams = { ...pendingAction.params };
    if (typeof toolParams.body === 'string') {
      toolParams.body = (toolParams.body as string).replace(/\\n/g, '\n');
    }

    // For GitHub tools: verify the repo is in the user's configured repos
    if (mcpName === 'github' && selectedRepositories?.length && toolParams.owner && toolParams.repo) {
      const aiExtractedRepo = `${toolParams.owner}/${toolParams.repo}`;
      // GitHub full names are case-insensitive, and the server guard matches them that way.
      const isSelected = selectedRepositories.some(
        (repo: string) => repo.toLowerCase() === aiExtractedRepo.toLowerCase()
      );

      if (!isSelected) {
        logger.warn('[MCP Pending Action] Repository not in configured repos', {
          aiExtractedRepo,
          availableRepos: selectedRepositories,
        });
        return {
          status: 400,
          body: {
            success: false,
            error: `Repository "${aiExtractedRepo}" is not enabled. Available: ${selectedRepositories.join(', ')}`,
          },
        };
      }
    }

    // Handle file uploads - fetch content from S3 (via fabFileId) before calling MCP tool
    const fabFileId = toolParams.fabFileId as string | undefined;
    const existingContent = toolParams.content as string | undefined;
    const hasContent = existingContent && typeof existingContent === 'string' && existingContent.length > 100;

    if (
      (pendingAction.tool === JIRA_UPLOAD_ATTACHMENT || pendingAction.tool === CONFLUENCE_UPLOAD_ATTACHMENT) &&
      fabFileId &&
      !hasContent
    ) {
      const attachment = await loadFabFileAttachment(fabFileId, user, logger);
      if (attachment.status === 'forbidden') {
        return {
          status: 403,
          body: { success: false, error: 'The file to attach was not found or you do not have access to it.' },
        };
      }
      if (attachment.status === 'loaded') {
        toolParams.content = attachment.content;
        if (!toolParams.mimeType && attachment.mimeType) {
          toolParams.mimeType = attachment.mimeType;
        }
      }
    }

    // Fallback: download slackFileUrl (an LLM-supplied tool arg) if content is still empty. It goes
    // through the SSRF guard, so a private-address URL (e.g. self-host object storage) is refused;
    // fabFileId above is the path for files already in our storage.
    const slackFileUrl = toolParams.slackFileUrl as string | undefined;
    const hasContentAfterFab =
      toolParams.content && typeof toolParams.content === 'string' && (toolParams.content as string).length > 100;
    if (
      (pendingAction.tool === JIRA_UPLOAD_ATTACHMENT || pendingAction.tool === CONFLUENCE_UPLOAD_ATTACHMENT) &&
      slackFileUrl &&
      !hasContentAfterFab
    ) {
      logger.info('[MCP Pending Action] Downloading file from URL', {
        url: slackFileUrl.substring(0, 80) + '...',
        filename: toolParams.filename,
      });

      try {
        const fileBuffer = await downloadAttachmentUrl(slackFileUrl);
        toolParams.content = fileBuffer.toString('base64');
        logger.info('[MCP Pending Action] Downloaded file from URL', {
          filename: toolParams.filename,
          sizeBytes: fileBuffer.length,
        });
      } catch (urlError) {
        logger.error('[MCP Pending Action] Failed to download file from URL', {
          error: urlError instanceof Error ? urlError.message : String(urlError),
        });
        // Return before claiming so the action stays for a retry, matching the Slack executor. The
        // message is generic: the guard's detail (e.g. what a hostname resolved to) is logged above.
        return { status: 502, body: { success: false, error: 'Failed to download file' } };
      }
    }

    logger.info('[MCP Pending Action] Executing MCP tool', {
      tool: pendingAction.tool,
      mcpName,
      selectedRepoCount: selectedRepositories?.length ?? 0,
    });

    // Claimed only once every pre-execution check has passed, so a fixable failure above (e.g. a
    // repo not yet selected) leaves the action in place for another click.
    if (!(await claimPendingAction(questId, pendingAction.ts))) {
      logger.warn('[MCP Pending Action] Pending action already claimed', { questId });
      return { status: 409, body: { error: 'This action has already been processed.' }, reason: 'already_resolved' };
    }

    // Execute the tool with _executeFromButton flag for security
    const result = await invokeMcpHandler<any>({
      envVariables,
      name: mcpName,
      toolName: pendingAction.tool,
      toolArgs: { ...toolParams, _executeFromButton: true },
      action: 'callTool',
      selectedRepositories,
      userId: user.id,
    });

    let resultData: any = result;
    const mcpIsError = resultData?.isError === true;
    if (typeof result === 'string') {
      try {
        resultData = JSON.parse(result);
      } catch {
        resultData = { message: result };
      }
    }

    // Handle nested content structure from MCP
    if (resultData?.content?.[0]?.text) {
      try {
        resultData = JSON.parse(resultData.content[0].text);
      } catch {
        resultData = { message: resultData.content[0].text };
      }
    }

    // GitHub returns url/html_url, Jira returns link
    const url = resultData?.url || resultData?.html_url || resultData?.link;
    const hasError =
      mcpIsError ||
      resultData?.error ||
      (typeof resultData?.message === 'string' && resultData.message.startsWith('Error:'));
    const success = !hasError && (url || resultData?.success !== false);

    logger.info('[MCP Pending Action] MCP execution result', {
      success,
      url,
      hasError: !!hasError,
    });

    if (success) {
      // Build success message based on tool type
      const title = resultData?.title || (pendingAction.params?.title as string) || '';
      const issueNumber = resultData?.issue_number || resultData?.number;
      const jiraKey = resultData?.key;

      let message = '';
      if (pendingAction.tool === 'create_issue') {
        const repo =
          pendingAction.params?.owner && pendingAction.params?.repo
            ? `${pendingAction.params.owner}/${pendingAction.params.repo}`
            : '';
        message = `Issue #${issueNumber} created${repo ? ` in ${repo}` : ''}`;
        if (title) message += `: "${title}"`;
      } else if (pendingAction.tool === 'jira_create_issue') {
        message = `Jira issue ${jiraKey} created`;
        if (title) message += `: "${title}"`;
      } else if (pendingAction.tool === 'confluence_create_page') {
        message = `Confluence page created`;
        if (title) message += `: "${title}"`;
      } else if (pendingAction.tool === 'jira_bulk_create_issues') {
        const created = Number(resultData?.created) || 0;
        const failed = Number(resultData?.failed) || 0;
        message = `Created ${created} of ${created + failed} Jira issues`;
        if (failed > 0) message += `; ${failed} failed`;
      } else {
        message = `Action completed successfully`;
      }

      return {
        status: 200,
        body: {
          success: true,
          message,
          url,
        },
      };
    } else {
      const bulkFailed = Number(resultData?.failed) || 0;
      const bulkMessage =
        pendingAction.tool === 'jira_bulk_create_issues' && bulkFailed > 0
          ? `No Jira issues were created; ${bulkFailed} failed`
          : undefined;
      return {
        status: 200,
        body: {
          success: false,
          message: bulkMessage || resultData?.error || resultData?.message || 'Action failed',
        },
      };
    }
  } catch (error: any) {
    logger.error('[MCP Pending Action] Execution failed', {
      error: error.message,
      stack: error.stack,
    });
    return {
      status: 500,
      body: {
        success: false,
        error: error.message || 'Failed to execute action',
      },
    };
  }
}
