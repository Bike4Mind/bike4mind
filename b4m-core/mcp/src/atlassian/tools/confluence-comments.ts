/**
 * Atlassian MCP Server - Confluence Comment Tools
 *
 * Tools for creating, replying, listing, getting, updating, and deleting comments.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getErrorMessage } from '@bike4mind/common';
import { getConfluenceApi } from '../client.js';
import { createJsonResponse, createErrorResponse } from '../helpers/responses.js';
import { createPreviewResponse } from '../../shared/confirmation-helpers.js';
import { pageIdSchema, commentIdSchema } from '../helpers/schemas.js';
import { confirmationParams } from '../../shared/schemas.js';
import {
  CONFLUENCE_CREATE_COMMENT,
  CONFLUENCE_REPLY_TO_COMMENT,
  CONFLUENCE_LIST_COMMENTS,
  CONFLUENCE_GET_COMMENT,
  CONFLUENCE_UPDATE_COMMENT,
  CONFLUENCE_DELETE_COMMENT,
} from '../constants.js';

export function registerConfluenceCommentTools(server: McpServer) {
  // CREATE COMMENT
  server.tool(
    CONFLUENCE_CREATE_COMMENT,
    'Create a comment on a Confluence page. Can be a page-level comment or an inline comment if inlineOriginalSelection is provided.',
    {
      pageId: pageIdSchema,
      content: z.string().describe('The comment text (HTML storage format supported).'),
      inlineOriginalSelection: z
        .string()
        .optional()
        .describe(
          'For inline comments: the text selected in the page to attach the comment to. If omitted, creates a page-level comment.'
        ),
    },
    async ({ pageId, content, inlineOriginalSelection }) => {
      try {
        const comment = await getConfluenceApi().addComment({
          pageId,
          content,
          inlineOriginalSelection,
        });
        return createJsonResponse(comment);
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );

  // REPLY TO COMMENT
  server.tool(
    CONFLUENCE_REPLY_TO_COMMENT,
    'Reply to an existing comment (threaded discussion).',
    {
      pageId: pageIdSchema,
      parentCommentId: z.string().describe('The ID of the comment to reply to.'),
      content: z.string().describe('The reply text (HTML storage format supported).'),
    },
    async ({ pageId, parentCommentId, content }) => {
      try {
        const comment = await getConfluenceApi().addComment({
          pageId,
          content,
          parentId: parentCommentId,
        });
        return createJsonResponse(comment);
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );

  // LIST COMMENTS
  server.tool(
    CONFLUENCE_LIST_COMMENTS,
    'List comments on a Confluence page. Returns a paginated list of comments including threaded replies.',
    {
      pageId: pageIdSchema,
      limit: z.number().min(1).max(50).prefault(25).describe('Maximum number of comments to return (default 25).'),
      start: z.number().min(0).prefault(0).describe('Starting index for pagination (default 0).'),
    },
    async ({ pageId, limit, start }) => {
      try {
        const comments = await getConfluenceApi().getPageComments({ pageId, limit, start });
        return createJsonResponse(comments);
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );

  // GET COMMENT
  server.tool(
    CONFLUENCE_GET_COMMENT,
    'Get details of a specific comment by ID.',
    {
      commentId: commentIdSchema,
    },
    async ({ commentId }) => {
      try {
        const comment = await getConfluenceApi().getComment({ commentId });
        return createJsonResponse(comment);
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );

  // UPDATE COMMENT
  server.tool(
    CONFLUENCE_UPDATE_COMMENT,
    'Update an existing comment. You can only update comments authored by you.',
    {
      commentId: commentIdSchema,
      content: z.string().describe('The new comment text (HTML storage format supported).'),
      ...confirmationParams,
    },
    async ({ commentId, content, _executeFromButton }) => {
      const shouldExecute = _executeFromButton === true;

      if (!shouldExecute) {
        try {
          const comment = await getConfluenceApi().getComment({ commentId });
          const currentUser = await getConfluenceApi().getCurrentUser();
          const isOwner = comment.author?.accountId === currentUser.accountId;

          if (!isOwner) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `❌ Permission Denied: You can only update your own comments.\n\nComment Author: ${comment.author?.displayName}\nYou: ${currentUser.displayName || 'Unknown'}`,
                },
              ],
              isError: true,
            };
          }

          return createPreviewResponse(
            '📋 Preview: Update Confluence Comment',
            {
              commentId,
              currentContent: comment.body ? comment.body.substring(0, 100) + '...' : '[No content]',
              newContent: content.substring(0, 100) + (content.length > 100 ? '...' : ''),
              author: comment.author?.displayName,
            },
            'update',
            {
              tool: CONFLUENCE_UPDATE_COMMENT,
              params: { commentId, content },
            }
          );
        } catch (error) {
          return {
            content: [{ type: 'text' as const, text: `Error fetching comment details: ${getErrorMessage(error)}` }],
            isError: true,
          };
        }
      }

      try {
        // Double-check ownership before execution (defense in depth)
        const comment = await getConfluenceApi().getComment({ commentId });
        const currentUser = await getConfluenceApi().getCurrentUser();
        if (comment.author?.accountId !== currentUser.accountId) {
          throw new Error('Permission denied: You do not own this comment.');
        }

        const updatedComment = await getConfluenceApi().updateComment({ commentId, content });
        return createJsonResponse(updatedComment);
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );

  // DELETE COMMENT
  server.tool(
    CONFLUENCE_DELETE_COMMENT,
    '⚠️ DESTRUCTIVE: Permanently delete a comment. You can only delete comments authored by you. Cannot be undone.',
    {
      commentId: commentIdSchema,
      ...confirmationParams,
    },
    async ({ commentId, _executeFromButton }) => {
      const shouldExecute = _executeFromButton === true;

      if (!shouldExecute) {
        try {
          const comment = await getConfluenceApi().getComment({ commentId });
          const currentUser = await getConfluenceApi().getCurrentUser();
          const isOwner = comment.author?.accountId === currentUser.accountId;

          if (!isOwner) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `❌ Permission Denied: You can only delete your own comments.\n\nComment Author: ${comment.author?.displayName}\nYou: ${currentUser.displayName || 'Unknown'}`,
                },
              ],
              isError: true,
            };
          }

          return createPreviewResponse(
            '⚠️ Preview: Delete Confluence Comment (DESTRUCTIVE)',
            {
              commentId,
              author: comment.author?.displayName || 'Unknown',
              preview: comment.body ? comment.body.substring(0, 100) + '...' : '[No content]',
              warning: '⚠️ This action CANNOT be undone.',
            },
            'deletion',
            {
              tool: CONFLUENCE_DELETE_COMMENT,
              params: { commentId },
            }
          );
        } catch (error) {
          return createPreviewResponse(
            '⚠️ Preview: Delete Confluence Comment (DESTRUCTIVE)',
            {
              commentId,
              warning: '⚠️ This action CANNOT be undone.',
            },
            'deletion',
            {
              tool: CONFLUENCE_DELETE_COMMENT,
              params: { commentId },
            }
          );
        }
      }

      try {
        // Double-check ownership before execution (defense in depth)
        const comment = await getConfluenceApi().getComment({ commentId });
        const currentUser = await getConfluenceApi().getCurrentUser();
        if (comment.author?.accountId !== currentUser.accountId) {
          throw new Error('Permission denied: You do not own this comment.');
        }

        await getConfluenceApi().deleteComment({ commentId });
        return {
          content: [{ type: 'text' as const, text: `Successfully deleted comment ${commentId}` }],
        };
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );
}
