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
  GET_ADD_TO_PROJECT_PREVIEW_QUERY,
  GET_PROJECT_ITEM_PREVIEW_QUERY,
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
    'Add a GitHub issue to a project. This is required before you can update project fields on the issue. The preview resolves the project and issue names from the ids.',
    {
      project_id: projectIdSchema,
      issue_node_id: issueNodeIdSchema,
      ...confirmationParams,
    },
    async ({ project_id, issue_node_id, _executeFromButton }) => {
      // SECURITY: Only execute if called from button handler
      const shouldExecute = _executeFromButton === true;

      if (!shouldExecute) {
        let resolved: AddToProjectPreviewQueryResult;
        try {
          resolved = await octokit.graphql(GET_ADD_TO_PROJECT_PREVIEW_QUERY, {
            projectId: project_id,
            contentId: issue_node_id,
          });
        } catch (error) {
          console.error(`[${TOOL_ADD_ISSUE_TO_PROJECT}] Preview lookup failed:`, error);
          return createErrorResponse(error, {
            project_id,
            issue_node_id,
            hint: 'Could not look up the project and issue for the preview. Check both ids.',
          });
        }

        const project = resolved.project && isProjectV2(resolved.project) ? resolved.project : null;
        const content = resolved.content && isIssueOrPullRequest(resolved.content) ? resolved.content : null;
        if (!project || !content) {
          return createCustomErrorResponse('Could not resolve the project or issue for this preview', {
            project_id,
            issue_node_id,
            problem: !project
              ? 'project_id is not a GitHub Project (v2) you can access'
              : 'issue_node_id is not an issue or pull request you can access',
          });
        }

        // The confirm card renders these labels, so they must come from this lookup, never from the model.
        const display_project_name = project.title;
        const display_issue_title = formatContentLabel(content);
        const display_repository = content.repository.nameWithOwner;

        const previewData: Record<string, string> = {
          'Target Project': `${display_project_name} (${project_id})`,
          Issue: `${display_issue_title} (${issue_node_id})`,
          Repository: display_repository,
          '': '',
          Note: 'This issue will be added to the project board. You can then update its fields (Priority, Status, etc.).',
        };

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
    'Update MULTIPLE fields at once on a GitHub Project item (e.g., Priority + Size + Iteration + Estimate + Start Date + Target Date in one operation). Use this when the user asks to update multiple fields together. The preview resolves field, option and iteration names from the ids.',
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
                'Field value: option ID for single-select, iteration ID for iteration, string for text, number for number, ISO date for date'
              ),
          })
        )
        .describe('Array of field updates to apply'),
      ...confirmationParams,
    },
    async ({ project_id, item_id, updates, _executeFromButton }) => {
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
            invalid_update: { field_id: update.field_id, value: update.value },
            expected_field_id_format: 'PVTSSF_lADO... or PVTF_lADO... or PVTIF_lADO...',
          });
        }
      }

      // SECURITY: Only execute if called from button handler
      const shouldExecute = _executeFromButton === true;

      if (!shouldExecute) {
        let itemResult: ProjectItemPreviewQueryResult;
        let fieldsResult: ProjectFieldsPreviewResult;
        try {
          [itemResult, fieldsResult] = await Promise.all([
            octokit.graphql<ProjectItemPreviewQueryResult>(GET_PROJECT_ITEM_PREVIEW_QUERY, { itemId: item_id }),
            octokit.graphql<ProjectFieldsPreviewResult>(LIST_PROJECT_FIELDS_QUERY, {
              projectId: project_id,
              first: PROJECT_FIELDS_PAGE_SIZE,
            }),
          ]);
        } catch (error) {
          console.error(`[${TOOL_UPDATE_PROJECT_ITEM_FIELDS}] Preview lookup failed:`, error);
          return createErrorResponse(error, {
            project_id,
            item_id,
            hint: 'Could not look up the project item and fields for the preview. Check the ids.',
          });
        }

        const item = itemResult.node && isProjectV2Item(itemResult.node) ? itemResult.node : null;
        const itemProject = item?.project;
        const itemContent = item?.content && isProjectItemContent(item.content) ? item.content : null;
        if (!itemProject || itemProject.id !== project_id || !itemContent) {
          return createCustomErrorResponse('Could not resolve the project item for this preview', {
            project_id,
            item_id,
            problem: !itemProject
              ? 'item_id is not a project item you can access'
              : itemProject.id !== project_id
                ? 'item_id does not belong to project_id'
                : 'The item has no issue, pull request or draft issue you can access',
          });
        }

        const fields = fieldsResult.node?.fields?.nodes ?? [];
        const resolvedUpdates: ResolvedFieldUpdate[] = [];
        for (const update of updates) {
          const resolution = resolveFieldUpdate(update, fields);
          if (!resolution.ok) {
            return createCustomErrorResponse(resolution.error, {
              project_id,
              item_id,
              invalid_update: { field_id: update.field_id, value: update.value },
              hint: 'Call list_project_fields(project_id) and use a field id, option id or iteration id from it.',
            });
          }
          resolvedUpdates.push(resolution.update);
        }

        // The confirm card renders these labels, so they must come from these lookups, never from the model.
        const display_project_name = itemProject.title;
        const display_issue_title = formatContentLabel(itemContent);
        const display_repository =
          itemContent.__typename === 'DraftIssue' ? undefined : itemContent.repository.nameWithOwner;

        const previewData: Record<string, string> = {
          Target: `${display_project_name} - ${display_issue_title}`,
          Project: project_id,
          Item: item_id,
          ...(display_repository ? { Repository: display_repository } : {}),
          '': '',
          Updates: `${resolvedUpdates.length} field${resolvedUpdates.length === 1 ? '' : 's'} will be updated:`,
          ' ': '',
        };
        for (const update of resolvedUpdates) {
          previewData[`  ${update.display_field_name} (${update.field_id})`] = update.display_value;
        }

        return createPreviewResponse('📋 Preview: Update Multiple Project Fields', previewData, 'update', {
          tool: TOOL_UPDATE_PROJECT_ITEM_FIELDS,
          params: {
            project_id,
            item_id,
            updates: resolvedUpdates,
            display_project_name,
            display_issue_title,
            display_repository,
          },
        });
      }

      // CONFIRMED: Actually update all fields
      try {
        console.error(`[${TOOL_UPDATE_PROJECT_ITEM_FIELDS}] Updating ${updates.length} fields on item ${item_id}`);

        const results: Array<{ field_id: string; success: boolean; error?: string }> = [];

        // Update each field sequentially
        for (const update of updates) {
          try {
            console.error(`[${TOOL_UPDATE_PROJECT_ITEM_FIELDS}] Updating field ${update.field_id}`);

            const kind = classifyFieldUpdate(update);
            const value = kind === 'date' ? toDateOnly(String(update.value)) : update.value;
            const variables = { projectId: project_id, itemId: item_id, fieldId: update.field_id, value };

            await octokit.graphql(FIELD_UPDATE_MUTATIONS[kind], variables);

            console.error(`[${TOOL_UPDATE_PROJECT_ITEM_FIELDS}] SUCCESS: Updated ${update.field_id}`);
            results.push({ field_id: update.field_id, success: true });
          } catch (fieldError) {
            const errorMsg = getErrorMessage(fieldError);
            console.error(`[${TOOL_UPDATE_PROJECT_ITEM_FIELDS}] ERROR updating ${update.field_id}:`, errorMsg);
            results.push({ field_id: update.field_id, success: false, error: errorMsg });
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

// Projects allow at most 50 custom fields plus the built-ins, so one page of 100 covers them all.
const PROJECT_FIELDS_PAGE_SIZE = 100;

type ProjectFieldNode = {
  id?: string;
  name?: string;
  dataType?: string;
  options?: Array<{ id: string; name: string }>;
  configuration?: { iterations: Array<{ id: string; title: string }> };
};

type ProjectFieldsPreviewResult = {
  node: { fields?: { nodes: ProjectFieldNode[] } } | null;
};

type RepositoryRef = { nameWithOwner: string };

type IssueOrPullRequest = {
  __typename: 'Issue' | 'PullRequest';
  number: number;
  title: string;
  repository: RepositoryRef;
};

type DraftIssue = { __typename: 'DraftIssue'; title: string };

type ProjectItemContent = IssueOrPullRequest | DraftIssue;

type UnresolvedNode = { __typename: string };

type ProjectV2Node = { __typename: 'ProjectV2'; id: string; title: string };

type ProjectV2ItemNode = {
  __typename: 'ProjectV2Item';
  project: { id: string; title: string } | null;
  content: (ProjectItemContent | UnresolvedNode) | null;
};

type AddToProjectPreviewQueryResult = {
  project: (ProjectV2Node | UnresolvedNode) | null;
  content: (IssueOrPullRequest | UnresolvedNode) | null;
};

type ProjectItemPreviewQueryResult = {
  node: (ProjectV2ItemNode | UnresolvedNode) | null;
};

function isProjectV2(node: ProjectV2Node | UnresolvedNode): node is ProjectV2Node {
  return node.__typename === 'ProjectV2';
}

function isProjectV2Item(node: ProjectV2ItemNode | UnresolvedNode): node is ProjectV2ItemNode {
  return node.__typename === 'ProjectV2Item';
}

function isIssueOrPullRequest(node: IssueOrPullRequest | UnresolvedNode): node is IssueOrPullRequest {
  return node.__typename === 'Issue' || node.__typename === 'PullRequest';
}

function isProjectItemContent(node: ProjectItemContent | UnresolvedNode): node is ProjectItemContent {
  return node.__typename === 'Issue' || node.__typename === 'PullRequest' || node.__typename === 'DraftIssue';
}

function formatContentLabel(content: ProjectItemContent): string {
  if (content.__typename === 'DraftIssue') {
    return `Draft: ${content.title}`;
  }
  return `#${content.number} - ${content.title}`;
}

type FieldUpdateKind = 'number' | 'date' | 'iteration' | 'text' | 'single_select';

const FIELD_UPDATE_MUTATIONS: Record<FieldUpdateKind, string> = {
  number: UPDATE_NUMBER_FIELD_MUTATION,
  date: UPDATE_DATE_FIELD_MUTATION,
  iteration: UPDATE_ITERATION_FIELD_MUTATION,
  text: UPDATE_TEXT_FIELD_MUTATION,
  single_select: UPDATE_SINGLE_SELECT_FIELD_MUTATION,
};

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}(T[\d:]+Z?)?$/;

/**
 * Picks the mutation an update runs. The preview and the execute branch both dispatch through this,
 * so the preview's label always describes the mutation that will actually run.
 */
function classifyFieldUpdate(update: { field_id: string; value: string | number }): FieldUpdateKind {
  if (typeof update.value === 'number') return 'number';
  if (ISO_DATE_PATTERN.test(update.value)) return 'date';
  if (update.field_id.startsWith('PVTIF_')) return 'iteration';
  if (update.field_id.startsWith('PVTF_')) return 'text';
  return 'single_select';
}

function toDateOnly(value: string): string {
  const dateOnly = value.match(/^(\d{4}-\d{2}-\d{2})/)?.[1];
  if (!dateOnly) {
    throw new Error(`Invalid date format: ${value}`);
  }
  return dateOnly;
}

type ResolvedFieldUpdate = {
  field_id: string;
  value: string | number;
  display_field_name: string;
  display_value: string;
};

type FieldUpdateResolution = { ok: true; update: ResolvedFieldUpdate } | { ok: false; error: string };

/**
 * Resolves the labels a preview shows for one update from the project's own field definitions.
 * Refuses an update whose field, option or iteration id is not part of this project.
 */
function resolveFieldUpdate(
  update: { field_id: string; value: string | number },
  fields: ProjectFieldNode[]
): FieldUpdateResolution {
  const field = fields.find(candidate => candidate.id === update.field_id);
  const fieldName = field?.name;
  if (!field || !fieldName) {
    return { ok: false, error: `Field "${update.field_id}" is not a field of this project` };
  }

  const resolved = (display_value: string): FieldUpdateResolution => ({
    ok: true,
    update: { field_id: update.field_id, value: update.value, display_field_name: fieldName, display_value },
  });

  const kind = classifyFieldUpdate(update);
  switch (kind) {
    case 'single_select': {
      const option = field.options?.find(candidate => candidate.id === update.value);
      if (!option) {
        return { ok: false, error: `"${update.value}" is not an option of the "${fieldName}" field` };
      }
      return resolved(option.name);
    }
    case 'iteration': {
      const iteration = field.configuration?.iterations.find(candidate => candidate.id === update.value);
      if (!iteration) {
        return { ok: false, error: `"${update.value}" is not an iteration of the "${fieldName}" field` };
      }
      return resolved(iteration.title);
    }
    case 'date':
      return resolved(toDateOnly(String(update.value)));
    case 'number':
    case 'text':
      return resolved(String(update.value));
  }
}
