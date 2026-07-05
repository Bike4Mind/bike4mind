/**
 * GitHub MCP Server - Projects v2 Tools
 *
 * Tools for GitHub Projects v2 operations using GraphQL.
 */

import { z } from 'zod';
import type { McpServer } from '../types.js';
import { octokit } from '../client.js';
import { createSuccessResponse, createErrorResponse, createCustomErrorResponse } from '../helpers/responses.js';
import { orgSchema, projectIdSchema, issueNodeIdSchema, confirmationParams } from '../helpers/schemas.js';
import { getErrorMessage } from '../helpers/errors.js';
import { createPreviewResponse } from '../../shared/confirmation-helpers.js';
import {
  LIST_ORG_PROJECTS_QUERY,
  LIST_PROJECT_FIELDS_QUERY,
  GET_PROJECT_ITEM_QUERY,
  ADD_PROJECT_ITEM_MUTATION,
  UPDATE_NUMBER_FIELD_MUTATION,
  UPDATE_DATE_FIELD_MUTATION,
  UPDATE_ITERATION_FIELD_MUTATION,
  UPDATE_TEXT_FIELD_MUTATION,
  UPDATE_SINGLE_SELECT_FIELD_MUTATION,
} from '../helpers/queries.js';
import {
  TOOL_LIST_ORG_PROJECTS,
  TOOL_LIST_PROJECT_FIELDS,
  TOOL_GET_PROJECT_ITEM,
  TOOL_ADD_ISSUE_TO_PROJECT,
  TOOL_UPDATE_PROJECT_ITEM_FIELDS,
} from '../constants.js';

