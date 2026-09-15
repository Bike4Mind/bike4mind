import { initializeSlackPackage } from '@server/integrations/slack/slackPackageInit';
initializeSlackPackage();

import { z } from 'zod';
import { Quest, Session } from '@bike4mind/database';
import { isImageServeable } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { baseApi } from '@server/middlewares/baseApi';
import { invokeMcpHandler } from '@server/utils/invokeMcpHandler';
import { GitHubResource } from '@bike4mind/slack';
import { JiraResource } from '@bike4mind/slack';
import { ConfluenceResource } from '@bike4mind/slack';
import { getSelectedRepositoriesForMcp } from '@server/integrations/github/github-repo-helper';
import { JIRA_UPLOAD_ATTACHMENT, CONFLUENCE_UPLOAD_ATTACHMENT } from '@bike4mind/mcp/atlassian/constants';

// Token expiration time (15 minutes) - must match ChatCompletionProcess.ts
const TOKEN_EXPIRATION_MS = 15 * 60 * 1000;

const ConfirmRequestSchema = z.object({
  questId: z.string(),
  sessionId: z.string(),
  confirmed: z.boolean(),
});

/**
 * POST /api/mcp/confirm
 *
 * Handles web confirmation button clicks for MCP tool execution.
 * When user clicks Confirm or Cancel on a pending MCP action (e.g., GitHub issue creation).
 */
