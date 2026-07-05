/**
 * Atlassian MCP Server - Jira Attachment Tools
 *
 * Tools for listing, uploading, downloading, and deleting Jira issue attachments.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getErrorMessage, formatFileSize, getFileTypeEmoji } from '@bike4mind/common';
import { getJiraApi } from '../client.js';
import { createJsonResponse, createErrorResponse } from '../helpers/responses.js';
import { createPreviewResponse } from '../../shared/confirmation-helpers.js';
import { confirmationParams } from '../../shared/schemas.js';
import { issueKeySchema, attachmentIdSchema, uploadFileParams } from '../helpers/schemas.js';
import {
  JIRA_LIST_ATTACHMENTS,
  JIRA_UPLOAD_ATTACHMENT,
  JIRA_DOWNLOAD_ATTACHMENT,
  JIRA_DELETE_ATTACHMENT,
} from '../constants.js';

export function registerJiraAttachmentTools(server: McpServer) {
  // LIST ATTACHMENTS
  server.tool(
    JIRA_LIST_ATTACHMENTS,
    'List all attachments on a Jira issue. Returns filename, size, MIME type, author, and download URL for each attachment.',
    {
      issueKey: issueKeySchema,
    },
    async ({ issueKey }) => {
      try {
        const attachments = await getJiraApi().listAttachments({ issueKey });
        return createJsonResponse({
          _attachmentList: true,
          _displayHint:
            'Download buttons will be shown below. Keep your response brief - just acknowledge the count, do NOT list each file individually.',
          source: 'jira',
          issueKey,
          count: attachments.length,
          attachments: attachments.map(att => ({
            id: att.id,
            filename: att.filename,
            emoji: getFileTypeEmoji(att.mimeType),
            size: att.size,
            sizeFormatted: formatFileSize(att.size),
            mimeType: att.mimeType,
            author: att.author?.displayName,
            created: att.created,
            downloadUrl: att.content,
            thumbnail: att.thumbnail,
          })),
        });
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );

  // UPLOAD ATTACHMENT
  server.tool(
    JIRA_UPLOAD_ATTACHMENT,
    'Upload a file attachment to a Jira issue. ' +
      'For Slack files: provide slackFileUrl (the file will be downloaded server-side). ' +
      'For other sources: provide base64-encoded content directly. ' +
      'Supports files up to 20MB. MIME type is auto-detected from filename if not specified.',
    {
      issueKey: issueKeySchema,
      ...uploadFileParams,
      ...confirmationParams,
    },
    async ({
      issueKey,
      filename,
      content,
      fabFileId,
      slackFileUrl,
      slackFileSize,
      mimeType,
      confirmed,
      _executeFromButton,
    }) => {
      const shouldExecute = _executeFromButton === true;

      const hasContent = content && content.length > 100;
      const estimatedSize = hasContent ? Math.round((content.length * 3) / 4) : slackFileSize || 0;
      const sizeFormatted = estimatedSize > 0 ? formatFileSize(estimatedSize) : 'Unknown';

      if (!shouldExecute) {
        return createPreviewResponse(
          '📎 Preview: Jira Attachment Upload',
          {
            issueKey,
            filename,
            estimatedSize: sizeFormatted,
            mimeType: mimeType || '(auto-detect)',
          },
          'attachment',
          {
            tool: JIRA_UPLOAD_ATTACHMENT,
            params: {
              issueKey,
              filename,
              content: hasContent ? content : '',
              fabFileId,
              slackFileUrl,
              slackFileSize,
              mimeType,
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
        const result = await getJiraApi().uploadAttachment({ issueKey, filename, content, mimeType });
        const uploaded = result[0];
        return createJsonResponse({
          success: true,
          issueKey,
          attachment: {
            id: uploaded.id,
            filename: uploaded.filename,
            size: uploaded.size,
            sizeFormatted: formatFileSize(uploaded.size),
            mimeType: uploaded.mimeType,
            downloadUrl: uploaded.content,
          },
        });
      } catch (error) {
        const errorMessage = getErrorMessage(error);
        if (errorMessage.includes('413') || errorMessage.includes('too large')) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Error: File too large. The maximum attachment size is 20MB. Your file is approximately ${sizeFormatted}.`,
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
    JIRA_DOWNLOAD_ATTACHMENT,
    'Download a Jira attachment by ID. Returns the file content as base64-encoded string along with filename and MIME type. ' +
      'First use jira_list_attachments to get attachment IDs.',
    {
      attachmentId: attachmentIdSchema,
    },
    async ({ attachmentId }) => {
      try {
        const result = await getJiraApi().downloadAttachment({ attachmentId });

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
    JIRA_DELETE_ATTACHMENT,
    'Delete an attachment from a Jira issue by attachment ID. First use jira_list_attachments to get attachment IDs.',
    {
      attachmentId: attachmentIdSchema,
      filename: z
        .string()
        .optional()
        .describe('Optional: The filename for display purposes (shown in preview). Get from jira_list_attachments.'),
      ...confirmationParams,
    },
    async ({ attachmentId, filename, _executeFromButton }) => {
      const shouldExecute = _executeFromButton === true;

      if (!shouldExecute) {
        return createPreviewResponse(
          '⚠️ Preview: Jira Attachment to be Deleted',
          {
            attachmentId,
            display_filename: filename || attachmentId,
            warning: 'This action cannot be undone.',
          },
          'attachment',
          {
            tool: JIRA_DELETE_ATTACHMENT,
            params: { attachmentId, filename },
          }
        );
      }

      try {
        await getJiraApi().deleteAttachment({ attachmentId });
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
