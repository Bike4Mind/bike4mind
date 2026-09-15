/**
 * Atlassian MCP Server - Jira Workflow Tools
 *
 * Tools for comments, transitions, bulk transitions, and issue assignment.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getJiraApi } from '../client.js';
import { createJsonResponse, createErrorResponse } from '../helpers/responses.js';
import { issueKeySchema } from '../helpers/schemas.js';
import { createPreviewResponse } from '../../shared/confirmation-helpers.js';
import { confirmationParams } from '../../shared/schemas.js';
import {
  JIRA_ADD_COMMENT,
  JIRA_GET_TRANSITIONS,
  JIRA_UPDATE_ISSUE_TRANSITION,
  JIRA_BULK_TRANSITION_ISSUES,
  JIRA_ASSIGN_ISSUE,
} from '../constants.js';

export function registerJiraWorkflowTools(server: McpServer) {
  // ADD COMMENT
  server.tool(
    JIRA_ADD_COMMENT,
    'Add a comment to a Jira issue.',
    {
      issueKey: issueKeySchema,
      body: z.string().describe('Comment text (plain text).'),
    },
    async ({ issueKey, body }) => {
      try {
        const comment = await getJiraApi().addComment({ issueKey, body });
        return createJsonResponse(comment);
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );

  // GET TRANSITIONS
  server.tool(
    JIRA_GET_TRANSITIONS,
    'Get available workflow transitions for a Jira issue. Returns the list of possible status changes (transitions) that can be performed on the issue from its current state. Use this before calling jira_update_issue_transition to see what transitions are available and choose the appropriate one based on user intent.',
    {
      issueKey: issueKeySchema,
    },
    async ({ issueKey }) => {
      try {
        const result = await getJiraApi().getTransitions({ issueKey });
        return createJsonResponse(result);
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );

  // UPDATE ISSUE TRANSITION
  server.tool(
    JIRA_UPDATE_ISSUE_TRANSITION,
    'Execute a workflow transition to change the status of a Jira issue. IMPORTANT: Before using this tool, first call jira_get_transitions to get available transitions and their IDs, then select the appropriate transition ID based on user intent. If the user provides context about the change, include it in the comment parameter. Provide ticket/issue link after update.',
    {
      issueKey: issueKeySchema,
      transitionId: z
        .string()
        .describe(
          'The transition ID from jira_get_transitions (e.g., "31"). Use the id field from the transition object that has the desired to.name status.'
        ),
      comment: z
        .string()
        .optional()
        .describe(
          'Optional comment to add during the transition. If the user mentions why they are changing the status or what they are doing (e.g., "I am working on this now", "Blocked by X", "Ready for review"), include that context here.'
        ),
      ...confirmationParams,
    },
    async ({ issueKey, transitionId, comment, _executeFromButton }) => {
      const execParams = {
        tool: JIRA_UPDATE_ISSUE_TRANSITION,
        params: { issueKey, transitionId, comment },
      };

      const shouldExecute = _executeFromButton === true;

      if (!shouldExecute) {
        try {
          const transitions = await getJiraApi().getTransitions({ issueKey });
          const selectedTransition = transitions.transitions.find(t => t.id === transitionId);

          return createPreviewResponse(
            '📋 Preview: Jira Issue Status Change',
            {
              issueKey,
              transitionId,
              statusChange: selectedTransition
                ? `→ ${selectedTransition.to?.name ?? selectedTransition.name ?? 'new status'}`
                : '[Unknown transition]',
              comment: comment || null,
            },
            'change',
            execParams
          );
        } catch (error) {
          return createPreviewResponse(
            '📋 Preview: Jira Issue Status Change',
            {
              issueKey,
              transitionId,
              comment: comment || null,
            },
            'change',
            execParams
          );
        }
      }

      try {
        const transitionResult = await getJiraApi().transitionIssue({ issueKey, transitionId });

        if (comment) {
          await getJiraApi().addComment({ issueKey, body: comment });
        }

        const result = {
          ...transitionResult,
          commentAdded: !!comment,
        };

        return createJsonResponse(result);
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );

  // BULK TRANSITION ISSUES
  server.tool(
    JIRA_BULK_TRANSITION_ISSUES,
    'ALWAYS USE THIS TOOL when transitioning 2 or more Jira issues to new statuses. Transitions multiple issues in a single API call - DO NOT call jira_update_issue_transition multiple times. Use cases: moving multiple issues to "Done", bulk status changes for sprint cleanup, batch workflow transitions. Supports up to 1000 issues per request. IMPORTANT: First call jira_get_transitions on a representative issue to get valid transition IDs. Returns a task ID for tracking the async operation.',
    {
      issues: z
        .array(
          z.object({
            issueIdOrKey: z.string().describe('The issue ID or key (e.g., "PROJ-123" or "10001").'),
            transitionId: z.string().describe('The transition ID to apply (get from jira_get_transitions).'),
          })
        )
        .min(1)
        .max(1000)
        .describe('Array of issues to transition (1-1000 issues). Each issue specifies its target transition.'),
    },
    async ({ issues }) => {
      try {
        const result = await getJiraApi().bulkTransitionIssues({ issues });

        return createJsonResponse({
          success: true,
          taskId: result.taskId,
          issueCount: result.issueCount,
          message: result.message,
          note: 'This is an async operation. The transitions will be processed in the background by Jira.',
        });
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );

  // ASSIGN ISSUE
  server.tool(
    JIRA_ASSIGN_ISSUE,
    'Assign a Jira issue to a user. Use this to change the assignee of an issue. If user is not found, use jira_search_users to find the user and then use the accountId to assign the issue.',
    {
      issueKey: issueKeySchema,
      accountId: z.string().describe('The account ID of the user to assign the issue to.'),
      ...confirmationParams,
    },
    async ({ issueKey, accountId, _executeFromButton }) => {
      const execParams = {
        tool: JIRA_ASSIGN_ISSUE,
        params: { issueKey, accountId },
      };

      const shouldExecute = _executeFromButton === true;

      if (!shouldExecute) {
        try {
          const users = await getJiraApi().searchUsers({ query: accountId, maxResults: 1 });
          const user = users.find(u => u.accountId === accountId);
          const displayName = user?.displayName || accountId;

          return createPreviewResponse(
            '📋 Preview: Jira Issue Assignment',
            {
              issueKey,
              assignTo: displayName,
            },
            'assignment',
            execParams
          );
        } catch (error) {
          return createPreviewResponse(
            '📋 Preview: Jira Issue Assignment',
            {
              issueKey,
              assignTo: accountId,
            },
            'assignment',
            execParams
          );
        }
      }

      try {
        await getJiraApi().assignIssue({ issueKey, accountId });
        return {
          content: [{ type: 'text' as const, text: `Successfully assigned issue ${issueKey} to user ${accountId}` }],
        };
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );
}
