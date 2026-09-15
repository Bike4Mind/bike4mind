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

const DeleteAttachmentRequestSchema = z.object({
  sessionId: z.string(),
  source: z.enum(['jira', 'confluence']),
  attachmentId: z.string(),
  filename: z.string(),
  pageId: z.string().optional(), // For Confluence page content cleanup after delete
});

/**
 * Remove Confluence storage format macros that reference a specific attachment.
 * Handles both <ac:image> tags and <ac:structured-macro ac:name="view-file"> tags.
 */
function removeAttachmentMacros(content: string, filename: string): string {
  const escaped = filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Remove <ac:image> tags referencing the attachment (optionally wrapped in <p>)
  const imageRegex = new RegExp(
    `(?:<p>\\s*)?<ac:image[^>]*>[\\s\\S]*?<ri:attachment[^>]*ri:filename="${escaped}"[^/]*/?>\\s*</ac:image>(?:\\s*</p>)?`,
    'g'
  );
  // Remove <ac:structured-macro ac:name="view-file"> tags referencing the attachment
  const macroRegex = new RegExp(
    `<ac:structured-macro[^>]*ac:name="view-file"[^>]*>[\\s\\S]*?<ri:attachment[^>]*ri:filename="${escaped}"[^/]*/?>` +
      `[\\s\\S]*?</ac:structured-macro>`,
    'g'
  );
  let cleaned = content.replace(imageRegex, '');
  cleaned = cleaned.replace(macroRegex, '');
  return cleaned;
}

/**
 * After deleting a Confluence attachment, clean up the page content
 * to remove inline macros (image previews, view-file macros) that reference it.
 */
async function cleanupConfluencePageContent(
  envVariables: Array<{ key: string; value: string }>,
  pageId: string,
  filename: string,
  logger: Logger
): Promise<void> {
  const getEnv = (name: string) => envVariables.find(v => v.key === name)?.value || '';
  const accessToken = getEnv('ATLASSIAN_ACCESS_TOKEN');
  const cloudId = getEnv('ATLASSIAN_CLOUD_ID');

  if (!accessToken || !cloudId) {
    logger.warn('[Confluence Cleanup] Missing credentials, skipping page cleanup');
    return;
  }

  const baseUrl = `https://api.atlassian.com/ex/confluence/${cloudId}/wiki/api/v2`;
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };

  const pageRes = await fetch(`${baseUrl}/pages/${pageId}?body-format=storage`, { headers });
  if (!pageRes.ok) {
    logger.warn(`[Confluence Cleanup] Failed to fetch page ${pageId}: ${pageRes.status}`);
    return;
  }

  const page = await pageRes.json();
  const storageContent = page?.body?.storage?.value;
  if (!storageContent) {
    logger.info('[Confluence Cleanup] Page has no storage content to clean');
    return;
  }

  const cleanedContent = removeAttachmentMacros(storageContent, filename);
  if (cleanedContent === storageContent) {
    logger.info('[Confluence Cleanup] No macros found referencing deleted attachment');
    return;
  }

  const version = page?.version?.number;
  if (typeof version !== 'number') {
    logger.warn('[Confluence Cleanup] Could not determine page version');
    return;
  }

  const updateRes = await fetch(`${baseUrl}/pages/${pageId}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      id: pageId,
      title: page.title,
      body: { value: cleanedContent, representation: 'storage' },
      status: 'current',
      version: { number: version + 1 },
    }),
  });

  if (!updateRes.ok) {
    const errorText = await updateRes.text().catch(() => '');
    logger.warn(`[Confluence Cleanup] Failed to update page ${pageId}: ${updateRes.status} ${errorText}`);
    return;
  }

  logger.info(`[Confluence Cleanup] Removed macros for "${filename}" from page ${pageId}`);
}

/**
 * POST /api/mcp/delete-attachment
 *
 * Handles web delete button clicks for Jira/Confluence attachments.
 * Deletes the attachment via MCP and returns success/error.
 */
const handler = baseApi().post(async (req, res) => {
  const logger = new Logger({ metadata: { component: 'web-mcp-delete-attachment' } });

  const parsed = DeleteAttachmentRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    logger.error('[Web MCP Delete] Invalid request body', { error: parsed.error });
    return res.status(400).json({ error: 'Invalid request body' });
  }

  const { sessionId, source, attachmentId, filename, pageId } = parsed.data;
  const user = req.user;

  if (!user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  logger.info('[Web MCP Delete] Processing attachment deletion', {
    sessionId,
    source,
    attachmentId,
    filename,
    userId: user.id,
  });

  // Verify the session belongs to the authenticated user
  const session = await Session.findById(sessionId);
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

  try {
    const resource = source === 'jira' ? new JiraResource(user, logger) : new ConfluenceResource(user, logger);
    const envVariables = await resource.getMcpEnvVariables();
    const toolName = source === 'jira' ? 'jira_delete_attachment' : 'confluence_delete_attachment';

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
    });

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
