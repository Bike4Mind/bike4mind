import { initializeSlackPackage } from '@server/integrations/slack/slackPackageInit';
initializeSlackPackage();

import { z } from 'zod';
import { Session } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { baseApi } from '@server/middlewares/baseApi';
import { invokeMcpHandler } from '@server/utils/invokeMcpHandler';
import { parseMcpResult } from '@server/utils/parseMcpResult';
import { JiraResource } from '@bike4mind/slack';
import { ConfluenceResource } from '@bike4mind/slack';

const DownloadAttachmentRequestSchema = z.object({
  sessionId: z.string(),
  source: z.enum(['jira', 'confluence']),
  attachmentId: z.string(),
  filename: z.string(),
});

/**
 * POST /api/mcp/download-attachment
 *
 * Handles web download button clicks for Jira/Confluence attachments.
 * Downloads the attachment via MCP and returns it as a downloadable file.
 */
const handler = baseApi().post(async (req, res) => {
  const logger = new Logger({ metadata: { component: 'web-mcp-download-attachment' } });

  const parsed = DownloadAttachmentRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    logger.error('[Web MCP Download] Invalid request body', { error: parsed.error });
    return res.status(400).json({ error: 'Invalid request body' });
  }

  const { sessionId, source, attachmentId, filename } = parsed.data;
  const user = req.user;

  if (!user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  logger.info('[Web MCP Download] Processing attachment download', {
    sessionId,
    source,
    attachmentId,
    filename,
    userId: user.id,
  });

  // Verify the session belongs to the authenticated user
  const session = await Session.findById(sessionId);
  if (!session) {
    logger.error('[Web MCP Download] Session not found', { sessionId });
    return res.status(404).json({ error: 'Session not found' });
  }

  if (session.userId?.toString() !== user.id?.toString()) {
    logger.error('[Web MCP Download] User mismatch - session belongs to different user', {
      sessionUserId: session.userId,
      requestUserId: user.id,
    });
    return res.status(403).json({ error: 'Unauthorized access to session' });
  }

  try {
    const resource = source === 'jira' ? new JiraResource(user, logger) : new ConfluenceResource(user, logger);
    const envVariables = await resource.getMcpEnvVariables();
    const toolName = source === 'jira' ? 'jira_download_attachment' : 'confluence_download_attachment';

    logger.info('[Web MCP Download] Calling MCP download tool', {
      toolName,
      attachmentId,
    });

    // any: MCP handler returns dynamic tool-specific shapes
    const result = await invokeMcpHandler<any>({
      envVariables,
      name: 'atlassian',
      toolName,
      toolArgs: { attachmentId },
      action: 'callTool',
    });

    const fileData = parseMcpResult(result, logger, '[Web MCP Download]');

    if (fileData?.error || !fileData?.content) {
      logger.error('[Web MCP Download] Attachment download failed', {
        error: fileData?.error,
        hasContent: !!fileData?.content,
      });
      return res.status(500).json({
        success: false,
        error: fileData?.error || 'Failed to download attachment',
      });
    }

    const fileBuffer = Buffer.from(fileData.content as string, 'base64');

    const downloadFilename = (fileData.filename as string) || filename;
    const mimeType = (fileData.mimeType as string) || 'application/octet-stream';

    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(String(downloadFilename))}"`);
    res.setHeader('Content-Length', fileBuffer.length);
    res.setHeader('X-Content-Type-Options', 'nosniff');

    logger.info('[Web MCP Download] Sending file', {
      filename: downloadFilename,
      mimeType,
      size: fileBuffer.length,
    });

    return res.send(fileBuffer);
  } catch (error) {
    logger.error('[Web MCP Download] Attachment download failed', {
      error: error instanceof Error ? error.message : String(error),
      attachmentId,
      filename,
    });
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Download failed',
    });
  }
});

export default handler;
