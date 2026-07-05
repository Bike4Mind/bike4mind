import { z } from 'zod';
import type { McpServer } from '../types.js';
import { octokit } from '../client.js';
import { createSuccessResponse, createErrorResponse } from '../helpers/responses.js';
import { ownerSchema, repoSchema, confirmationParams } from '../helpers/schemas.js';
import { getErrorMessage } from '../helpers/errors.js';
import { createPreviewResponse } from '../../shared/confirmation-helpers.js';
import { TOOL_CREATE_LABEL, TOOL_UPDATE_LABEL, TOOL_DELETE_LABEL, TOOL_LIST_LABELS } from '../constants.js';

export function registerLabelTools(server: McpServer) {
  // CREATE LABEL
  server.tool(
    TOOL_CREATE_LABEL,
    'Create a new label in a repository.',
    {
      owner: ownerSchema,
      repo: repoSchema,
      name: z.string().min(1, 'Label name is required').describe('Label name'),
      color: z
        .string()
        .regex(/^[0-9a-fA-F]{6}$/, 'Color must be a 6-character hex code without #')
        .describe('6-char hex color (without #)'),
      description: z
        .string()
        .max(100, 'Description must be 100 chars or less')
        .optional()
        .describe('Label description'),
      ...confirmationParams,
    },
    async ({ owner, repo, name, color, description, _executeFromButton }) => {
      const fullRepoName = `${owner}/${repo}`;

      // SECURITY: Only execute if called from button handler
      const shouldExecute = _executeFromButton === true;

      if (!shouldExecute) {
        return createPreviewResponse(
          '🏷️ Preview: Create GitHub Label',
          {
            repository: fullRepoName,
            name,
            color: `#${color}`,
            description: description || '[No description]',
          },
          'create_label',
          {
            tool: TOOL_CREATE_LABEL,
            params: { owner, repo, name, color, description },
          }
        );
      }

      // CONFIRMED: Actually create the label
      console.error(`[${TOOL_CREATE_LABEL}] Attempting to create label: ${name} in ${fullRepoName}`);

      try {
        const result = await octokit.issues.createLabel({
          owner,
          repo,
          name,
          color,
          description,
        });

        console.error(`[${TOOL_CREATE_LABEL}] SUCCESS: Created label ${result.data.name}`);

        return createSuccessResponse({
          name: result.data.name,
          color: result.data.color,
          description: result.data.description,
          url: result.data.url,
        });
      } catch (error) {
        console.error(`[${TOOL_CREATE_LABEL}] ERROR: ${getErrorMessage(error)}`);
        return createErrorResponse(error);
      }
    }
  );

  // UPDATE LABEL
  server.tool(
    TOOL_UPDATE_LABEL,
    'Update an existing label. Supports renaming, changing color, or description.',
    {
      owner: ownerSchema,
      repo: repoSchema,
      current_name: z.string().min(1, 'Current label name is required').describe('Current label name'),
      new_name: z.string().optional().describe('New label name (optional)'),
      color: z
        .string()
        .regex(/^[0-9a-fA-F]{6}$/, 'Color must be a 6-character hex code without #')
        .optional()
        .describe('New color (optional)'),
      description: z
        .string()
        .max(100, 'Description must be 100 chars or less')
        .optional()
        .describe('New description (optional)'),
      ...confirmationParams,
    },
    async ({ owner, repo, current_name, new_name, color, description, _executeFromButton }) => {
      const fullRepoName = `${owner}/${repo}`;

      // SECURITY: Only execute if called from button handler
      const shouldExecute = _executeFromButton === true;

      if (!shouldExecute) {
        const changes: Record<string, string> = {};
        if (new_name) changes.name = new_name;
        if (color) changes.color = `#${color}`;
        if (description) changes.description = description;

        return createPreviewResponse(
          '🏷️ Preview: Update GitHub Label',
          {
            repository: fullRepoName,
            current_name,
            changes: Object.keys(changes).length > 0 ? changes : { note: 'No changes specified' },
          },
          'update_label',
          {
            tool: TOOL_UPDATE_LABEL,
            params: { owner, repo, current_name, new_name, color, description },
          }
        );
      }

      // CONFIRMED: Actually update the label
      console.error(`[${TOOL_UPDATE_LABEL}] Attempting to update label: ${current_name} in ${fullRepoName}`);

      try {
        // octokit.issues.updateLabel takes the current name as `name` and the rename as `new_name`.
        // https://docs.github.com/en/rest/issues/labels?apiVersion=2022-11-28#update-a-label
        const result = await octokit.issues.updateLabel({
          owner,
          repo,
          name: current_name,
          new_name,
          color,
          description,
        });

        console.error(`[${TOOL_UPDATE_LABEL}] SUCCESS: Updated label ${result.data.name}`);

        return createSuccessResponse({
          old_name: current_name,
          name: result.data.name,
          color: result.data.color,
          description: result.data.description,
          url: result.data.url,
        });
      } catch (error) {
        console.error(`[${TOOL_UPDATE_LABEL}] ERROR: ${getErrorMessage(error)}`);
        return createErrorResponse(error);
      }
    }
  );

  // DELETE LABEL
  server.tool(
    TOOL_DELETE_LABEL,
    'Delete a label from a repository.',
    {
      owner: ownerSchema,
      repo: repoSchema,
      name: z.string().min(1, 'Label name is required').describe('Label name to delete'),
      ...confirmationParams,
    },
    async ({ owner, repo, name, _executeFromButton }) => {
      const fullRepoName = `${owner}/${repo}`;

      // SECURITY: Only execute if called from button handler
      const shouldExecute = _executeFromButton === true;

      if (!shouldExecute) {
        return createPreviewResponse(
          '🗑️ Preview: Delete GitHub Label',
          {
            repository: fullRepoName,
            name,
            warning: 'This action cannot be undone.',
          },
          'delete_label',
          {
            tool: TOOL_DELETE_LABEL,
            params: { owner, repo, name },
          }
        );
      }

      // CONFIRMED: Actually delete the label
      console.error(`[${TOOL_DELETE_LABEL}] Attempting to delete label: ${name} in ${fullRepoName}`);

      try {
        await octokit.issues.deleteLabel({
          owner,
          repo,
          name,
        });

        console.error(`[${TOOL_DELETE_LABEL}] SUCCESS: Deleted label ${name}`);

        return createSuccessResponse({
          deleted: true,
          name,
          repository: fullRepoName,
        });
      } catch (error) {
        console.error(`[${TOOL_DELETE_LABEL}] ERROR: ${getErrorMessage(error)}`);
        return createErrorResponse(error);
      }
    }
  );

  // LIST LABELS
  server.tool(
    TOOL_LIST_LABELS,
    'List labels in a repository.',
    {
      owner: ownerSchema,
      repo: repoSchema,
      per_page: z.number().optional().prefault(100).describe('Results per page (max 100)'),
      page: z.number().optional().prefault(1).describe('Page number'),
    },
    async ({ owner, repo, per_page, page }) => {
      try {
        const result = await octokit.issues.listLabelsForRepo({
          owner,
          repo,
          per_page,
          page,
        });

        return createSuccessResponse({
          total_count: result.data.length,
          labels: result.data.map(label => ({
            id: label.id,
            name: label.name,
            color: label.color,
            description: label.description,
            default: label.default,
          })),
        });
      } catch (error) {
        console.error(`[${TOOL_LIST_LABELS}] ERROR: ${getErrorMessage(error)}`);
        return createErrorResponse(error);
      }
    }
  );
}
