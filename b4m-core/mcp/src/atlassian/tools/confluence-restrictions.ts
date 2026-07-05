/**
 * Atlassian MCP Server - Confluence Restriction Tools
 *
 * Tools for getting, adding, and removing page restrictions.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getConfluenceApi } from '../client.js';
import { createJsonResponse, createErrorResponse } from '../helpers/responses.js';
import { confirmationParams } from '../../shared/schemas.js';
import { pageIdSchema, pageRestrictionParamsSchema } from '../helpers/schemas.js';
import {
  normalizeRestrictions,
  createRestrictionPreview,
  executeRestrictionOperation,
} from '../helpers/restriction-helpers.js';
import {
  CONFLUENCE_GET_PAGE_RESTRICTIONS,
  CONFLUENCE_ADD_PAGE_RESTRICTION,
  CONFLUENCE_REMOVE_PAGE_RESTRICTION,
} from '../constants.js';

export function registerConfluenceRestrictionTools(server: McpServer) {
  // GET PAGE RESTRICTIONS
  server.tool(
    CONFLUENCE_GET_PAGE_RESTRICTIONS,
    'Get current access restrictions for a Confluence page. Returns users and groups that have read or edit restrictions. When a page has no restrictions, it inherits permissions from its parent page or space. IMPORTANT: If the user provides a page TITLE instead of an ID, first use confluence_search to find the page by title, then use the returned page ID with this tool.',
    {
      pageId: pageIdSchema,
    },
    async ({ pageId }) => {
      try {
        const restrictions = await getConfluenceApi().getPageRestrictions({ pageId });
        return createJsonResponse(restrictions);
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );

  // ADD PAGE RESTRICTION
  server.tool(
    CONFLUENCE_ADD_PAGE_RESTRICTION,
    'Add view or edit restrictions to a Confluence page. Supports BULK OPERATIONS for multiple users/groups with different access levels. Note: Adding any restriction makes the page explicitly restricted (it will no longer inherit from parent). REQUIRED WORKFLOW: (1) If the user provides a page TITLE instead of an ID, FIRST call confluence_search to find the page and get its numeric ID. (2) If the user provides USERNAMES, SLACK MENTIONS (like @JohnDoe), or FULL NAMES (John Doe) instead of account IDs, you MUST FIRST call jira_search_users for EACH user to look up their Atlassian account IDs. Atlassian account IDs look like "712020:89d4daa3-05d6-413a-82be-4b36a33bafe2" - they are NOT usernames like "john.doe". For BULK OPERATIONS: use the "restrictions" array parameter instead of individual operation/restrictionType/subject params.',
    {
      ...pageRestrictionParamsSchema,
      ...confirmationParams,
    },
    async ({ pageId, operation, restrictionType, subject, restrictions, _executeFromButton }) => {
      const normalized = normalizeRestrictions({ operation, restrictionType, subject, restrictions });
      if ('error' in normalized) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${normalized.error}` }],
          isError: true,
        };
      }
      const restrictionsList = normalized;

      const shouldExecute = _executeFromButton === true;

      if (!shouldExecute) {
        return createRestrictionPreview({
          pageId,
          restrictions: restrictionsList,
          tool: CONFLUENCE_ADD_PAGE_RESTRICTION,
          action: 'add',
          getConfluenceApi,
        });
      }

      return executeRestrictionOperation({
        pageId,
        restrictions: restrictionsList,
        action: 'add',
        getConfluenceApi,
      });
    }
  );

  // REMOVE PAGE RESTRICTION
  server.tool(
    CONFLUENCE_REMOVE_PAGE_RESTRICTION,
    'Remove view or edit restrictions from a Confluence page. Supports BULK OPERATIONS for multiple users/groups. If all restrictions are removed, the page will inherit permissions from its parent page or space. REQUIRED WORKFLOW: (1) If the user provides a page TITLE instead of an ID, FIRST call confluence_search to find the page and get its numeric ID. (2) If the user provides USERNAMES, SLACK MENTIONS (like @JohnDoe), or FULL NAMES (John Doe) instead of account IDs, you MUST FIRST call jira_search_users for EACH user to look up their Atlassian account IDs. Atlassian account IDs look like "712020:89d4daa3-05d6-413a-82be-4b36a33bafe2" - they are NOT usernames like "john.doe". For BULK OPERATIONS: use the "restrictions" array parameter instead of individual operation/restrictionType/subject params.',
    {
      ...pageRestrictionParamsSchema,
      ...confirmationParams,
    },
    async ({ pageId, operation, restrictionType, subject, restrictions, _executeFromButton }) => {
      const normalized = normalizeRestrictions({ operation, restrictionType, subject, restrictions });
      if ('error' in normalized) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${normalized.error}` }],
          isError: true,
        };
      }
      const restrictionsList = normalized;

      const shouldExecute = _executeFromButton === true;

      if (!shouldExecute) {
        return createRestrictionPreview({
          pageId,
          restrictions: restrictionsList,
          tool: CONFLUENCE_REMOVE_PAGE_RESTRICTION,
          action: 'remove',
          getConfluenceApi,
        });
      }

      return executeRestrictionOperation({
        pageId,
        restrictions: restrictionsList,
        action: 'remove',
        getConfluenceApi,
      });
    }
  );
}
