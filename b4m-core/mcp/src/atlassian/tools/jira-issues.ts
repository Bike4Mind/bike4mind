/**
 * Atlassian MCP Server - Jira Issue Tools
 *
 * Tools for getting, creating, updating, searching, and deleting Jira issues.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getJiraApi } from '../client.js';
import { createJsonResponse, createErrorResponse } from '../helpers/responses.js';
import { createPreviewResponse } from '../../shared/confirmation-helpers.js';
import { confirmationParams } from '../../shared/schemas.js';
import { issueKeySchema, projectKeySchema, issueTypeNameSchema, paginationParams } from '../helpers/schemas.js';
import {
  JIRA_GET_ISSUE,
  JIRA_CREATE_ISSUE,
  JIRA_BULK_CREATE_ISSUES,
  JIRA_UPDATE_ISSUE,
  JIRA_BULK_UPDATE_ISSUES,
  JIRA_SEARCH_ISSUES,
  JIRA_DELETE_ISSUE,
} from '../constants.js';

export function registerJiraIssueTools(server: McpServer) {
  // GET ISSUE
  server.tool(
    JIRA_GET_ISSUE,
    'Retrieve a Jira issue by key (e.g., PROJ-123). Returns issue details including summary, description, status, assignee, and custom fields.',
    {
      issueKey: issueKeySchema,
      expand: z.array(z.string()).optional().describe('Optional fields to expand (e.g., changelog, transitions).'),
    },
    async ({ issueKey, expand }) => {
      try {
        const issue = await getJiraApi().getIssue({ issueKey, expand });
        return createJsonResponse(issue);
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );

  // CREATE ISSUE
  server.tool(
    JIRA_CREATE_ISSUE,
    'Create a SINGLE Jira issue only. WARNING: If you need to create 2 or more issues/subtasks/sub-tickets/tickets, use jira_bulk_create_issues instead - do NOT call this tool multiple times. Requires project key, summary, issue type name. Optionally set description, priority, assignee, labels, and parent (for subtasks). Returns the issue ID, key, and a clickable link to view the issue.',
    {
      projectKey: projectKeySchema,
      summary: z.string().describe('Issue summary/title.'),
      description: z.string().optional().describe('Issue description (plain text).'),
      issueTypeName: issueTypeNameSchema,
      priority: z.string().optional().describe('Priority name (e.g., High, Medium, Low).'),
      assignee: z.string().optional().describe('Assignee account ID.'),
      labels: z.array(z.string()).optional().describe('Labels to apply to the issue.'),
      parentKey: z
        .string()
        .optional()
        .describe(
          'Parent issue key (e.g., PROJ-123). REQUIRED when creating subtasks. The parent must be an existing issue in the same project.'
        ),
      ...confirmationParams,
    },
    async ({
      projectKey,
      summary,
      description,
      issueTypeName,
      assignee,
      labels,
      parentKey,
      confirmed,
      _executeFromButton,
    }) => {
      const shouldExecute = _executeFromButton === true;

      if (!shouldExecute) {
        return createPreviewResponse(
          '📋 Preview: Jira Issue to be Created',
          {
            project: projectKey,
            type: issueTypeName || 'Task',
            summary,
            description: description || '[No description]',
            priority: '[Default]',
            assignee: assignee || '[Unassigned]',
            labels: labels || [],
            parentKey: parentKey || null,
          },
          'issue',
          {
            tool: JIRA_CREATE_ISSUE,
            params: { projectKey, summary, description, issueTypeName, assignee, labels, parentKey },
          }
        );
      }

      try {
        const issue = await getJiraApi().createIssue({
          projectKey,
          summary,
          description,
          issueTypeName,
          assignee,
          labels,
          parentKey,
        });
        return createJsonResponse(issue);
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );

  // BULK CREATE ISSUES
  server.tool(
    JIRA_BULK_CREATE_ISSUES,
    'ALWAYS USE THIS TOOL when creating 2 or more Jira issues, subtasks, or sub-tickets. Creates multiple issues in a single API call - DO NOT call jira_create_issue multiple times. Use cases: creating subtasks under an epic/story, creating multiple related tasks, breaking down work into sub-tickets. Supports up to 50 issues per request. Returns all created issue IDs, keys, and clickable links.',
    {
      issues: z
        .array(
          z.object({
            projectKey: projectKeySchema,
            summary: z.string().describe('Issue summary/title.'),
            description: z.string().optional().describe('Issue description (plain text).'),
            issueTypeName: issueTypeNameSchema,
            assignee: z.string().optional().describe('Assignee account ID.'),
            labels: z.array(z.string()).optional().describe('Labels to apply to the issue.'),
            parentKey: z
              .string()
              .optional()
              .describe(
                'Parent issue key (e.g., PROJ-123). REQUIRED for all issues when creating subtasks. All subtasks must have the same parent.'
              ),
          })
        )
        .min(1)
        .max(50)
        .describe(
          'Array of issues to create (1-50 issues). For subtasks, include parentKey in each issue object pointing to the parent issue.'
        ),
    },
    async ({ issues }) => {
      try {
        const result = await getJiraApi().bulkCreateIssues({ issues });

        const response: {
          success: boolean;
          created: number;
          failed: number;
          issues: typeof result.issues;
          errors?: typeof result.errors;
        } = {
          success: result.issues.length > 0,
          created: result.issues.length,
          failed: result.errors.length,
          issues: result.issues,
        };

        if (result.errors.length > 0) {
          response.errors = result.errors;
        }

        return createJsonResponse(response);
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );

  // BULK UPDATE ISSUES
  server.tool(
    JIRA_BULK_UPDATE_ISSUES,
    'ALWAYS USE THIS TOOL when updating labels on 2 or more Jira issues. Updates multiple issues in a single API call - DO NOT call jira_update_issue multiple times. Use cases: mass label updates, bulk tagging for organization, adding/removing labels across multiple issues. Supports up to 1000 issues per request. Specify action: ADD (append new labels), REMOVE (delete existing labels), or SET (replace all labels). LIMITATIONS: Only labels are supported - use individual update tools (jira_update_issue) for other fields like summary, description, priority, assignee, etc. Returns a task ID for tracking the async operation.',
    {
      issueIdsOrKeys: z
        .array(z.string())
        .min(1)
        .max(1000)
        .describe('Array of issue IDs or keys to update (1-1000 issues). Example: ["PROJ-1", "PROJ-2", "PROJ-3"].'),
      labels: z
        .object({
          values: z.array(z.string()).describe('Array of label names to add, remove, or set.'),
          action: z
            .enum(['ADD', 'REMOVE', 'SET'])
            .describe(
              'ADD: append labels to existing ones, REMOVE: delete these labels, SET: replace all labels with these.'
            ),
        })
        .describe('Labels to modify with action (ADD/REMOVE/SET).'),
    },
    async ({ issueIdsOrKeys, labels }) => {
      try {
        const result = await getJiraApi().bulkUpdateIssues({ issueIdsOrKeys, labels });

        return createJsonResponse({
          success: true,
          taskId: result.taskId,
          issueCount: result.issueCount,
          message: result.message,
          note: 'This is an async operation. The updates will be processed in the background by Jira.',
        });
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );

  // UPDATE ISSUE
  server.tool(
    JIRA_UPDATE_ISSUE,
    'Update an existing Jira issue. Can update summary, description, priority, labels, and other fields.',
    {
      issueKey: issueKeySchema,
      summary: z.string().optional().describe('New summary/title.'),
      description: z.string().optional().describe('New description (plain text).'),
      priority: z.string().optional().describe('New priority name.'),
      labels: z.array(z.string()).optional().describe('New labels (replaces existing).'),
      ...confirmationParams,
    },
    async ({ issueKey, summary, description, priority, labels, _executeFromButton }) => {
      const shouldExecute = _executeFromButton === true;

      if (!shouldExecute) {
        return createPreviewResponse(
          '📋 Preview: Jira Issue Update',
          {
            issueKey,
            changes: {
              summary: summary || '[Keep existing]',
              description: description || '[Keep existing]',
              priority: priority || '[Keep existing]',
              labels: labels !== undefined ? labels : '[Keep existing]',
            },
          },
          'update',
          {
            tool: JIRA_UPDATE_ISSUE,
            params: { issueKey, summary, description, priority, labels },
          }
        );
      }

      try {
        await getJiraApi().updateIssue({
          issueKey,
          summary,
          description,
          priority,
          labels,
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: true, issueKey }, null, 2) }],
        };
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );

  // SEARCH ISSUES
  server.tool(
    JIRA_SEARCH_ISSUES,
    'Search for Jira issues using JQL (Jira Query Language). Returns matching issues with full details.',
    {
      jql: z.string().describe('JQL query string (e.g., "project = PROJ AND status = Open").'),
      ...paginationParams,
      maxResults: z.number().min(1).max(100).optional().describe('Maximum number of results (default 50, max 100).'),
      fields: z.array(z.string()).optional().describe('Fields to include in response (default all).'),
      expand: z.array(z.string()).optional().describe('Optional fields to expand.'),
    },
    async ({ jql, startAt, maxResults, fields, expand }) => {
      try {
        const result = await getJiraApi().searchIssues({ jql, startAt, maxResults, fields, expand });
        return createJsonResponse(result);
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );

  // DELETE ISSUE
  server.tool(
    JIRA_DELETE_ISSUE,
    '⚠️ DESTRUCTIVE: This PERMANENTLY deletes a Jira issue. Cannot be undone.',
    {
      issueKey: issueKeySchema,
      ...confirmationParams,
    },
    async ({ issueKey, _executeFromButton }) => {
      const shouldExecute = _executeFromButton === true;

      if (!shouldExecute) {
        try {
          const issue = await getJiraApi().getIssue({ issueKey });

          return createPreviewResponse(
            '⚠️ Preview: Jira Issue Deletion (DESTRUCTIVE)',
            {
              issueKey,
              summary: issue.summary,
              status: issue.status,
              type: issue.issueType,
              warning: '⚠️ This action CANNOT be undone. The issue will be permanently deleted.',
            },
            'deletion',
            {
              tool: JIRA_DELETE_ISSUE,
              params: { issueKey },
            }
          );
        } catch (error) {
          return createPreviewResponse(
            '⚠️ Preview: Jira Issue Deletion (DESTRUCTIVE)',
            {
              issueKey,
              warning: '⚠️ This action CANNOT be undone. The issue will be permanently deleted.',
            },
            'deletion',
            {
              tool: JIRA_DELETE_ISSUE,
              params: { issueKey },
            }
          );
        }
      }

      try {
        await getJiraApi().deleteIssue({ issueKey });
        return {
          content: [{ type: 'text' as const, text: `Successfully deleted issue ${issueKey}` }],
        };
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );
}
