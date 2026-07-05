/**
 * GitHub MCP Server - Issue Tools
 *
 * Tools for issue creation, updates, listing, and comments.
 */

import { z } from 'zod';
import type { McpServer } from '../types.js';
import { octokit } from '../client.js';
import { githubToken } from '../config.js';
import { createSuccessResponse, createErrorResponse } from '../helpers/responses.js';
import {
  ownerSchema,
  repoSchema,
  issueNumberSchema,
  issueStateSchema,
  confirmationParams,
  paginationParams,
} from '../helpers/schemas.js';
import { getErrorMessage } from '../helpers/errors.js';
import { createPreviewResponse } from '../../shared/confirmation-helpers.js';
import {
  TOOL_CREATE_ISSUE,
  TOOL_UPDATE_ISSUE,
  TOOL_LIST_ISSUES,
  TOOL_GET_ISSUE,
  TOOL_CREATE_ISSUE_COMMENT,
} from '../constants.js';

export function registerIssueTools(server: McpServer) {
  // CREATE ISSUE - Most common operation
  server.tool(
    TOOL_CREATE_ISSUE,
    'Create a GitHub issue in a repository. Supports title, body, labels, and assignees.',
    {
      owner: ownerSchema,
      repo: repoSchema,
      title: z
        .string()
        .min(1, 'Title is required')
        .max(256, 'Title must be 256 characters or less')
        .transform(val => val.trim())
        .refine(val => val.length > 0, 'Title cannot be only whitespace')
        .describe('Issue title'),
      body: z.string().optional().describe('Issue body content (supports Markdown)'),
      labels: z.array(z.string()).optional().describe('Labels to apply to this issue'),
      assignees: z.array(z.string()).optional().describe('GitHub usernames to assign to this issue'),
      ...confirmationParams,
    },
    async ({ owner, repo, title, body, labels, assignees, confirmed, _executeFromButton }) => {
      const fullRepoName = `${owner}/${repo}`;

      // SECURITY: Only execute if called from button handler
      const shouldExecute = _executeFromButton === true;

      if (!shouldExecute) {
        return createPreviewResponse(
          '📋 Preview: GitHub Issue to be Created',
          {
            repository: fullRepoName,
            title,
            body: body || '[No description]',
            labels: labels || [],
            assignees: assignees || [],
          },
          'issue',
          {
            tool: TOOL_CREATE_ISSUE,
            params: { owner, repo, title, body, labels, assignees },
          }
        );
      }

      // CONFIRMED: Actually create the issue
      console.error(`[${TOOL_CREATE_ISSUE}] Attempting to create issue: ${fullRepoName} - "${title}"`);
      console.error(`[${TOOL_CREATE_ISSUE}] Token present: ${!!githubToken}`);
      console.error(`[${TOOL_CREATE_ISSUE}] Assignees received:`, JSON.stringify(assignees));

      // Log warning if assignees look like Slack User IDs
      if (assignees && assignees.length > 0) {
        const slackUserIds = assignees.filter(a => /^U[A-Z0-9]{10}$/.test(a));
        if (slackUserIds.length > 0) {
          console.error(
            `[${TOOL_CREATE_ISSUE}] WARNING: Detected potential Slack User IDs in assignees:`,
            slackUserIds
          );
          console.error(`[${TOOL_CREATE_ISSUE}] These will likely fail as GitHub usernames`);
        }
      }

      // Validate labels - only use labels that already exist in the repository
      let validatedLabels: string[] | undefined;
      let skippedLabels: string[] = [];
      if (labels && labels.length > 0) {
        try {
          const repoLabels = await octokit.issues.listLabelsForRepo({ owner, repo, per_page: 100 });
          const existingLabelNames = repoLabels.data.map(l => l.name.toLowerCase());
          validatedLabels = labels.filter(label => existingLabelNames.includes(label.toLowerCase()));
          skippedLabels = labels.filter(label => !existingLabelNames.includes(label.toLowerCase()));

          if (skippedLabels.length > 0) {
            console.error(`[${TOOL_CREATE_ISSUE}] ⚠️ Skipped non-existent labels:`, skippedLabels);
          }
          if (validatedLabels.length > 0) {
            console.error(`[${TOOL_CREATE_ISSUE}] ✅ Using valid labels:`, validatedLabels);
          }
        } catch (labelError) {
          console.error(`[${TOOL_CREATE_ISSUE}] ⚠️ Could not fetch repo labels, skipping labels:`, labelError);
          validatedLabels = undefined;
        }
      }

      try {
        const result = await octokit.issues.create({
          owner,
          repo,
          title,
          body,
          labels: validatedLabels,
          assignees,
        });

        console.error(`[${TOOL_CREATE_ISSUE}] SUCCESS: Created issue #${result.data.number}`);
        console.error(`[${TOOL_CREATE_ISSUE}] URL: ${result.data.html_url}`);

        return createSuccessResponse({
          issue_number: result.data.number,
          url: result.data.html_url,
          title: result.data.title,
          state: result.data.state,
          ...(validatedLabels && validatedLabels.length > 0 && { labels_applied: validatedLabels }),
          ...(skippedLabels.length > 0 && { labels_skipped: skippedLabels }),
        });
      } catch (error) {
        console.error(`[${TOOL_CREATE_ISSUE}] ERROR: ${getErrorMessage(error)}`);
        return createErrorResponse(error);
      }
    }
  );

  // UPDATE ISSUE - Modify existing issues
  server.tool(
    TOOL_UPDATE_ISSUE,
    'Update an existing GitHub issue. Can modify title, body, state, labels, assignees, and issue type (Bug/Feature/Task).',
    {
      owner: ownerSchema,
      repo: repoSchema,
      issue_number: issueNumberSchema,
      title: z.string().max(256, 'Title must be 256 characters or less').optional().describe('New issue title'),
      body: z.string().optional().describe('New issue body content (supports Markdown)'),
      state: z.enum(['open', 'closed']).optional().describe('Issue state (open or closed)'),
      labels: z.array(z.string()).optional().describe('Labels to set on this issue (replaces existing labels)'),
      assignees: z.array(z.string()).optional().describe('GitHub usernames to assign (replaces existing assignees)'),
      type: z
        .string()
        .optional()
        .describe(
          'Issue type name (e.g., "Bug", "Feature", "Task"). Use list_org_issue_types to get available types for the organization.'
        ),
      ...confirmationParams,
    },
    async ({
      owner,
      repo,
      issue_number,
      title,
      body,
      state,
      labels,
      assignees,
      type,
      confirmed,
      _executeFromButton,
    }) => {
      const fullRepoName = `${owner}/${repo}`;

      // SECURITY: Only execute if called from button handler
      const shouldExecute = _executeFromButton === true;

      if (!shouldExecute) {
        // Build changes object with only fields that are being updated
        const changes: Record<string, string | string[] | undefined> = {};
        if (title !== undefined) changes.title = title;
        if (body !== undefined) changes.body = body.length > 200 ? body.substring(0, 200) + '...' : body;
        if (state !== undefined) changes.state = state;
        if (labels !== undefined) changes.labels = labels;
        if (assignees !== undefined) changes.assignees = assignees;
        if (type !== undefined) changes.type = type;

        return createPreviewResponse(
          '📋 Preview: GitHub Issue Update',
          {
            repository: fullRepoName,
            issue_number,
            changes: Object.keys(changes).length > 0 ? changes : { note: 'No changes specified' },
          },
          'update',
          {
            tool: TOOL_UPDATE_ISSUE,
            params: { owner, repo, issue_number, title, body, state, labels, assignees, type },
          }
        );
      }

      // CONFIRMED: Actually update the issue
      console.error(`[${TOOL_UPDATE_ISSUE}] Attempting to update issue #${issue_number}: ${fullRepoName}`);

      try {
        // Build update payload with only provided fields
        const updateData: {
          title?: string;
          body?: string;
          state?: 'open' | 'closed';
          labels?: string[];
          assignees?: string[];
          type?: string;
        } = {};
        if (title !== undefined) updateData.title = title;
        if (body !== undefined) updateData.body = body;
        if (state !== undefined) updateData.state = state;
        if (labels !== undefined) updateData.labels = labels;
        if (assignees !== undefined) updateData.assignees = assignees;
        if (type !== undefined) updateData.type = type;

        const result = await octokit.issues.update({
          owner,
          repo,
          issue_number,
          ...updateData,
        });

        console.error(`[${TOOL_UPDATE_ISSUE}] SUCCESS: Updated issue #${result.data.number}`);
        console.error(`[${TOOL_UPDATE_ISSUE}] URL: ${result.data.html_url}`);

        return createSuccessResponse({
          issue_number: result.data.number,
          url: result.data.html_url,
          title: result.data.title,
          state: result.data.state,
          labels: result.data.labels.map(l => (typeof l === 'string' ? l : l.name)),
          assignees: result.data.assignees?.map(a => a.login) || [],
          updated_at: result.data.updated_at,
        });
      } catch (error) {
        console.error(`[${TOOL_UPDATE_ISSUE}] ERROR: ${getErrorMessage(error)}`);
        return createErrorResponse(error);
      }
    }
  );

  // LIST ISSUES - Discovery and tracking
  server.tool(
    TOOL_LIST_ISSUES,
    'List issues in a repository. Filter by state, labels, assignee, or issue type.',
    {
      owner: ownerSchema,
      repo: repoSchema,
      state: issueStateSchema,
      labels: z.string().optional().describe('Comma-separated list of label names to filter by'),
      assignee: z.string().optional().describe('Username to filter by assignee'),
      type: z
        .string()
        .optional()
        .describe('Filter by issue type name (e.g., "Bug", "Feature", "Task"). Native GitHub issue types.'),
      ...paginationParams,
    },
    async ({ owner, repo, state, labels, assignee, type, per_page, page }) => {
      const effectiveState = state || 'open';
      try {
        const result = await octokit.issues.listForRepo({
          owner,
          repo,
          state: effectiveState,
          labels,
          assignee,
          type,
          per_page: per_page || 30,
          page: page || 1,
        });

        return createSuccessResponse({
          total_count: result.data.length,
          issues: result.data.map(issue => ({
            number: issue.number,
            title: issue.title,
            state: issue.state,
            url: issue.html_url,
            labels: issue.labels.map(l => (typeof l === 'string' ? l : l.name)),
            assignees: issue.assignees?.map(a => a.login) || [],
            created_at: issue.created_at,
            updated_at: issue.updated_at,
            closed_at: issue.closed_at,
          })),
        });
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );

  // GET ISSUE - Get detailed information about a specific issue
  server.tool(
    TOOL_GET_ISSUE,
    {
      owner: ownerSchema,
      repo: repoSchema,
      issue_number: issueNumberSchema,
    },
    async ({ owner, repo, issue_number }) => {
      const fullRepoName = `${owner}/${repo}`;
      console.error(`[${TOOL_GET_ISSUE}] Attempting to get issue #${issue_number}: ${fullRepoName}`);

      try {
        const result = await octokit.issues.get({
          owner,
          repo,
          issue_number,
        });

        console.error(`[${TOOL_GET_ISSUE}] SUCCESS: Retrieved issue #${issue_number}`);
        console.error(`[${TOOL_GET_ISSUE}] URL: ${result.data.html_url}`);

        // Fetch project associations using GraphQL
        let projects: Array<{ id: string; title: string; url: string }> = [];
        try {
          const projectQuery = `
            query($nodeId: ID!) {
              node(id: $nodeId) {
                ... on Issue {
                  projectItems(first: 10) {
                    nodes {
                      project {
                        id
                        title
                        url
                      }
                    }
                  }
                }
              }
            }
          `;

          interface ProjectQueryResult {
            node: {
              projectItems: {
                nodes: Array<{
                  project: { id: string; title: string; url: string } | null;
                }>;
              };
            };
          }

          const projectResult = await octokit.graphql<ProjectQueryResult>(projectQuery, {
            nodeId: result.data.node_id,
          });
          projects = projectResult.node.projectItems.nodes
            .map(item => item.project)
            .filter((project): project is { id: string; title: string; url: string } => project !== null);
          console.error(
            `[${TOOL_GET_ISSUE}] Found ${projects.length} project(s) associated with issue #${issue_number}`
          );
        } catch (projectError) {
          console.error(`[${TOOL_GET_ISSUE}] Warning: Could not fetch project associations:`, projectError);
          // Continue without project data - not a fatal error
        }

        return createSuccessResponse({
          issue: {
            number: result.data.number,
            node_id: result.data.node_id,
            title: result.data.title,
            body: result.data.body,
            state: result.data.state,
            url: result.data.html_url,
            labels: result.data.labels.map(l => (typeof l === 'string' ? l : l.name)),
            assignees: result.data.assignees?.map(a => a.login) || [],
            user: result.data.user?.login,
            created_at: result.data.created_at,
            updated_at: result.data.updated_at,
            closed_at: result.data.closed_at,
            comments: result.data.comments,
            milestone: result.data.milestone?.title,
            type: result.data.type,
            projects: projects,
          },
        });
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );

  // CREATE ISSUE COMMENT - Add a comment to an existing issue
  server.tool(
    TOOL_CREATE_ISSUE_COMMENT,
    'Add a comment to an existing GitHub issue. Use this when someone asks to comment on an issue or leave feedback.',
    {
      owner: ownerSchema,
      repo: repoSchema,
      issue_number: issueNumberSchema.describe('Issue number to comment on'),
      body: z
        .string()
        .min(1, 'Comment body is required')
        .max(65536, 'Comment body must be 65536 characters or less')
        .describe('Comment body content (supports Markdown)'),
      ...confirmationParams,
    },
    async ({ owner, repo, issue_number, body, _executeFromButton }) => {
      const fullRepoName = `${owner}/${repo}`;

      // SECURITY: Only execute if called from button handler
      const shouldExecute = _executeFromButton === true;

      if (!shouldExecute) {
        return createPreviewResponse(
          '💬 Preview: GitHub Issue Comment',
          {
            repository: fullRepoName,
            issue_number,
            body,
          },
          'comment',
          {
            tool: TOOL_CREATE_ISSUE_COMMENT,
            params: { owner, repo, issue_number, body },
          }
        );
      }

      // CONFIRMED: Actually create the comment
      console.error(`[${TOOL_CREATE_ISSUE_COMMENT}] Attempting to comment on issue #${issue_number}: ${fullRepoName}`);

      try {
        const result = await octokit.issues.createComment({
          owner,
          repo,
          issue_number,
          body,
        });

        console.error(`[${TOOL_CREATE_ISSUE_COMMENT}] SUCCESS: Created comment on issue #${issue_number}`);
        console.error(`[${TOOL_CREATE_ISSUE_COMMENT}] URL: ${result.data.html_url}`);

        return createSuccessResponse({
          comment_id: result.data.id,
          issue_number,
          url: result.data.html_url,
          body_preview: body.substring(0, 100) + (body.length > 100 ? '...' : ''),
        });
      } catch (error) {
        console.error(`[${TOOL_CREATE_ISSUE_COMMENT}] ERROR: ${getErrorMessage(error)}`);
        return createErrorResponse(error);
      }
    }
  );
}
