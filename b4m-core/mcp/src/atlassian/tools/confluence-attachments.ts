/**
 * Atlassian MCP Server - Confluence Attachment Tools
 *
 * Tools for listing, uploading, downloading, and deleting Confluence page attachments.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getErrorMessage, formatFileSize, getFileTypeEmoji, detectConfluenceMimeType } from '@bike4mind/common';
import { getConfluenceApi } from '../client.js';
import { createJsonResponse, createErrorResponse } from '../helpers/responses.js';
import { createPreviewResponse } from '../../shared/confirmation-helpers.js';
import { confirmationParams } from '../../shared/schemas.js';
import { pageIdSchema, attachmentIdSchema, uploadFileParams } from '../helpers/schemas.js';
import {
  CONFLUENCE_LIST_ATTACHMENTS,
  CONFLUENCE_UPLOAD_ATTACHMENT,
  CONFLUENCE_DOWNLOAD_ATTACHMENT,
  CONFLUENCE_DELETE_ATTACHMENT,
} from '../constants.js';

export function registerConfluenceAttachmentTools(server: McpServer) {
  // LIST ATTACHMENTS
  server.tool(
    CONFLUENCE_LIST_ATTACHMENTS,
    'List all attachments on a Confluence page. Returns filename, size, MIME type, and download URL for each attachment. ' +
      'IMPORTANT: If the user provides a page TITLE instead of an ID, first use confluence_search to find the page by title, then use the returned page ID with this tool.',
    {
      pageId: pageIdSchema,
      limit: z.number().optional().describe('Maximum number of attachments to return (default: 50, max: 100).'),
    },
    async ({ pageId, limit }) => {
      try {
        const attachments = await getConfluenceApi().listAttachments({ pageId, limit });
        let pageTitle: string | undefined;
        try {
          const page = await getConfluenceApi().getPage({ pageId, includeContent: false });
          pageTitle = page?.title;
        } catch {
          // Non-fatal - we'll fall back to pageId in the UI
        }
        return createJsonResponse({
          _attachmentList: true,
          _displayHint:
            'Download buttons will be shown below. Keep your response brief - just acknowledge the count, do NOT list each file individually.',
          source: 'confluence',
          pageId,
          pageTitle,
          count: attachments.length,
          attachments: attachments.map(att => ({
            id: att.id,
            filename: att.title,
            emoji: getFileTypeEmoji(att.mediaType),
            size: att.fileSize,
            sizeFormatted: formatFileSize(att.fileSize),
            mimeType: att.mediaType,
            author: att.author,
            created: att.createdAt,
            downloadUrl: att.downloadLink,
            webUrl: att.webuiLink,
            comment: att.comment,
            version: att.version?.number,
          })),
        });
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );

  // UPLOAD ATTACHMENT
  server.tool(
    CONFLUENCE_UPLOAD_ATTACHMENT,
    'Upload a file attachment to a Confluence page. ' +
      'For Slack files: provide slackFileUrl (the file will be downloaded server-side). ' +
      'For other sources: provide base64-encoded content directly. ' +
      'Supports files up to 25MB. MIME type is auto-detected from filename if not specified. ' +
      'IMPORTANT: If the user provides a page TITLE instead of an ID, first use confluence_search to find the page by title.',
    {
      pageId: pageIdSchema,
      ...uploadFileParams,
      comment: z.string().optional().describe('Optional comment describing the attachment.'),
      ...confirmationParams,
    },
    async ({
      pageId: rawPageId,
      filename,
      content,
      fabFileId,
      slackFileUrl,
      slackFileSize,
      mimeType,
      comment,
      _executeFromButton,
    }) => {
      const shouldExecute = _executeFromButton === true;

      // Auto-resolve page title to numeric ID if needed
      let pageId = rawPageId;
      const isNumericId = /^\d+$/.test(rawPageId);
      if (!isNumericId) {
        try {
          const api = getConfluenceApi();
          const searchResult = await api.search({ query: `title = "${rawPageId}"`, limit: 1 });
          const firstResult = searchResult?.results?.[0];
          if (firstResult?.id) {
            pageId = firstResult.id;
          } else {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Error: Could not find a Confluence page with title "${rawPageId}". Please provide a valid page ID.`,
                },
              ],
              isError: true,
            };
          }
        } catch (searchErr) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Error: Failed to resolve page title "${rawPageId}" to an ID: ${searchErr instanceof Error ? searchErr.message : 'Unknown error'}`,
              },
            ],
            isError: true,
          };
        }
      }

      const hasContent = content && content.length > 100;
      const estimatedSize = hasContent ? Math.round((content.length * 3) / 4) : slackFileSize || 0;
      const sizeFormatted = estimatedSize > 0 ? formatFileSize(estimatedSize) : 'Unknown';

      if (!shouldExecute) {
        let pageTitle = pageId;
        try {
          const page = await getConfluenceApi().getPage({ pageId });
          pageTitle = page.title || pageId;
        } catch {
          /* fall back to ID */
        }

        const resolvedMimeType = mimeType || detectConfluenceMimeType(filename);

        return createPreviewResponse(
          '📎 Preview: Confluence Attachment Upload',
          {
            pageId,
            filename,
            estimatedSize: sizeFormatted,
            mimeType: resolvedMimeType,
            comment: comment || '(none)',
          },
          'attachment',
          {
            tool: CONFLUENCE_UPLOAD_ATTACHMENT,
            params: {
              pageId,
              filename,
              content: hasContent ? content : '',
              fabFileId,
              slackFileUrl,
              slackFileSize,
              mimeType,
              comment,
              display_page_title: pageTitle,
            },
          }
        );
      }

      if (!content || content.length < 100) {
        if (slackFileUrl) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'Error: File content was not provided. The Slack file should be downloaded by the confirmation handler before calling this tool.',
              },
            ],
            isError: true,
          };
        }
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Error: File content is required. Provide base64-encoded content or slackFileUrl.',
            },
          ],
          isError: true,
        };
      }

      try {
        const api = getConfluenceApi();
        const result = await api.uploadAttachment({ pageId, filename, content, mimeType, comment });

        let pageTitle = pageId;
        try {
          const page = await api.getPage({ pageId, includeContent: false });
          pageTitle = page.title || pageId;
        } catch {
          /* fall back to ID */
        }

        // Append attachment reference to page content so it's visible inline
        let embedNote = '';
        try {
          const rawPage = await api.get<{
            title: string;
            version?: { number: number };
            body?: { storage?: { value: string } };
          }>(`/pages/${pageId}`, { 'body-format': 'storage' });
          const currentBody = rawPage.body?.storage?.value || '';
          const currentVersion = rawPage.version?.number;
          const resolvedMime = result.mediaType || detectConfluenceMimeType(filename);
          const isImage = resolvedMime.startsWith('image/');

          const escapedFilename = filename.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
          const attachmentMacro = isImage
            ? `<p><ac:image ac:height="250"><ri:attachment ri:filename="${escapedFilename}" /></ac:image></p>`
            : `<ac:structured-macro ac:name="view-file" ac:schema-version="1"><ac:parameter ac:name="name"><ri:attachment ri:filename="${escapedFilename}" /></ac:parameter><ac:parameter ac:name="height">250</ac:parameter></ac:structured-macro>`;

          const updatedBody = currentBody + '\n' + attachmentMacro;

          if (typeof currentVersion === 'number') {
            await api.put(`/pages/${pageId}`, {
              id: pageId,
              title: rawPage.title,
              body: { value: updatedBody, representation: 'storage' },
              status: 'current',
              version: { number: currentVersion + 1 },
            });
            embedNote = isImage
              ? 'Attachment embedded as image in page content.'
              : 'Attachment linked in page content.';
          }
        } catch (embedError) {
          const errMsg = embedError instanceof Error ? embedError.message : String(embedError);
          console.error(`[Confluence] Failed to embed attachment in page ${pageId}: ${errMsg}`);
          embedNote = `Attachment uploaded but could not be embedded in page content: ${errMsg}`;
        }

        return createJsonResponse({
          success: true,
          pageId,
          pageTitle,
          attachment: {
            id: result.id,
            filename: result.title,
            size: result.fileSize,
            sizeFormatted: result.fileSize ? formatFileSize(result.fileSize) : 'Unknown',
            mimeType: result.mediaType,
            downloadUrl: result.downloadLink,
            webUrl: result.webuiLink,
          },
          ...(embedNote && { note: embedNote }),
        });
      } catch (error) {
        const errorMessage = getErrorMessage(error);
        if (errorMessage.includes('413') || errorMessage.includes('too large')) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Error: File too large. The maximum attachment size is 25MB. Your file is approximately ${sizeFormatted}.`,
              },
            ],
            isError: true,
          };
        }
        return {
          content: [{ type: 'text' as const, text: `Error: ${errorMessage}` }],
          isError: true,
        };
      }
    }
  );

  // DOWNLOAD ATTACHMENT
  server.tool(
    CONFLUENCE_DOWNLOAD_ATTACHMENT,
    'Download a Confluence attachment by ID. Returns the file content as base64-encoded string along with filename and MIME type. ' +
      'First use confluence_list_attachments to get attachment IDs.',
    {
      attachmentId: attachmentIdSchema,
    },
    async ({ attachmentId }) => {
      try {
        const result = await getConfluenceApi().downloadAttachment({ attachmentId });

        return createJsonResponse({
          filename: result.filename,
          mimeType: result.mimeType,
          size: result.size,
          sizeFormatted: formatFileSize(result.size),
          content: result.content,
        });
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );

  // DELETE ATTACHMENT
  server.tool(
    CONFLUENCE_DELETE_ATTACHMENT,
    'Delete an attachment from a Confluence page by attachment ID. First use confluence_list_attachments to get attachment IDs.',
    {
      attachmentId: attachmentIdSchema,
      filename: z
        .string()
        .optional()
        .describe(
          'Optional: The filename for display purposes (shown in preview). Get from confluence_list_attachments.'
        ),
      ...confirmationParams,
    },
    async ({ attachmentId, filename, _executeFromButton }) => {
      const shouldExecute = _executeFromButton === true;

      if (!shouldExecute) {
        return createPreviewResponse(
          '⚠️ Preview: Confluence Attachment to be Deleted',
          {
            attachmentId,
            display_filename: filename || attachmentId,
            warning: 'This action cannot be undone.',
          },
          'attachment',
          {
            tool: CONFLUENCE_DELETE_ATTACHMENT,
            params: { attachmentId, filename },
          }
        );
      }

      try {
        await getConfluenceApi().deleteAttachment({ attachmentId });
        return createJsonResponse({
          success: true,
          message: `Attachment ${attachmentId} deleted successfully.`,
        });
      } catch (error) {
        const errorMessage = getErrorMessage(error);
        if (errorMessage.includes('404')) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Attachment ${attachmentId} not found. It may have already been deleted.`,
              },
            ],
          };
        }
        return {
          content: [{ type: 'text' as const, text: `Error: ${errorMessage}` }],
          isError: true,
        };
      }
    }
  );
}
