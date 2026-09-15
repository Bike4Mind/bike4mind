/**
 * GitHub MCP Server - Milestone Tools
 *
 * Tools for milestone creation, updates, listing, and closing.
 */

import { z } from 'zod';
import type { McpServer } from '../types.js';
import { octokit } from '../client.js';
import { createSuccessResponse, createErrorResponse } from '../helpers/responses.js';
import {
  ownerSchema,
  repoSchema,
  milestoneNumberSchema,
  confirmationParams,
  paginationParams,
} from '../helpers/schemas.js';
import { getErrorMessage } from '../helpers/errors.js';
import { createPreviewResponse } from '../../shared/confirmation-helpers.js';
import {
  TOOL_CREATE_MILESTONE,
  TOOL_UPDATE_MILESTONE,
  TOOL_LIST_MILESTONES,
  TOOL_CLOSE_MILESTONE,
} from '../constants.js';

/**
 * Calculate progress percentage for a milestone
 */
function calculateProgressPercent(openIssues: number, closedIssues: number): number {
  const total = openIssues + closedIssues;
  if (total === 0) return 0;
  return Math.round((closedIssues / total) * 1000) / 10; // Round to 1 decimal
}

/**
 * Normalize a date string to end-of-day UTC to avoid timezone issues.
 * When a user says "due on June 1st", they mean the full day of June 1st,
 * not midnight UTC which displays as May 31st in western timezones.
 *
 * @param dateString - ISO 8601 date string or date-only string
 * @returns ISO 8601 string with time set to noon UTC
 */
function normalizeDueDate(dateString: string | undefined): string | undefined {
  if (!dateString) return undefined;

  try {
    const date = new Date(dateString);
    if (isNaN(date.getTime())) return dateString; // Invalid date, return as-is

    // If the input looks like a date-only string (no time component or midnight UTC),
    // set it to noon UTC to avoid timezone display issues
    if (
      dateString.match(/^\d{4}-\d{2}-\d{2}$/) || // YYYY-MM-DD
      dateString.match(/T00:00:00/) // Midnight UTC
    ) {
      const year = date.getUTCFullYear();
      const month = String(date.getUTCMonth() + 1).padStart(2, '0');
      const day = String(date.getUTCDate()).padStart(2, '0');
      return `${year}-${month}-${day}T12:00:00Z`;
    }

    return dateString;
  } catch {
    return dateString; // On any error, return original
  }
}

