import { initializeSlackPackage } from '@server/integrations/slack/slackPackageInit';
initializeSlackPackage();

import { z } from 'zod';
import { Quest, Session } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { baseApi } from '@server/middlewares/baseApi';
import { assertMcpServerEnabled } from '@server/utils/mcpServerFlag';
import { isValidObjectId } from '@server/utils/objectId';
import { invokeMcpHandler } from '@server/utils/invokeMcpHandler';
import { parseMcpResult } from '@server/utils/parseMcpResult';
import { getMcpToolText, isMcpToolError } from '@server/utils/isMcpToolError';
import { cleanupConfluencePageContent } from '@server/integrations/atlassian/confluenceAttachmentCleanup';
import { JiraResource } from '@bike4mind/slack';
import { ConfluenceResource } from '@bike4mind/slack';
import { JIRA_DELETE_ATTACHMENT, CONFLUENCE_DELETE_ATTACHMENT } from '@bike4mind/mcp/atlassian/constants';

const DeleteAttachmentRequestSchema = z.object({
  sessionId: z.string(),
  attachmentId: z.string(),
});

/**
 * POST /api/mcp/delete-attachment
 *
 * Handles web delete button clicks for Jira/Confluence attachments.
 * Deletes the attachment via MCP and returns success/error.
 */
const handler = baseApi().post(async (req, res) => {
  await assertMcpServerEnabled();
  const logger = new Logger({ metadata: { component: 'web-mcp-delete-attachment' } });

  const parsed = DeleteAttachmentRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    logger.error('[Web MCP Delete] Invalid request body', { error: parsed.error });
    return res.status(400).json({ error: 'Invalid request body' });
  }

  const { sessionId, attachmentId } = parsed.data;
  const user = req.user;

  if (!user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  logger.info('[Web MCP Delete] Processing attachment deletion', {
    sessionId,
    attachmentId,
    userId: user.id,
  });

  // Verify the session belongs to the authenticated user
  const session = isValidObjectId(sessionId) ? await Session.findById(sessionId) : null;
  if (!session) {
    logger.error('[Web MCP Delete] Session not found', { sessionId });
    return res.status(404).json({ error: 'Session not found' });
  }

  if (session.userId?.toString() !== user.id?.toString()) {
    logger.error('[Web MCP Delete] User mismatch - session belongs to different user', {
      sessionUserId: session.userId,
      requestUserId: user.id,
    });
    return res.status(403).json({ error: 'Unauthorized access to session' });
  }

  // The target comes from the list this session's tool produced, never from the request body.
  const quest = await Quest.findOne({ sessionId, 'attachmentList.attachments.id': attachmentId });
  const attachmentList = quest?.attachmentList;
  const attachment = attachmentList?.attachments.find(candidate => candidate.id === attachmentId);
  if (!attachmentList || !attachment) {
    logger.error('[Web MCP Delete] Attachment is not in any listed attachment set for this session', {
      sessionId,
      attachmentId,
    });
    return res.status(404).json({ error: 'Attachment not found' });
  }

  const { source, pageId } = attachmentList;
  const { filename } = attachment;

  try {
    const resource = source === 'jira' ? new JiraResource(user, logger) : new ConfluenceResource(user, logger);
    const envVariables = await resource.getMcpEnvVariables();
    const toolName = source === 'jira' ? JIRA_DELETE_ATTACHMENT : CONFLUENCE_DELETE_ATTACHMENT;

    logger.info('[Web MCP Delete] Calling MCP delete tool', {
      toolName,
      attachmentId,
    });

    // any: MCP handler returns dynamic tool-specific shapes
    const result = await invokeMcpHandler<any>({
      envVariables,
      name: 'atlassian',
      toolName,
      toolArgs: { attachmentId, confirmed: true, _executeFromButton: true },
      action: 'callTool',
      userId: user.id,
    });

    if (isMcpToolError(result)) {
      const error = getMcpToolText(result) ?? 'Attachment deletion failed';
      logger.error('[Web MCP Delete] Attachment deletion failed', { error });
      return res.status(500).json({ success: false, error });
    }

    const resultData = parseMcpResult(result, logger, '[Web MCP Delete]');

    if (resultData?.error) {
      logger.error('[Web MCP Delete] Attachment deletion failed', {
        error: resultData.error,
      });
      return res.status(500).json({
        success: false,
        error: resultData.error,
      });
    }

    logger.info('[Web MCP Delete] Attachment deleted successfully', {
      attachmentId,
      filename,
    });

    // Drop the entry so the stored list matches what is left on the remote item. The attachment is
    // already gone, so a failure here is bookkeeping only and must not turn the response into an error.
    try {
      await Quest.updateOne({ _id: quest._id }, { $pull: { 'attachmentList.attachments': { id: attachmentId } } });
    } catch (storeError) {
      logger.warn('[Web MCP Delete] Deleted remotely but failed to prune the stored attachment list', {
        error: storeError instanceof Error ? storeError.message : String(storeError),
        attachmentId,
      });
    }

    // For Confluence: clean up page content to remove macros referencing the deleted attachment
    if (source === 'confluence' && pageId) {
      try {
        await cleanupConfluencePageContent(envVariables, pageId, filename, logger);
      } catch (cleanupError) {
        logger.warn('[Web MCP Delete] Failed to clean up Confluence page content (non-fatal)', {
          error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          pageId,
          filename,
        });
      }
    }

    return res.json({
      success: true,
      message: `${filename} deleted successfully`,
    });
  } catch (error) {
    logger.error('[Web MCP Delete] Attachment deletion failed', {
      error: error instanceof Error ? error.message : String(error),
      attachmentId,
      filename,
    });
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Deletion failed',
    });
  }
});

export default handler;
