/**
 * Atlassian MCP Server - Jira User Tools
 *
 * Tools for user operations: current user, search users, watchers.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getErrorMessage } from '@bike4mind/common';
import { getJiraApi } from '../client.js';
import { createJsonResponse, createErrorResponse } from '../helpers/responses.js';
import { issueKeySchema, userIdentifierSchema } from '../helpers/schemas.js';
import {
  JIRA_GET_CURRENT_USER,
  JIRA_SEARCH_USERS,
  JIRA_LIST_WATCHERS,
  JIRA_ADD_WATCHER,
  JIRA_REMOVE_WATCHER,
} from '../constants.js';

export function registerJiraUserTools(server: McpServer) {
  // GET CURRENT USER
  server.tool(
    JIRA_GET_CURRENT_USER,
    'Get information about the currently authenticated Jira user. Returns user account details.',
    {},
    async () => {
      try {
        const user = await getJiraApi().getCurrentUser();
        return createJsonResponse(user);
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );

  // SEARCH USERS
  server.tool(
    JIRA_SEARCH_USERS,
    'Search for Atlassian users by name, email, or username. Returns matching users with their Atlassian account IDs. IMPORTANT: Use this tool to find account IDs before calling jira_assign_issue OR confluence_add_page_restriction. Atlassian accounts are unified, so account IDs work across both Jira and Confluence. For Slack mentions, remove the @ prefix.',
    {
      query: z
        .string()
        .describe('Search query - can be a name, email address, or username (partial matches supported).'),
      maxResults: z
        .number()
        .min(1)
        .max(100)
        .optional()
        .describe('Maximum number of users to return (default 50, max 100).'),
    },
    async ({ query, maxResults }) => {
      try {
        const users = await getJiraApi().searchUsers({ query, maxResults });
        return createJsonResponse(users);
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );

  // LIST WATCHERS
  server.tool(
    JIRA_LIST_WATCHERS,
    'Get all watchers for a Jira issue. Returns the list of users watching the issue and the total watcher count.',
    {
      issueKey: issueKeySchema,
    },
    async ({ issueKey }) => {
      try {
        const result = await getJiraApi().getWatchers({ issueKey });
        return createJsonResponse(result);
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );

  // ADD WATCHER
  server.tool(
    JIRA_ADD_WATCHER,
    'Add a user as a watcher to a Jira issue. Supports account ID, email, or name (searches for user if not an account ID).',
    {
      issueKey: issueKeySchema,
      userIdentifier: userIdentifierSchema,
    },
    async ({ issueKey, userIdentifier }) => {
      try {
        let accountId = userIdentifier;

        if (userIdentifier.includes('@') || userIdentifier.includes(' ') || userIdentifier.length < 16) {
          const users = await getJiraApi().searchUsers({ query: userIdentifier, maxResults: 1 });
          if (users.length === 0) {
            return {
              content: [{ type: 'text' as const, text: `Error: User '${userIdentifier}' not found.` }],
              isError: true,
            };
          }
          accountId = users[0].accountId;
        }

        await getJiraApi().addWatcher({ issueKey, accountId });
        return {
          content: [
            {
              type: 'text' as const,
              text: `Successfully added watcher ${accountId} (from '${userIdentifier}') to issue ${issueKey}`,
            },
          ],
        };
      } catch (error) {
        const errorMessage = getErrorMessage(error);
        if (errorMessage.includes('403') || errorMessage.includes('401')) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Error: Permission denied. You may not have permission to manage watchers for this issue, or the user cannot be added as a watcher.`,
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

  // REMOVE WATCHER
  server.tool(
    JIRA_REMOVE_WATCHER,
    'Remove a watcher from a Jira issue. Supports account ID, email, or name (searches for user if not an account ID).',
    {
      issueKey: issueKeySchema,
      userIdentifier: userIdentifierSchema,
    },
    async ({ issueKey, userIdentifier }) => {
      try {
        let accountId = userIdentifier;

        if (userIdentifier.includes('@') || userIdentifier.includes(' ') || userIdentifier.length < 16) {
          const users = await getJiraApi().searchUsers({ query: userIdentifier, maxResults: 1 });
          if (users.length === 0) {
            return {
              content: [{ type: 'text' as const, text: `Error: User '${userIdentifier}' not found.` }],
              isError: true,
            };
          }
          accountId = users[0].accountId;
        }

        await getJiraApi().removeWatcher({ issueKey, accountId });
        return {
          content: [
            {
              type: 'text' as const,
              text: `Successfully removed watcher ${accountId} (from '${userIdentifier}') from issue ${issueKey}`,
            },
          ],
        };
      } catch (error) {
        const errorMessage = getErrorMessage(error);
        if (errorMessage.includes('403') || errorMessage.includes('401')) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Error: Permission denied. You may not have permission to remove watchers from this issue.`,
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
}