export function registerMilestoneTools(server: McpServer) {
  // CREATE MILESTONE
  server.tool(
    TOOL_CREATE_MILESTONE,
    'Create a GitHub milestone in a repository. Use this when asked to create, add, or set up a new milestone for tracking releases, sprints, or project phases. Supports title, description, due date, and state.',
    {
      owner: ownerSchema,
      repo: repoSchema,
      title: z
        .string()
        .min(1, 'Title is required')
        .max(255, 'Title must be 255 characters or less')
        .transform(val => val.trim())
        .refine(val => val.length > 0, 'Title cannot be only whitespace')
        .describe('Milestone title'),
      description: z.string().optional().describe('Milestone description'),
      due_on: z.string().optional().describe('Due date in ISO 8601 format (e.g., 2024-03-01T00:00:00Z)'),
      state: z.enum(['open', 'closed']).optional().prefault('open').describe('Milestone state (default: open)'),
      ...confirmationParams,
    },
    async ({ owner, repo, title, description, due_on, state, confirmed, _executeFromButton }) => {
      const fullRepoName = `${owner}/${repo}`;

      // SECURITY: Only execute if called from button handler
      const shouldExecute = _executeFromButton === true;

      if (!shouldExecute) {
        return createPreviewResponse(
          '🎯 Preview: GitHub Milestone to be Created',
          {
            repository: fullRepoName,
            title,
            description: description || '[No description]',
            due_on: due_on || '[No due date]',
            state: state || 'open',
          },
          'milestone',
          {
            tool: TOOL_CREATE_MILESTONE,
            params: { owner, repo, title, description, due_on, state },
          }
        );
      }

      // CONFIRMED: Actually create the milestone
      console.error(`[${TOOL_CREATE_MILESTONE}] Attempting to create milestone: ${fullRepoName} - "${title}"`);

      try {
        const result = await octokit.issues.createMilestone({
          owner,
          repo,
          title,
          description,
          due_on: normalizeDueDate(due_on),
          state,
        });

        console.error(`[${TOOL_CREATE_MILESTONE}] SUCCESS: Created milestone #${result.data.number}`);
        console.error(`[${TOOL_CREATE_MILESTONE}] URL: ${result.data.html_url}`);

        return createSuccessResponse({
          number: result.data.number,
          url: result.data.html_url,
          title: result.data.title,
          description: result.data.description,
          state: result.data.state,
          due_on: result.data.due_on,
          open_issues: result.data.open_issues,
          closed_issues: result.data.closed_issues,
          progress_percent: calculateProgressPercent(result.data.open_issues, result.data.closed_issues),
        });
      } catch (error) {
        console.error(`[${TOOL_CREATE_MILESTONE}] ERROR: ${getErrorMessage(error)}`);
        return createErrorResponse(error);
      }
    }
  );

  // UPDATE MILESTONE
  server.tool(
    TOOL_UPDATE_MILESTONE,
    'Update an existing GitHub milestone. Use this to modify title, description, due date, or state. Can also REOPEN a closed milestone by setting state to "open". Requires milestone_number - use list_milestones first if you only have the title.',
    {
      owner: ownerSchema,
      repo: repoSchema,
      milestone_number: milestoneNumberSchema,
      title: z.string().max(255, 'Title must be 255 characters or less').optional().describe('New milestone title'),
      description: z.string().optional().describe('New milestone description'),
      due_on: z.string().optional().describe('New due date in ISO 8601 format (e.g., 2024-03-01T00:00:00Z)'),
      state: z.enum(['open', 'closed']).optional().describe('Milestone state'),
      ...confirmationParams,
    },
    async ({ owner, repo, milestone_number, title, description, due_on, state, confirmed, _executeFromButton }) => {
      const fullRepoName = `${owner}/${repo}`;

      // SECURITY: Only execute if called from button handler
      const shouldExecute = _executeFromButton === true;

      if (!shouldExecute) {
        // Build changes object with only fields that are being updated
        const changes: Record<string, string | undefined> = {};
        if (title !== undefined) changes.title = title;
        if (description !== undefined)
          changes.description = description.length > 200 ? description.substring(0, 200) + '...' : description;
        if (due_on !== undefined) changes.due_on = due_on;
        if (state !== undefined) changes.state = state;

        return createPreviewResponse(
          '🎯 Preview: GitHub Milestone Update',
          {
            repository: fullRepoName,
            milestone_number,
            changes: Object.keys(changes).length > 0 ? changes : { note: 'No changes specified' },
          },
          'update',
          {
            tool: TOOL_UPDATE_MILESTONE,
            params: { owner, repo, milestone_number, title, description, due_on, state },
          }
        );
      }

      // CONFIRMED: Actually update the milestone
      console.error(`[${TOOL_UPDATE_MILESTONE}] Attempting to update milestone #${milestone_number}: ${fullRepoName}`);

      try {
        // Build update payload with only provided fields
        const updateData: {
          title?: string;
          description?: string;
          due_on?: string;
          state?: 'open' | 'closed';
        } = {};
        if (title !== undefined) updateData.title = title;
        if (description !== undefined) updateData.description = description;
        if (due_on !== undefined) updateData.due_on = normalizeDueDate(due_on);
        if (state !== undefined) updateData.state = state;

        const result = await octokit.issues.updateMilestone({
          owner,
          repo,
          milestone_number,
          ...updateData,
        });

        console.error(`[${TOOL_UPDATE_MILESTONE}] SUCCESS: Updated milestone #${result.data.number}`);
        console.error(`[${TOOL_UPDATE_MILESTONE}] URL: ${result.data.html_url}`);

        return createSuccessResponse({
          number: result.data.number,
          url: result.data.html_url,
          title: result.data.title,
          description: result.data.description,
          state: result.data.state,
          due_on: result.data.due_on,
          open_issues: result.data.open_issues,
          closed_issues: result.data.closed_issues,
          progress_percent: calculateProgressPercent(result.data.open_issues, result.data.closed_issues),
          updated_at: result.data.updated_at,
        });
      } catch (error) {
        console.error(`[${TOOL_UPDATE_MILESTONE}] ERROR: ${getErrorMessage(error)}`);
        return createErrorResponse(error);
      }
    }
  );

  // LIST MILESTONES
  server.tool(
    TOOL_LIST_MILESTONES,
    'List milestones for a repository. IMPORTANT: Use this FIRST when the user refers to a milestone by name (e.g., "Next Release") - you need the milestone_number to close, update, or reopen it. Returns milestone number, title, state, progress, and due date. Filter by state: open, closed, or all.',
    {
      owner: ownerSchema,
      repo: repoSchema,
      state: z.enum(['open', 'closed', 'all']).optional().describe('Milestone state filter (default: open)'),
      sort: z.enum(['due_on', 'completeness']).optional().describe('Sort by (default: due_on)'),
      direction: z.enum(['asc', 'desc']).optional().describe('Sort direction (default: asc)'),
      ...paginationParams,
    },
    async ({ owner, repo, state, sort, direction, per_page, page }) => {
      const effectiveState = state || 'open';

      try {
        const result = await octokit.issues.listMilestones({
          owner,
          repo,
          state: effectiveState,
          sort: sort || 'due_on',
          direction: direction || 'asc',
          per_page: per_page || 30,
          page: page || 1,
        });

        console.error(`[${TOOL_LIST_MILESTONES}] SUCCESS: Found ${result.data.length} milestones`);

        return createSuccessResponse({
          total_count: result.data.length,
          milestones: result.data.map(milestone => ({
            number: milestone.number,
            title: milestone.title,
            description: milestone.description,
            state: milestone.state,
            url: milestone.html_url,
            due_on: milestone.due_on,
            open_issues: milestone.open_issues,
            closed_issues: milestone.closed_issues,
            progress_percent: calculateProgressPercent(milestone.open_issues, milestone.closed_issues),
            created_at: milestone.created_at,
            updated_at: milestone.updated_at,
            closed_at: milestone.closed_at,
          })),
        });
      } catch (error) {
        console.error(`[${TOOL_LIST_MILESTONES}] ERROR: ${getErrorMessage(error)}`);
        return createErrorResponse(error);
      }
    }
  );

  // CLOSE MILESTONE
  server.tool(
    TOOL_CLOSE_MILESTONE,
    'Close a GitHub milestone. Use this when asked to close, complete, finish, or mark a milestone as done. Requires milestone_number - if user provides a milestone name (e.g., "Next Release"), first call list_milestones to find the number, then use this tool. To REOPEN a closed milestone, use update_milestone with state="open" instead.',
    {
      owner: ownerSchema,
      repo: repoSchema,
      milestone_number: milestoneNumberSchema,
      ...confirmationParams,
    },
    async ({ owner, repo, milestone_number, confirmed, _executeFromButton }) => {
      const fullRepoName = `${owner}/${repo}`;

      // SECURITY: Only execute if called from button handler
      const shouldExecute = _executeFromButton === true;

      if (!shouldExecute) {
        // Fetch current milestone info for preview
        let milestoneTitle = `Milestone #${milestone_number}`;
        try {
          const currentMilestone = await octokit.issues.getMilestone({
            owner,
            repo,
            milestone_number,
          });
          milestoneTitle = currentMilestone.data.title;
        } catch {
          // If we can't fetch, just use the number
        }

        return createPreviewResponse(
          '🎯 Preview: Close GitHub Milestone',
          {
            repository: fullRepoName,
            milestone_number,
            title: milestoneTitle,
            action: 'close',
          },
          'milestone',
          {
            tool: TOOL_CLOSE_MILESTONE,
            params: { owner, repo, milestone_number },
          }
        );
      }

      // CONFIRMED: Actually close the milestone
      console.error(`[${TOOL_CLOSE_MILESTONE}] Attempting to close milestone #${milestone_number}: ${fullRepoName}`);

      try {
        const result = await octokit.issues.updateMilestone({
          owner,
          repo,
          milestone_number,
          state: 'closed',
        });

        console.error(`[${TOOL_CLOSE_MILESTONE}] SUCCESS: Closed milestone #${result.data.number}`);
        console.error(`[${TOOL_CLOSE_MILESTONE}] URL: ${result.data.html_url}`);

        return createSuccessResponse({
          number: result.data.number,
          url: result.data.html_url,
          title: result.data.title,
          state: result.data.state,
          open_issues: result.data.open_issues,
          closed_issues: result.data.closed_issues,
          progress_percent: calculateProgressPercent(result.data.open_issues, result.data.closed_issues),
          closed_at: result.data.closed_at,
        });
      } catch (error) {
        console.error(`[${TOOL_CLOSE_MILESTONE}] ERROR: ${getErrorMessage(error)}`);
        return createErrorResponse(error);
      }
    }
  );
}
