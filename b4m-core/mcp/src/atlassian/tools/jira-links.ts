/**
 * Atlassian MCP Server - Jira Issue Link Tools
 *
 * Tools for managing issue links: list types, list/create/bulk create/delete links.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getErrorMessage } from '@bike4mind/common';
import { getJiraApi } from '../client.js';
import { createJsonResponse, createErrorResponse } from '../helpers/responses.js';
import { createPreviewResponse } from '../../shared/confirmation-helpers.js';
import { confirmationParams } from '../../shared/schemas.js';
import {
  JIRA_LIST_LINK_TYPES,
  JIRA_LIST_ISSUE_LINKS,
  JIRA_CREATE_ISSUE_LINK,
  JIRA_CREATE_ISSUE_LINKS,
  JIRA_DELETE_ISSUE_LINK,
} from '../constants.js';
import { issueKeySchema } from '../helpers/schemas.js';

export function registerJiraLinkTools(server: McpServer) {
  // LIST LINK TYPES
  server.tool(
    JIRA_LIST_LINK_TYPES,
    'List all available issue link types in the Jira instance. Returns link types like "Blocks", "Duplicates", "Relates to" with their inward/outward descriptions. Call this first to discover available link types before creating links.',
    {},
    async () => {
      try {
        const linkTypes = await getJiraApi().getIssueLinkTypes();
        return createJsonResponse(linkTypes);
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );

  // LIST ISSUE LINKS
  server.tool(
    JIRA_LIST_ISSUE_LINKS,
    'Get all issue links for a specific Jira issue. Returns all linked issues grouped by link type, including issue summaries and clickable URLs.',
    {
      issueKey: issueKeySchema,
    },
    async ({ issueKey }) => {
      try {
        const links = await getJiraApi().getIssueLinks({ issueKey });
        return createJsonResponse(links);
      } catch (error) {
        const errorMessage = getErrorMessage(error);
        if (errorMessage.includes('404')) {
          return {
            content: [{ type: 'text' as const, text: `Error: Issue '${issueKey}' not found.` }],
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

  // CREATE ISSUE LINK
  server.tool(
    JIRA_CREATE_ISSUE_LINK,
    'Create a link between two Jira issues to track dependencies, duplicates, or relationships. ' +
      'Use sourceIssue for the issue doing the action (e.g., PROJ-1 in "PROJ-1 blocks PROJ-2") and ' +
      'targetIssue for the issue being acted upon. Safe to retry - if the link already exists, the operation succeeds silently. ' +
      'Call jira_list_link_types first to see available link types.',
    {
      linkType: z.string().describe('Link type name (e.g., "Blocks", "Duplicates", "Relates"). Case-insensitive.'),
      sourceIssue: z
        .string()
        .describe('Source issue key - the issue doing the action (e.g., PROJ-1 in "PROJ-1 blocks PROJ-2").'),
      targetIssue: z
        .string()
        .describe('Target issue key - the issue being acted upon (e.g., PROJ-2 in "PROJ-1 blocks PROJ-2").'),
      ...confirmationParams,
    },
    async ({ linkType, sourceIssue, targetIssue, _executeFromButton }) => {
      const shouldExecute = _executeFromButton === true;

      if (!shouldExecute) {
        return createPreviewResponse(
          '📋 Preview: Jira Issue Link to be Created',
          {
            linkType,
            sourceIssue,
            targetIssue,
            relationship: `${sourceIssue} ${linkType.toLowerCase()} ${targetIssue}`,
          },
          'link',
          {
            tool: JIRA_CREATE_ISSUE_LINK,
            params: { linkType, sourceIssue, targetIssue },
          }
        );
      }

      try {
        await getJiraApi().createIssueLink({ linkType, sourceIssue, targetIssue });
        return {
          content: [
            {
              type: 'text' as const,
              text: `Successfully created link: ${sourceIssue} ${linkType.toLowerCase()} ${targetIssue}`,
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
                text: `Error: Permission denied. You may not have permission to create links on these issues.`,
              },
            ],
            isError: true,
          };
        }
        if (errorMessage.includes('400')) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Error: Invalid link type "${linkType}". Call jira_list_link_types to see available types.`,
              },
            ],
            isError: true,
          };
        }
        if (errorMessage.includes('404')) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Error: One or both issues not found. Check that ${sourceIssue} and ${targetIssue} exist.`,
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

  // BULK CREATE ISSUE LINKS
  server.tool(
    JIRA_CREATE_ISSUE_LINKS,
    'Create multiple issue links at once (max 10 per call to respect rate limits). ' +
      'Each link specifies linkType, sourceIssue, and targetIssue. ' +
      'Safe to retry - existing links are silently skipped.',
    {
      links: z
        .array(
          z.object({
            linkType: z.string().describe('Link type name (e.g., "Blocks", "Duplicates").'),
            sourceIssue: z.string().describe('Source issue key.'),
            targetIssue: z.string().describe('Target issue key.'),
          })
        )
        .min(1)
        .max(10)
        .describe('Array of links to create (max 10 to respect rate limits).'),
      ...confirmationParams,
    },
    async ({ links, _executeFromButton }) => {
      const shouldExecute = _executeFromButton === true;

      if (!shouldExecute) {
        return createPreviewResponse(
          '📋 Preview: Jira Issue Links to be Created',
          {
            count: links.length,
            links: links.map(l => ({
              relationship: `${l.sourceIssue} ${l.linkType.toLowerCase()} ${l.targetIssue}`,
            })),
          },
          'links',
          {
            tool: JIRA_CREATE_ISSUE_LINKS,
            params: { links },
          }
        );
      }

      const results: { success: string[]; errors: string[] } = { success: [], errors: [] };
      const DELAY_MS = 100;

      for (let i = 0; i < links.length; i++) {
        const link = links[i];
        try {
          await getJiraApi().createIssueLink({
            linkType: link.linkType,
            sourceIssue: link.sourceIssue,
            targetIssue: link.targetIssue,
          });
          results.success.push(`${link.sourceIssue} ${link.linkType.toLowerCase()} ${link.targetIssue}`);
        } catch (error) {
          results.errors.push(`${link.sourceIssue} → ${link.targetIssue}: ${getErrorMessage(error)}`);
        }

        if (i < links.length - 1) {
          await new Promise(resolve => setTimeout(resolve, DELAY_MS));
        }
      }

      return createJsonResponse({
        created: results.success.length,
        failed: results.errors.length,
        success: results.success,
        errors: results.errors.length > 0 ? results.errors : undefined,
      });
    }
  );

  // DELETE ISSUE LINK
  server.tool(
    JIRA_DELETE_ISSUE_LINK,
    'Delete a link between two Jira issues by providing both issue keys and the link type. ' +
      'The tool will automatically find and delete the matching link. ' +
      'If the link does not exist, the operation succeeds with a message indicating the link was not found.',
    {
      sourceIssue: z.string().describe('One of the linked issue keys (e.g., PROJ-1).'),
      targetIssue: z.string().describe('The other linked issue key (e.g., PROJ-2).'),
      linkType: z.string().describe('Link type name (e.g., "Blocks", "Duplicates"). Case-insensitive.'),
      ...confirmationParams,
    },
    async ({ sourceIssue, targetIssue, linkType, _executeFromButton }) => {
      const shouldExecute = _executeFromButton === true;

      if (!shouldExecute) {
        return createPreviewResponse(
          '⚠️ Preview: Jira Issue Link to be Deleted',
          {
            linkType,
            sourceIssue,
            targetIssue,
            relationship: `${sourceIssue} ${linkType.toLowerCase()} ${targetIssue}`,
          },
          'link',
          {
            tool: JIRA_DELETE_ISSUE_LINK,
            params: { sourceIssue, targetIssue, linkType },
          }
        );
      }

      try {
        const linkId = await getJiraApi().findIssueLink({
          issueKey: sourceIssue,
          linkedIssueKey: targetIssue,
          linkType,
        });

        if (!linkId) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Link not found between ${sourceIssue} and ${targetIssue} with type "${linkType}". It may have already been deleted.`,
              },
            ],
          };
        }

        await getJiraApi().deleteIssueLink({ linkId });
        return {
          content: [
            {
              type: 'text' as const,
              text: `Successfully deleted link: ${sourceIssue} ${linkType.toLowerCase()} ${targetIssue}`,
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
                text: `Error: Permission denied. You may not have permission to delete links on these issues.`,
              },
            ],
            isError: true,
          };
        }
        if (errorMessage.includes('404')) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Link not found. The link between ${sourceIssue} and ${targetIssue} may have already been deleted.`,
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
