/**
 * Atlassian MCP Server - Jira Agile Tools
 *
 * Tools for boards, sprints, board configuration, and board/sprint issues.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getJiraApi } from '../client.js';
import { createJsonResponse, createErrorResponse, createTextResponse } from '../helpers/responses.js';
import { boardIdSchema, sprintIdSchema, paginationParams } from '../helpers/schemas.js';
import {
  JIRA_LIST_BOARDS,
  JIRA_GET_BOARD,
  JIRA_LIST_SPRINTS,
  JIRA_GET_SPRINT,
  JIRA_CREATE_SPRINT,
  JIRA_UPDATE_SPRINT,
  JIRA_GET_SPRINT_ISSUES,
  JIRA_MOVE_ISSUES_TO_SPRINT,
  JIRA_GET_BOARD_CONFIGURATION,
  JIRA_GET_BOARD_ISSUES,
} from '../constants.js';

export function registerJiraAgileTools(server: McpServer) {
  // LIST BOARDS
  server.tool(
    JIRA_LIST_BOARDS,
    'List all Jira boards (Scrum/Kanban) visible to the user. Can filter by project or board type. Requires Jira Software license.',
    {
      projectKeyOrId: z.string().optional().describe('Filter boards by project key or ID.'),
      type: z.enum(['scrum', 'kanban', 'simple']).optional().describe('Filter by board type.'),
      name: z.string().optional().describe('Filter boards by name (partial match).'),
      ...paginationParams,
    },
    async ({ projectKeyOrId, type, name, startAt, maxResults }) => {
      try {
        const result = await getJiraApi().agile.listBoards({ projectKeyOrId, type, name, startAt, maxResults });
        return createJsonResponse(result);
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );

  // GET BOARD
  server.tool(
    JIRA_GET_BOARD,
    'Get details of a specific Jira board by ID. Returns board name, type, and associated project.',
    {
      boardId: boardIdSchema,
    },
    async ({ boardId }) => {
      try {
        const board = await getJiraApi().agile.getBoard({ boardId });
        return createJsonResponse(board);
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );

  // LIST SPRINTS
  server.tool(
    JIRA_LIST_SPRINTS,
    'List sprints for a specific Jira board. Can filter by sprint state (future, active, closed).',
    {
      boardId: boardIdSchema,
      state: z
        .enum(['future', 'active', 'closed', 'future,active', 'active,closed'])
        .optional()
        .describe('Filter by sprint state. Use comma-separated values for multiple states.'),
      ...paginationParams,
    },
    async ({ boardId, state, startAt, maxResults }) => {
      try {
        const result = await getJiraApi().agile.listSprints({ boardId, state, startAt, maxResults });
        return createJsonResponse(result);
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );

  // GET SPRINT
  server.tool(
    JIRA_GET_SPRINT,
    'Get details of a specific sprint by ID. Returns sprint name, state, dates, and goal.',
    {
      sprintId: sprintIdSchema,
    },
    async ({ sprintId }) => {
      try {
        const sprint = await getJiraApi().agile.getSprint({ sprintId });
        return createJsonResponse(sprint);
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );

  // CREATE SPRINT
  server.tool(
    JIRA_CREATE_SPRINT,
    'Create a new sprint for a Scrum board. The sprint will be created in "future" state.',
    {
      name: z.string().describe('Name of the sprint (e.g., "Sprint 5").'),
      boardId: boardIdSchema,
      goal: z.string().optional().describe('The goal/objective for this sprint.'),
      startDate: z
        .string()
        .optional()
        .describe('Sprint start date in ISO 8601 format (e.g., "2024-01-15T09:00:00.000Z").'),
      endDate: z.string().optional().describe('Sprint end date in ISO 8601 format (e.g., "2024-01-29T17:00:00.000Z").'),
    },
    async ({ name, boardId, goal, startDate, endDate }) => {
      try {
        const sprint = await getJiraApi().agile.createSprint({
          name,
          originBoardId: boardId,
          goal,
          startDate,
          endDate,
        });
        return createJsonResponse(sprint);
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );

  // UPDATE SPRINT
  server.tool(
    JIRA_UPDATE_SPRINT,
    'Update an existing sprint. Can rename, set dates, set goal, start a sprint (state="active"), or close a sprint (state="closed"). Note: Closed sprints cannot be modified.',
    {
      sprintId: sprintIdSchema,
      name: z.string().optional().describe('New name for the sprint.'),
      goal: z.string().optional().describe('New goal for the sprint.'),
      startDate: z.string().optional().describe('Sprint start date in ISO 8601 format.'),
      endDate: z.string().optional().describe('Sprint end date in ISO 8601 format.'),
      state: z
        .enum(['active', 'closed'])
        .optional()
        .describe('Change sprint state: "active" to start the sprint, "closed" to complete it.'),
    },
    async ({ sprintId, name, goal, startDate, endDate, state }) => {
      try {
        const sprint = await getJiraApi().agile.updateSprint({ sprintId, name, goal, startDate, endDate, state });
        return createJsonResponse(sprint);
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );

  // GET SPRINT ISSUES
  server.tool(
    JIRA_GET_SPRINT_ISSUES,
    'Get all issues in a sprint. Supports JQL filtering and pagination.',
    {
      sprintId: sprintIdSchema,
      jql: z.string().optional().describe('Additional JQL to filter issues (e.g., "status = Done").'),
      ...paginationParams,
    },
    async ({ sprintId, jql, startAt, maxResults }) => {
      try {
        const result = await getJiraApi().agile.getSprintIssues({ sprintId, jql, startAt, maxResults });
        return createJsonResponse(result);
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );

  // MOVE ISSUES TO SPRINT
  server.tool(
    JIRA_MOVE_ISSUES_TO_SPRINT,
    'Move issues to a sprint. Issues can only be moved to future or active sprints. Maximum 50 issues per request.',
    {
      sprintId: sprintIdSchema,
      issues: z
        .array(z.string())
        .describe('Array of issue keys or IDs to move (e.g., ["PROJ-1", "PROJ-2"]). Maximum 50 issues.'),
    },
    async ({ sprintId, issues }) => {
      try {
        await getJiraApi().agile.moveIssuesToSprint({ sprintId, issues });
        return createTextResponse(
          `Successfully moved ${issues.length} issue(s) to sprint ${sprintId}: ${issues.join(', ')}`
        );
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );

  // GET BOARD CONFIGURATION
  server.tool(
    JIRA_GET_BOARD_CONFIGURATION,
    'Get detailed board configuration including columns, WIP limits, and swimlane settings. Useful for understanding board workflow structure.',
    {
      boardId: boardIdSchema,
    },
    async ({ boardId }) => {
      try {
        const config = await getJiraApi().agile.getBoardConfiguration({ boardId });
        return createJsonResponse(config);
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );

  // GET BOARD ISSUES
  server.tool(
    JIRA_GET_BOARD_ISSUES,
    'Get issues on a board with optional filtering and grouping. Supports JQL filtering and grouping by status, assignee, or epic.',
    {
      boardId: boardIdSchema,
      jql: z.string().optional().describe('Additional JQL to filter issues (e.g., "status = \'In Progress\'").'),
      groupBy: z
        .enum(['status', 'assignee', 'epic'])
        .optional()
        .describe('Group results by dimension. Useful for understanding workflow distribution.'),
      ...paginationParams,
    },
    async ({ boardId, jql, groupBy, startAt, maxResults }) => {
      try {
        const result = await getJiraApi().agile.getBoardIssues({ boardId, jql, groupBy, startAt, maxResults });
        return createJsonResponse(result);
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );
}
