/**
 * Atlassian MCP Server - Confluence Page Tools
 *
 * Tools for page CRUD, search, spaces, children, current user, and listing pages.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getConfluenceApi } from '../client.js';
import { createJsonResponse, createErrorResponse } from '../helpers/responses.js';
import { createPreviewResponse } from '../../shared/confirmation-helpers.js';
import { confirmationParams } from '../../shared/schemas.js';
import { pageIdSchema } from '../helpers/schemas.js';
import {
  CONFLUENCE_GET_PAGE,
  CONFLUENCE_CREATE_PAGE,
  CONFLUENCE_UPDATE_PAGE,
  CONFLUENCE_DELETE_PAGE,
  CONFLUENCE_SEARCH,
  CONFLUENCE_LIST_SPACES,
  CONFLUENCE_GET_SPACE,
  CONFLUENCE_GET_PAGE_CHILDREN,
  CONFLUENCE_GET_CURRENT_USER,
  CONFLUENCE_LIST_PAGES,
} from '../constants.js';

export function registerConfluencePageTools(server: McpServer) {
  // GET PAGE
  server.tool(
    CONFLUENCE_GET_PAGE,
    'Retrieve a Confluence page by ID or search by title within a space. Include page metadata and optional content.',
    {
      pageId: pageIdSchema.optional(),
      title: z.string().optional().describe('The title of the page to search for (requires spaceKey).'),
      spaceKey: z.string().optional().describe('The space key to search within when using title.'),
      includeContent: z
        .boolean()
        .prefault(true)
        .describe('Include HTML content (storage format) in the response. Defaults to true.'),
    },
    async ({ pageId, title, spaceKey, includeContent }) => {
      try {
        const page = await getConfluenceApi().getPage({ pageId, title, spaceKey, includeContent });
        return createJsonResponse(page);
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );

  // UPDATE PAGE
  server.tool(
    CONFLUENCE_UPDATE_PAGE,
    'Use this tool when the user wants to UPDATE, EDIT, CHANGE, MODIFY, or RENAME an existing Confluence page. ' +
      'Do NOT use confluence_create_page for updates - that creates duplicates! ' +
      'This tool can update the title, content, or both. If the user only wants to change the title, you do not need to provide content - the existing content will be preserved. ' +
      'You can identify the page using: (1) pageId, (2) link (full Confluence page URL)' +
      'IMPORTANT: Check the recent conversation for pageId or link from a previous response (e.g., if you just created a page, the pageId was returned in that response). Use that pageId to update the page.',
    {
      pageId: pageIdSchema,
      currentTitle: z
        .string()
        .optional()
        .describe('The current title of the page being updated. Used for display in preview.'),
      newTitle: z.string().optional().describe('New title for the page. If not provided, keeps the existing title.'),
      title: z
        .string()
        .optional()
        .describe('New title for the page. If not provided, keeps the existing title. (for backward compatibility)'),
      content: z.string().describe('Updated page body in Confluence storage (HTML) format.'),
      _executeFromButton: z.boolean().optional().describe('Internal use only - set by button handler'),
    },
    async ({ pageId, currentTitle, newTitle, title, content, _executeFromButton }) => {
      const shouldExecute = _executeFromButton === true;
      const finalTitle = newTitle || title;

      if (!shouldExecute) {
        return createPreviewResponse(
          '📋 Preview: Confluence Page Update',
          {
            pageId,
            currentTitle: currentTitle || '[Unknown]',
            newTitle: finalTitle || '[Keep existing title]',
            contentPreview: content.substring(0, 500) + (content.length > 500 ? '...' : ''),
            contentLength: content.length,
          },
          'update',
          {
            tool: CONFLUENCE_UPDATE_PAGE,
            params: { pageId, newTitle: finalTitle, content },
          }
        );
      }

      try {
        const updatedPage = await getConfluenceApi().updatePage({ pageId, title: finalTitle, content });
        return createJsonResponse(updatedPage);
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );

  // CREATE PAGE
  server.tool(
    CONFLUENCE_CREATE_PAGE,
    'Create a NEW Confluence page. Only use this for creating pages that do not exist yet. ' +
      'Do NOT use this tool if the user says "update", "edit", "change", "modify", or "rename" an existing page - use confluence_update_page instead. ' +
      'Automatically uses your personal space when spaceId is omitted - no need to call confluence_get_current_user first. Returns the page ID, title, and a clickable link to view the page.',
    {
      spaceId: z
        .string()
        .optional()
        .describe('Optional space ID. Omit this parameter to automatically create the page in your personal space.'),
      title: z.string().describe('Title of the new page.'),
      content: z.string().describe('Page body in Confluence storage (HTML) format.'),
      parentId: z.string().optional().describe('Optional ancestor page ID to nest under.'),
      labels: z.array(z.string()).optional().describe('Labels to apply to the new page.'),
      ...confirmationParams,
    },
    async ({ spaceId, title, content, parentId, labels, _executeFromButton }) => {
      const shouldExecute = _executeFromButton === true;

      if (!shouldExecute) {
        return createPreviewResponse(
          '📋 Preview: Confluence Page to be Created',
          {
            title,
            space: spaceId || '[Your Personal Space]',
            contentPreview: content.substring(0, 500) + (content.length > 500 ? '...' : ''),
            contentLength: content.length,
            labels: labels || [],
            parentId: parentId || null,
          },
          'page',
          {
            tool: CONFLUENCE_CREATE_PAGE,
            params: { spaceId, title, content, parentId, labels },
          }
        );
      }

      try {
        let finalSpaceId = spaceId;

        if (!finalSpaceId) {
          const currentUser = await getConfluenceApi().getCurrentUser();
          finalSpaceId = currentUser.personalSpace?.id;

          if (!finalSpaceId) {
            throw new Error('No spaceId provided and could not retrieve personal space ID from current user.');
          }
        } else if (!/^\d+$/.test(finalSpaceId)) {
          const keysToTry = finalSpaceId.startsWith('~')
            ? [finalSpaceId, finalSpaceId.slice(1)]
            : [finalSpaceId, `~${finalSpaceId}`];

          let foundSpaceId: string | undefined;
          for (const keyAttempt of keysToTry) {
            try {
              const spaceInfo = await getConfluenceApi().getSpace({ spaceKey: keyAttempt });
              if (spaceInfo?.id) {
                foundSpaceId = spaceInfo.id;
                break;
              }
            } catch {
              // Try next key format
            }
          }

          if (!foundSpaceId) {
            throw new Error(
              `Could not find space with key "${finalSpaceId}". Please provide a valid numeric space ID.`
            );
          }
          finalSpaceId = foundSpaceId;
        }

        const filteredLabels = labels?.filter(label => label.trim().length > 0) || [];
        const createdPage = await getConfluenceApi().createPage({
          spaceId: finalSpaceId,
          title,
          content,
          parentId,
          labels: filteredLabels,
        });
        return createJsonResponse(createdPage);
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );

  // SEARCH
  server.tool(
    CONFLUENCE_SEARCH,
    'Search for Confluence content using CQL with enhanced capabilities. Returns matching pages with highlighted excerpts, relevance ranking, and URLs. Uses Confluence API v1 for superior search functionality.',
    {
      query: z.string().describe('Search query (supports Confluence CQL syntax and full-text search).'),
      spaceKey: z.string().optional().describe('Optional space key to scope the search.'),
      limit: z.number().min(1).max(25).prefault(10).describe('Maximum number of results (default 10, max 25).'),
    },
    async ({ query, spaceKey, limit }) => {
      try {
        const response = await getConfluenceApi().search({ query, spaceKey, limit });
        return createJsonResponse(response);
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );

  // LIST SPACES
  server.tool(
    CONFLUENCE_LIST_SPACES,
    'List available Confluence spaces with descriptions and homepage links.',
    {
      limit: z.number().min(1).max(50).prefault(20).describe('Maximum number of spaces (default 20, max 50).'),
      type: z.string().optional().describe('Filter spaces by type: global or personal.'),
      expand: z
        .string()
        .optional()
        .describe('Comma-separated properties to expand (e.g., "homepage,description.plain").'),
    },
    async ({ limit, type, expand }) => {
      try {
        const response = await getConfluenceApi().listSpaces({ limit, type, expand });
        return createJsonResponse(response);
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );

  // GET SPACE
  server.tool(
    CONFLUENCE_GET_SPACE,
    'Fetch details for a Confluence space by key, including homepage and metadata.',
    {
      spaceKey: z.string().describe('Key of the space to retrieve (e.g., "~abcdef").'),
      expand: z.string().optional().describe('Optional expand parameters (e.g., "homepage,description.plain").'),
    },
    async ({ spaceKey, expand }) => {
      try {
        const space = await getConfluenceApi().getSpace({ spaceKey, expand });
        return createJsonResponse(space);
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );

  // GET PAGE CHILDREN
  server.tool(
    CONFLUENCE_GET_PAGE_CHILDREN,
    'Retrieve child pages for a given Confluence page to understand hierarchy.',
    {
      pageId: pageIdSchema,
      limit: z.number().min(1).max(50).prefault(25).describe('Maximum number of child pages to return (default 25).'),
    },
    async ({ pageId, limit }) => {
      try {
        const children = await getConfluenceApi().getPageChildren({ pageId, limit });
        return createJsonResponse(children);
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );

  // GET CURRENT USER
  server.tool(
    CONFLUENCE_GET_CURRENT_USER,
    'Retrieve the currently authenticated Confluence user profile and personal space information. Returns user details including account ID, display name, and personal space metadata.',
    {},
    async () => {
      try {
        const user = await getConfluenceApi().getCurrentUser();
        return createJsonResponse(user);
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );

  // LIST PAGES
  server.tool(
    CONFLUENCE_LIST_PAGES,
    'List all pages in a Confluence space. Use usePersonalSpace: true to automatically list pages from your personal space, provide a specific spaceId, or omit both to list pages from all accessible spaces.',
    {
      spaceId: z
        .string()
        .optional()
        .describe(
          'Optional space ID to filter pages. If not provided and usePersonalSpace is false, lists pages from all accessible spaces.'
        ),
      usePersonalSpace: z
        .boolean()
        .prefault(false)
        .describe(
          'Set to true to automatically fetch and list pages from your personal space. Ignored if spaceId is provided.'
        ),
      limit: z
        .number()
        .min(1)
        .max(250)
        .prefault(25)
        .describe('Maximum number of pages to return (default 25, max 250).'),
    },
    async ({ spaceId, usePersonalSpace, limit }) => {
      try {
        const pages = await getConfluenceApi().listPages({ spaceId, usePersonalSpace, limit });
        return createJsonResponse(pages);
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );

  // DELETE PAGE
  server.tool(
    CONFLUENCE_DELETE_PAGE,
    '⚠️ DESTRUCTIVE: This PERMANENTLY deletes a Confluence page. Cannot be undone.',
    {
      pageId: pageIdSchema,
      ...confirmationParams,
    },
    async ({ pageId, _executeFromButton }) => {
      const shouldExecute = _executeFromButton === true;

      if (!shouldExecute) {
        try {
          const page = await getConfluenceApi().getPage({ pageId, includeContent: false });

          return createPreviewResponse(
            '⚠️ Preview: Confluence Page Deletion (DESTRUCTIVE)',
            {
              pageId,
              title: page.title,
              spaceKey: page.spaceKey,
              warning: '⚠️ This action CANNOT be undone. The page will be permanently deleted.',
            },
            'deletion',
            {
              tool: CONFLUENCE_DELETE_PAGE,
              params: { pageId },
            }
          );
        } catch (error) {
          return createPreviewResponse(
            '⚠️ Preview: Confluence Page Deletion (DESTRUCTIVE)',
            {
              pageId,
              warning: '⚠️ This action CANNOT be undone. The page will be permanently deleted.',
            },
            'deletion',
            {
              tool: CONFLUENCE_DELETE_PAGE,
              params: { pageId },
            }
          );
        }
      }

      try {
        await getConfluenceApi().deletePage({ pageId });
        return {
          content: [{ type: 'text' as const, text: `Successfully deleted Confluence page ${pageId}` }],
        };
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );
}
