/**
 * Atlassian MCP Server - Jira Project Tools
 *
 * Tools for listing projects, getting project details, and listing issue types.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getJiraApi } from '../client.js';
import { createJsonResponse, createErrorResponse } from '../helpers/responses.js';
import { projectKeySchema } from '../helpers/schemas.js';
import {
  JIRA_LIST_PROJECTS,
  JIRA_GET_PROJECT,
  JIRA_LIST_ISSUE_TYPES,
  JIRA_LIST_PROJECT_MEMBERS,
} from '../constants.js';

export function registerJiraProjectTools(server: McpServer) {
  // LIST PROJECTS
  server.tool(
    JIRA_LIST_PROJECTS,
    'List all accessible Jira projects. Returns project keys, names, and details. Use this to discover project keys when creating or updating issues.',
    {
      maxResults: z
        .number()
        .optional()
        .describe(
          'Maximum number of projects to return (default 50). Use this to limit results for better performance.'
        ),
      query: z
        .string()
        .optional()
        .describe('Search query to filter projects by name or key (e.g., "Mobile" to find "Mobile App" project).'),
      expand: z.string().optional().describe('Fields to expand (e.g., description, lead, issueTypes).'),
    },
    async ({ maxResults, query, expand }) => {
      try {
        const projects = await getJiraApi().listProjects({ maxResults, query, expand });
        return createJsonResponse(projects);
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );

  // GET PROJECT
  server.tool(
    JIRA_GET_PROJECT,
    'Get detailed information about a specific Jira project.',
    {
      projectKey: projectKeySchema,
      expand: z.array(z.string()).optional().describe('Fields to expand (e.g., description, lead, issueTypes).'),
    },
    async ({ projectKey, expand }) => {
      try {
        const project = await getJiraApi().getProject({ projectKey, expand });
        return createJsonResponse(project);
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );

  // LIST ISSUE TYPES
  server.tool(
    JIRA_LIST_ISSUE_TYPES,
    'List available issue types for a project (e.g., Task, Epic, Subtask). Use this to discover available issue type names, especially for projects with custom issue types.',
    {
      projectKey: projectKeySchema,
    },
    async ({ projectKey }) => {
      try {
        const issueTypes = await getJiraApi().listIssueTypes({ projectKey });
        return createJsonResponse(issueTypes);
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );

  // LIST ALL PROJECT MEMBERS
  server.tool(
    JIRA_LIST_PROJECT_MEMBERS,
    'List ALL members of a Jira project grouped by role, with a deduplicated flat list of all unique members. This is a convenience tool that fetches all roles and their members in one call. Use this when you need to know who is on a project or who the developers are.',
    {
      projectKey: projectKeySchema,
    },
    async ({ projectKey }) => {
      try {
        const members = await getJiraApi().getAllProjectMembers({ projectKey });
        return createJsonResponse(members);
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );
}