export function registerProjectTools(server: McpServer) {
  // LIST ORGANIZATION PROJECTS - List all projects for an organization
  server.tool(
    TOOL_LIST_ORG_PROJECTS,
    'List all GitHub Projects (v2) for an organization. Returns project IDs (starting with "PVT_"), titles, and metadata. IMPORTANT: Call this first to get the project ID when the user refers to a project by name (e.g., "Project 1") - you need the "id" field from the response for other project tools.',
    {
      org: orgSchema,
      first: z.number().optional().describe('Number of projects to fetch (default: 20, max: 100)').prefault(20),
      after: z.string().optional().describe('Cursor for pagination (endCursor from previous response pageInfo)'),
    },
    async ({ org, first, after }) => {
      try {
        console.error(`[${TOOL_LIST_ORG_PROJECTS}] Fetching projects for org: ${org}`);

        interface OrgProjectsQueryResult {
          organization: {
            projectsV2: {
              nodes: Array<{
                id: string;
                title: string;
                shortDescription: string | null;
                public: boolean;
                closed: boolean;
                url: string;
                number: number;
                createdAt: string;
                updatedAt: string;
              }>;
              pageInfo: {
                hasNextPage: boolean;
                endCursor: string | null;
              };
            };
          };
        }

        const result: OrgProjectsQueryResult = await octokit.graphql(LIST_ORG_PROJECTS_QUERY, { org, first, after });

        return createSuccessResponse({
          projects: result.organization.projectsV2.nodes,
          pageInfo: result.organization.projectsV2.pageInfo,
        });
      } catch (error) {
        console.error(`[${TOOL_LIST_ORG_PROJECTS}] Error:`, error);
        return createErrorResponse(error, {
          organization: org,
          hint: 'Ensure you have the "project" OAuth scope enabled and the organization exists.',
        });
      }
    }
  );

  // LIST PROJECT FIELDS - Get all fields for a specific project
  server.tool(
    TOOL_LIST_PROJECT_FIELDS,
    'List all fields (Status, Priority, Size, etc.) for a GitHub Project. Returns field IDs and available options needed for updating project item fields. IMPORTANT: If user refers to a project by name (e.g., "Project 1"), first call list_org_projects to find the project and get its ID.',
    {
      project_id: projectIdSchema,
      first: z.number().optional().describe('Number of fields to fetch (default: 20)').prefault(20),
    },
    async ({ project_id, first }) => {
      try {
        console.error(`[${TOOL_LIST_PROJECT_FIELDS}] Fetching fields for project: ${project_id}`);

        interface ProjectFieldsQueryResult {
          node: {
            fields: {
              nodes: Array<{
                id: string;
                name: string;
                dataType: string;
                options?: Array<{ id: string; name: string; color: string }>;
                configuration?: {
                  iterations: Array<{
                    id: string;
                    title: string;
                    startDate: string;
                    duration: number;
                  }>;
                };
              }>;
            };
          };
        }

        const result: ProjectFieldsQueryResult = await octokit.graphql(LIST_PROJECT_FIELDS_QUERY, {
          projectId: project_id,
          first,
        });

        return createSuccessResponse({
          fields: result.node.fields.nodes,
        });
      } catch (error) {
        console.error(`[${TOOL_LIST_PROJECT_FIELDS}] Error:`, error);
        return createErrorResponse(error, { project_id });
      }
    }
  );

  // GET PROJECT ITEM - Get an issue's project item with all field values
  server.tool(
    TOOL_GET_PROJECT_ITEM,
    'Get a GitHub issue as a project item with all its field values (Status, Priority, etc.). Use this to see current field values before updating. IMPORTANT: If user refers to a project by name, first call list_org_projects to get the project ID. If user refers to an issue by number, first call get_issue to get the node_id. NOTE: Pagination is limited to 1000 items (10 pages x 100 items) for safety.',
    {
      project_id: projectIdSchema,
      issue_node_id: issueNodeIdSchema,
    },
    async ({ project_id, issue_node_id }) => {
      try {
        console.error(`[${TOOL_GET_PROJECT_ITEM}] Fetching project item for issue: ${issue_node_id}`);

        interface ProjectItemQueryResult {
          node: {
            items: {
              pageInfo: {
                hasNextPage: boolean;
                endCursor: string | null;
              };
              nodes: Array<{
                id: string;
                content?: { id: string; number: number; title: string };
                fieldValues: { nodes: unknown[] };
              }>;
            };
          };
        }

        // Paginate through all project items to find the matching issue
        let cursor: string | null = null;
        let totalItemsSearched = 0;
        const maxPages = 10; // Safety limit: 10 pages x 100 items = 1000 items max
        let pagesSearched = 0;

        while (pagesSearched < maxPages) {
          pagesSearched++;
          const result: ProjectItemQueryResult = await octokit.graphql(GET_PROJECT_ITEM_QUERY, {
            projectId: project_id,
            cursor,
          });

          const items = result.node.items.nodes;
          totalItemsSearched += items.length;

          const projectItem = items.find(item => item.content?.id === issue_node_id);

          if (projectItem) {
            console.error(
              `[${TOOL_GET_PROJECT_ITEM}] Found issue after searching ${totalItemsSearched} items (${pagesSearched} pages)`
            );
            return createSuccessResponse({ project_item: projectItem });
          }

          if (!result.node.items.pageInfo.hasNextPage) {
            break;
          }

          cursor = result.node.items.pageInfo.endCursor;
          console.error(
            `[${TOOL_GET_PROJECT_ITEM}] Issue not found in page ${pagesSearched}, searching next page (${totalItemsSearched} items searched so far)`
          );
        }

        // Issue not found after searching all pages
        const limitReached = pagesSearched >= maxPages;
        return createCustomErrorResponse('Issue not found in project', {
          project_id,
          issue_node_id,
          items_searched: totalItemsSearched,
          pages_searched: pagesSearched,
          hint: limitReached
            ? `Searched ${totalItemsSearched} items (${maxPages} page limit). The issue may not be added to this project, or the project has more than ${maxPages * 100} items.`
            : 'The issue may not be added to this project yet. Use add_issue_to_project to add it.',
        });
      } catch (error) {
        console.error(`[${TOOL_GET_PROJECT_ITEM}] Error:`, error);
        return createErrorResponse(error, { project_id, issue_node_id });
      }
    }
  );

  // ADD ISSUE TO PROJECT - Add an issue to a GitHub Project
  server.tool(
    TOOL_ADD_ISSUE_TO_PROJECT,
    'Add a GitHub issue to a project. This is required before you can update project fields on the issue. IMPORTANT: Include display parameters for human-readable preview.',
    {
      project_id: projectIdSchema,
      issue_node_id: issueNodeIdSchema,
      // Display parameters for human-readable preview
      display_project_name: z
        .string()
        .optional()
        .describe('Human-readable project name for preview (e.g., "Project 1"). Get from list_org_projects.'),
      display_issue_title: z
        .string()
        .optional()
        .describe('Human-readable issue title for preview (e.g., "#2 - Login issue"). Get from get_issue.'),
      display_repository: z
        .string()
        .optional()
        .describe('Repository name for preview (e.g., "owner/repo"). Get from get_issue.'),
      ...confirmationParams,
    },
    async ({
      project_id,
      issue_node_id,
      display_project_name,
      display_issue_title,
      display_repository,
      _executeFromButton,
    }) => {
      // SECURITY: Only execute if called from button handler
      const shouldExecute = _executeFromButton === true;

      if (!shouldExecute) {
        // Build human-readable preview
        const previewData: Record<string, string> = {
          '🎯 Target Project': display_project_name || 'GitHub Project',
          '📝 Issue': display_issue_title || 'Issue',
        };

        if (display_repository) {
          previewData['📦 Repository'] = display_repository;
        }

        previewData[''] = ''; // Spacing
        previewData['ℹ️ Note'] =
          'This issue will be added to the project board. You can then update its fields (Priority, Status, etc.).';

        return createPreviewResponse('📋 Preview: Add Issue to GitHub Project', previewData, 'update', {
          tool: TOOL_ADD_ISSUE_TO_PROJECT,
          params: { project_id, issue_node_id, display_project_name, display_issue_title, display_repository },
        });
      }

      // CONFIRMED: Actually add the issue to the project
      try {
        console.error(`[${TOOL_ADD_ISSUE_TO_PROJECT}] Adding issue ${issue_node_id} to project ${project_id}`);

        interface AddProjectItemResult {
          addProjectV2ItemById: {
            item: {
              id: string;
            };
          };
        }

        const result: AddProjectItemResult = await octokit.graphql(ADD_PROJECT_ITEM_MUTATION, {
          projectId: project_id,
          contentId: issue_node_id,
        });

        console.error(`[${TOOL_ADD_ISSUE_TO_PROJECT}] SUCCESS: Added issue to project`);

        return createSuccessResponse({
          project_id,
          issue_node_id,
          item_id: result.addProjectV2ItemById.item.id,
        });
      } catch (error) {
        console.error(`[${TOOL_ADD_ISSUE_TO_PROJECT}] Error:`, error);
        return createErrorResponse(error, { project_id, issue_node_id });
      }
    }
  );

  // UPDATE PROJECT ITEM FIELDS - Update one or more fields on a project item
  server.tool(
    TOOL_UPDATE_PROJECT_ITEM_FIELDS,
    'Update MULTIPLE fields at once on a GitHub Project item (e.g., Priority + Size + Iteration + Estimate + Start Date + Target Date in one operation). Use this when the user asks to update multiple fields together. REQUIRED: You MUST provide display_* parameters for ALL fields being updated.',
    {
      project_id: z.string().describe('Project ID'),
      item_id: z.string().describe('Project item ID (from get_project_item)'),
      updates: z
        .array(
          z.object({
            field_id: z.string().describe('Field ID (from list_project_fields)'),
            value: z
              .union([z.string(), z.number()])
              .describe(
                'Field value: option ID for single-select, string for text, number for number, ISO date for date'
              ),
            field_name: z.string().describe('Human-readable field name (e.g., "Priority", "Size", "Status")'),
            current_value: z.string().optional().describe('Current field value for preview (e.g., "P1", "M", "Todo")'),
            new_value: z.string().describe('New field value for preview (e.g., "P2", "L", "In Progress")'),
          })
        )
        .describe('Array of field updates to apply'),
      // Display parameters for human-readable preview
      display_project_name: z
        .string()
        .optional()
        .describe(
          'Human-readable project name for preview (e.g., "Project A"). If omitted, will extract from updates.'
        ),
      display_issue_title: z
        .string()
        .optional()
        .describe(
          'Human-readable issue title for preview (e.g., "#1 - Change button color"). If omitted, will use generic label.'
        ),
      ...confirmationParams,
    },
    async ({ project_id, item_id, updates, display_project_name, display_issue_title, _executeFromButton }) => {
      // VALIDATE INPUTS - Common AI mistakes
      // Mistake #1: Passing issue node_id (I_...) instead of project item ID (PVTI_...)
      if (!item_id.startsWith('PVTI_')) {
        return createCustomErrorResponse(`Invalid item_id format. You provided: "${item_id}"`, {
          problem: item_id.startsWith('I_')
            ? 'You passed an issue node_id (starts with I_) instead of a project item ID (starts with PVTI_)'
            : 'The item_id must start with "PVTI_" (ProjectV2Item ID)',
          required_workflow: [
            '1. Call get_project_item(project_id, issue_node_id) to get the item_id',
            '2. If get_project_item fails (issue not in project), call add_issue_to_project first',
            '3. Then call update_project_item_fields with the PVTI_ item_id from step 1',
          ],
          provided: item_id,
          expected_format: 'PVTI_lADO...',
        });
      }

      // Mistake #2: Passing human-readable field names instead of field IDs from list_project_fields
      for (const update of updates) {
        if (!update.field_id.startsWith('PVT')) {
          return createCustomErrorResponse(`Invalid field_id in updates array. You provided: "${update.field_id}"`, {
            problem:
              'You passed a human-readable field name (e.g., "Priority") instead of the technical field ID from list_project_fields',
            required_workflow: [
              '1. Call list_project_fields(project_id) to get all field definitions',
              '2. Find the field you want to update in the response',
              '3. Use the field.id value (format: PVTSSF_... for single-select, PVTF_... for dates/numbers, PVTIF_... for iterations)',
              '4. For single-select fields, also get the option ID from field.options array',
              '5. Use these IDs in the updates array, NOT the human-readable names',
            ],
            invalid_update: { field_id: update.field_id, field_name: update.field_name, value: update.value },
            expected_field_id_format: 'PVTSSF_lADO... or PVTF_lADO... or PVTIF_lADO...',
          });
        }
      }

      // SECURITY: Only execute if called from button handler
      const shouldExecute = _executeFromButton === true;

      if (!shouldExecute) {
        // Build human-readable preview showing ALL fields
        const projectLabel = display_project_name || `GitHub Project`;
        const issueLabel = display_issue_title || `Issue`;

        const previewData: Record<string, string> = {
          '🎯 Target': `${projectLabel} - ${issueLabel}`,
          '': '', // Empty line for spacing
          '📝 Updates': `${updates.length} field${updates.length > 1 ? 's' : ''} will be updated:`,
          ' ': '', // Another empty line
        };

        // Add each field update to preview
        updates.forEach(update => {
          const fieldLabel = `  ${update.field_name}`;
          const changeLabel = update.current_value
            ? `${update.current_value} → ${update.new_value}`
            : `→ ${update.new_value}`;
          previewData[fieldLabel] = changeLabel;
        });

        return createPreviewResponse('📋 Preview: Update Multiple Project Fields', previewData, 'update', {
          tool: TOOL_UPDATE_PROJECT_ITEM_FIELDS,
          params: { project_id, item_id, updates },
        });
      }

      // CONFIRMED: Actually update all fields
      try {
        console.error(`[${TOOL_UPDATE_PROJECT_ITEM_FIELDS}] Updating ${updates.length} fields on item ${item_id}`);

        const results: Array<{ field_name: string; success: boolean; error?: string }> = [];

        // Update each field sequentially
        for (const update of updates) {
          try {
            console.error(
              `[${TOOL_UPDATE_PROJECT_ITEM_FIELDS}] Updating field ${update.field_id} (${update.field_name})`
            );

            // Determine field value type and use appropriate mutation
            let mutation: string;
            let variables: Record<string, string | number>;

            if (typeof update.value === 'number') {
              // Number field (e.g., Estimate)
              mutation = UPDATE_NUMBER_FIELD_MUTATION;
              variables = { projectId: project_id, itemId: item_id, fieldId: update.field_id, value: update.value };
            } else if (update.value.match(/^\d{4}-\d{2}-\d{2}(T[\d:]+Z?)?$/)) {
              // Date field (ISO format: YYYY-MM-DD or YYYY-MM-DDTHH:MM:SSZ)
              const dateOnly = update.value.match(/^(\d{4}-\d{2}-\d{2})/)?.[1];
              if (!dateOnly) {
                throw new Error(`Invalid date format: ${update.value}`);
              }
              mutation = UPDATE_DATE_FIELD_MUTATION;
              variables = { projectId: project_id, itemId: item_id, fieldId: update.field_id, value: dateOnly };
            } else if (update.field_id.startsWith('PVTIF_')) {
              // Iteration field
              mutation = UPDATE_ITERATION_FIELD_MUTATION;
              variables = { projectId: project_id, itemId: item_id, fieldId: update.field_id, value: update.value };
            } else if (update.field_id.startsWith('PVTF_')) {
              // Text field
              mutation = UPDATE_TEXT_FIELD_MUTATION;
              variables = { projectId: project_id, itemId: item_id, fieldId: update.field_id, value: update.value };
            } else {
              // Single-select field (Priority, Size, Status, etc.)
              mutation = UPDATE_SINGLE_SELECT_FIELD_MUTATION;
              variables = { projectId: project_id, itemId: item_id, fieldId: update.field_id, value: update.value };
            }

            await octokit.graphql(mutation, variables);

            console.error(`[${TOOL_UPDATE_PROJECT_ITEM_FIELDS}] SUCCESS: Updated ${update.field_name}`);
            results.push({ field_name: update.field_name, success: true });
          } catch (fieldError) {
            const errorMsg = getErrorMessage(fieldError);
            console.error(`[${TOOL_UPDATE_PROJECT_ITEM_FIELDS}] ERROR updating ${update.field_name}:`, errorMsg);
            results.push({ field_name: update.field_name, success: false, error: errorMsg });
          }
        }

        // Check if all updates succeeded
        const allSucceeded = results.every(r => r.success);
        const successCount = results.filter(r => r.success).length;

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  success: allSucceeded,
                  message: allSucceeded
                    ? `Successfully updated all ${updates.length} fields`
                    : `Updated ${successCount} of ${updates.length} fields (${updates.length - successCount} failed)`,
                  results,
                  project_id,
                  item_id,
                },
                null,
                2
              ),
            },
          ],
          isError: !allSucceeded,
        };
      } catch (error) {
        console.error(`[${TOOL_UPDATE_PROJECT_ITEM_FIELDS}] Error:`, error);
        return createErrorResponse(error, { project_id, item_id });
      }
    }
  );
}