const handler = baseApi().post(async (req, res) => {
  const logger = new Logger({ metadata: { component: 'web-mcp-confirm' } });

  const parsed = ConfirmRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    logger.error('[Web MCP Confirm] Invalid request body', { error: parsed.error });
    return res.status(400).json({ error: 'Invalid request body' });
  }

  const { questId, sessionId, confirmed } = parsed.data;
  const user = req.user;

  if (!user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  logger.info('[Web MCP Confirm] Processing confirmation', {
    questId,
    sessionId,
    confirmed,
    userId: user.id,
  });

  const session = await Session.findById(sessionId);
  if (!session) {
    logger.error('[Web MCP Confirm] Session not found', { sessionId });
    return res.status(404).json({ error: 'Session not found' });
  }

  if (session.userId?.toString() !== user.id?.toString()) {
    logger.error('[Web MCP Confirm] User mismatch - session belongs to different user', {
      sessionUserId: session.userId,
      requestUserId: user.id,
    });
    return res.status(403).json({ error: 'Unauthorized access to session' });
  }

  const quest = await Quest.findById(questId);
  if (!quest) {
    logger.error('[Web MCP Confirm] Quest not found', { questId });
    return res.status(404).json({ error: 'Quest not found' });
  }

  if (quest.sessionId !== sessionId) {
    logger.error('[Web MCP Confirm] Session mismatch', {
      questSessionId: quest.sessionId,
      requestSessionId: sessionId,
    });
    return res.status(403).json({ error: 'Unauthorized access to quest' });
  }

  const pendingAction = quest.pendingAction;
  if (!pendingAction) {
    logger.warn('[Web MCP Confirm] No pending action on quest', { questId });
    return res.status(400).json({ error: 'No pending action found' });
  }

  if (pendingAction.ts && Date.now() - pendingAction.ts > TOKEN_EXPIRATION_MS) {
    logger.warn('[Web MCP Confirm] Pending action expired', {
      questId,
      age: Date.now() - pendingAction.ts,
      maxAge: TOKEN_EXPIRATION_MS,
    });
    await Quest.findByIdAndUpdate(questId, { $unset: { pendingAction: 1 } });
    return res.status(400).json({ error: 'This action has expired. Please request it again.' });
  }

  if (!confirmed) {
    logger.info('[Web MCP Confirm] User cancelled action', { questId, tool: pendingAction.tool });
    await Quest.findByIdAndUpdate(questId, { $unset: { pendingAction: 1 } });
    return res.status(200).json({ success: true, message: 'Action cancelled' });
  }

  // Execute the MCP tool
  try {
    let resource: GitHubResource | JiraResource | ConfluenceResource;
    if (pendingAction.tool.startsWith('jira_')) {
      resource = new JiraResource(user, logger);
    } else if (pendingAction.tool.startsWith('confluence_')) {
      resource = new ConfluenceResource(user, logger);
    } else {
      resource = new GitHubResource(user, logger);
    }

    const envVariables = await resource.getMcpEnvVariables();

    const mcpName =
      pendingAction.tool.startsWith('jira_') || pendingAction.tool.startsWith('confluence_') ? 'atlassian' : 'github';

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

      if (!selectedRepositories.includes(aiExtractedRepo)) {
        logger.warn('[Web MCP Confirm] Repository not in configured repos', {
          aiExtractedRepo,
          availableRepos: selectedRepositories,
        });
        return res.status(400).json({
          success: false,
          error: `Repository "${aiExtractedRepo}" is not enabled. Available: ${selectedRepositories.join(', ')}`,
        });
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
      logger.info('[Web MCP Confirm] Fetching FAB file from S3', { fabFileId, filename: toolParams.filename });

      try {
        const { FabFile } = await import('@bike4mind/database');
        const { getFilesStorage } = await import('@server/utils/storage');

        const fabFile = await FabFile.findById(fabFileId);
        // Explicit skip before attempting the download, not a throw relying on the
        // surrounding try/catch: a thrown error here gets swallowed by the catch below,
        // which then falls through to the slackFileUrl fallback only because that catch
        // doesn't distinguish "blocked image" from "download failed" - safe only because
        // slackFileUrl points at a distinct resource. This if/else-if makes the skip a
        // first-class branch instead of an exception-handling coincidence.
        if (fabFile && !isImageServeable(fabFile)) {
          logger.warn('[Web MCP Confirm] Skipping FAB file attachment: image not serveable', { fabFileId });
        } else if (fabFile?.filePath) {
          const fileBuffer = await getFilesStorage().download(fabFile.filePath);
          toolParams.content = fileBuffer.toString('base64');
          if (!toolParams.mimeType && fabFile.mimeType) {
            toolParams.mimeType = fabFile.mimeType;
          }
          logger.info('[Web MCP Confirm] Downloaded FAB file from S3', {
            fabFileId,
            filename: toolParams.filename,
            sizeBytes: fileBuffer.length,
          });
        } else {
          logger.warn('[Web MCP Confirm] FAB file not found or has no filePath', { fabFileId });
        }
      } catch (fabError) {
        logger.error('[Web MCP Confirm] Failed to download FAB file from S3', {
          fabFileId,
          error: fabError instanceof Error ? fabError.message : String(fabError),
        });
      }
    }

    // Fallback: download from slackFileUrl (S3 presigned URL) if content is still empty
    const slackFileUrl = toolParams.slackFileUrl as string | undefined;
    const hasContentAfterFab =
      toolParams.content && typeof toolParams.content === 'string' && (toolParams.content as string).length > 100;
    if (
      (pendingAction.tool === JIRA_UPLOAD_ATTACHMENT || pendingAction.tool === CONFLUENCE_UPLOAD_ATTACHMENT) &&
      slackFileUrl &&
      !hasContentAfterFab
    ) {
      logger.info('[Web MCP Confirm] Downloading file from URL', {
        url: slackFileUrl.substring(0, 80) + '...',
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
        logger.info('[Web MCP Confirm] Downloaded file from URL', {
          filename: toolParams.filename,
          sizeBytes: fileBuffer.length,
        });
      } catch (urlError) {
        logger.error('[Web MCP Confirm] Failed to download file from URL', {
          error: urlError instanceof Error ? urlError.message : String(urlError),
        });
      }
    }

    logger.info('[Web MCP Confirm] Executing MCP tool', {
      tool: pendingAction.tool,
      mcpName,
      selectedRepoCount: selectedRepositories?.length ?? 0,
    });

    // Execute the tool with _executeFromButton flag for security
    const result = await invokeMcpHandler<any>({
      envVariables,
      name: mcpName,
      toolName: pendingAction.tool,
      toolArgs: { ...toolParams, _executeFromButton: true },
      action: 'callTool',
      selectedRepositories,
    });

    let resultData: any = result;
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
    const success = !resultData?.error && (url || resultData?.success !== false);

    logger.info('[Web MCP Confirm] MCP execution result', {
      success,
      url,
      hasError: !!resultData?.error,
    });

    await Quest.findByIdAndUpdate(questId, { $unset: { pendingAction: 1 } });

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
      } else {
        message = `Action completed successfully`;
      }

      return res.status(200).json({
        success: true,
        message,
        url,
      });
    } else {
      return res.status(200).json({
        success: false,
        message: resultData?.error || resultData?.message || 'Action failed',
      });
    }
  } catch (error: any) {
    logger.error('[Web MCP Confirm] Execution failed', {
      error: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to execute action',
    });
  }
});

export default handler;
