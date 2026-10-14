import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the config module
vi.mock('../../config.js', () => ({
  githubToken: 'mock-token',
}));

// Mock the client module
vi.mock('../../client.js', () => ({
  octokit: {
    graphql: vi.fn(),
  },
}));

import { registerProjectTools } from '../../tools/projects.js';
import { octokit } from '../../client.js';
import {
  TOOL_LIST_ORG_PROJECTS,
  TOOL_LIST_PROJECT_FIELDS,
  TOOL_GET_PROJECT_ITEM,
  TOOL_ADD_ISSUE_TO_PROJECT,
  TOOL_UPDATE_PROJECT_ITEM_FIELDS,
} from '../../constants.js';
import { createMockServer, parseResponse, type RegisteredTool } from '../test-utils.js';

const decodeToken = (token: unknown): { tool: string; params: Record<string, unknown> } =>
  JSON.parse(Buffer.from(String(token), 'base64').toString('utf8'));

describe('Project Tools', () => {
  let registeredTools: Map<string, RegisteredTool>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(octokit.graphql).mockReset();
    const mock = createMockServer();
    registeredTools = mock.registeredTools;
    registerProjectTools(mock.server);
  });

  describe(TOOL_LIST_ORG_PROJECTS, () => {
    it('should register the tool', () => {
      expect(registeredTools.has(TOOL_LIST_ORG_PROJECTS)).toBe(true);
    });

    it('should return projects on success', async () => {
      const mockProjects = {
        organization: {
          projectsV2: {
            nodes: [
              {
                id: 'PVT_kwDO1',
                title: 'Sprint Board',
                shortDescription: 'Active sprint tracking',
                public: true,
                closed: false,
                url: 'https://github.com/orgs/test/projects/1',
                number: 1,
                createdAt: '2025-01-01T00:00:00Z',
                updatedAt: '2025-01-15T00:00:00Z',
              },
              {
                id: 'PVT_kwDO2',
                title: 'Roadmap',
                shortDescription: null,
                public: false,
                closed: false,
                url: 'https://github.com/orgs/test/projects/2',
                number: 2,
                createdAt: '2025-01-02T00:00:00Z',
                updatedAt: '2025-01-16T00:00:00Z',
              },
            ],
            pageInfo: {
              hasNextPage: false,
              endCursor: null,
            },
          },
        },
      };

      vi.mocked(octokit.graphql).mockResolvedValueOnce(mockProjects as never);

      const tool = registeredTools.get(TOOL_LIST_ORG_PROJECTS);
      const result = await tool!.handler({ org: 'test-org' });

      expect(result.isError).toBeUndefined();
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.projects).toHaveLength(2);
      expect((parsed.projects as Array<{ id: string }>)[0].id).toBe('PVT_kwDO1');
    });

    it('should handle pagination', async () => {
      const mockProjects = {
        organization: {
          projectsV2: {
            nodes: [{ id: 'PVT_1', title: 'Project 1', number: 1, closed: false, public: true }],
            pageInfo: {
              hasNextPage: true,
              endCursor: 'cursor123',
            },
          },
        },
      };

      vi.mocked(octokit.graphql).mockResolvedValueOnce(mockProjects as never);

      const tool = registeredTools.get(TOOL_LIST_ORG_PROJECTS);
      const result = await tool!.handler({ org: 'test-org', first: 20, after: 'cursor123' });

      const parsed = parseResponse<{ pageInfo: { hasNextPage: boolean; endCursor: string | null } }>(result);
      expect(parsed.pageInfo.hasNextPage).toBe(true);
      expect(parsed.pageInfo.endCursor).toBe('cursor123');
    });

    it('should return error on API failure', async () => {
      const error = new Error('Organization not found');
      (error as { status?: number }).status = 404;
      vi.mocked(octokit.graphql).mockRejectedValueOnce(error);

      const tool = registeredTools.get(TOOL_LIST_ORG_PROJECTS);
      const result = await tool!.handler({ org: 'nonexistent-org' });

      expect(result.isError).toBe(true);
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.hint).toContain('project');
    });
  });

  describe(TOOL_LIST_PROJECT_FIELDS, () => {
    it('should register the tool', () => {
      expect(registeredTools.has(TOOL_LIST_PROJECT_FIELDS)).toBe(true);
    });

    it('should return fields on success', async () => {
      const mockFields = {
        node: {
          fields: {
            nodes: [
              {
                id: 'PVTSSF_status',
                name: 'Status',
                dataType: 'SINGLE_SELECT',
                options: [
                  { id: 'opt_todo', name: 'Todo', color: 'GRAY' },
                  { id: 'opt_progress', name: 'In Progress', color: 'YELLOW' },
                ],
              },
              {
                id: 'PVTF_estimate',
                name: 'Estimate',
                dataType: 'NUMBER',
              },
            ],
          },
        },
      };

      vi.mocked(octokit.graphql).mockResolvedValueOnce(mockFields as never);

      const tool = registeredTools.get(TOOL_LIST_PROJECT_FIELDS);
      const result = await tool!.handler({ project_id: 'PVT_kwDO1' });

      expect(result.isError).toBeUndefined();
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.fields).toHaveLength(2);
      expect((parsed.fields as Array<{ id: string }>)[0].id).toBe('PVTSSF_status');
    });

    it('should return error on API failure', async () => {
      const error = new Error('Project not found');
      vi.mocked(octokit.graphql).mockRejectedValueOnce(error);

      const tool = registeredTools.get(TOOL_LIST_PROJECT_FIELDS);
      const result = await tool!.handler({ project_id: 'PVT_invalid' });

      expect(result.isError).toBe(true);
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
    });
  });

  describe(TOOL_GET_PROJECT_ITEM, () => {
    it('should register the tool', () => {
      expect(registeredTools.has(TOOL_GET_PROJECT_ITEM)).toBe(true);
    });

    it('should return project item when found in first page', async () => {
      const mockProjectItem = {
        node: {
          items: {
            nodes: [
              {
                id: 'PVTI_1',
                content: { id: 'I_target', number: 123, title: 'Test Issue' },
                fieldValues: { nodes: [] },
              },
            ],
            pageInfo: {
              hasNextPage: false,
              endCursor: null,
            },
          },
        },
      };

      vi.mocked(octokit.graphql).mockResolvedValueOnce(mockProjectItem as never);

      const tool = registeredTools.get(TOOL_GET_PROJECT_ITEM);
      const result = await tool!.handler({
        project_id: 'PVT_kwDO1',
        issue_node_id: 'I_target',
      });

      expect(result.isError).toBeUndefined();
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(true);
      expect((parsed.project_item as { id: string }).id).toBe('PVTI_1');
    });

    it('should paginate to find item in later pages', async () => {
      const mockPage1 = {
        node: {
          items: {
            nodes: [{ id: 'PVTI_1', content: { id: 'I_other' }, fieldValues: { nodes: [] } }],
            pageInfo: {
              hasNextPage: true,
              endCursor: 'cursor1',
            },
          },
        },
      };

      const mockPage2 = {
        node: {
          items: {
            nodes: [
              {
                id: 'PVTI_2',
                content: { id: 'I_target', number: 123, title: 'Target Issue' },
                fieldValues: { nodes: [] },
              },
            ],
            pageInfo: {
              hasNextPage: false,
              endCursor: null,
            },
          },
        },
      };

      vi.mocked(octokit.graphql)
        .mockResolvedValueOnce(mockPage1 as never)
        .mockResolvedValueOnce(mockPage2 as never);

      const tool = registeredTools.get(TOOL_GET_PROJECT_ITEM);
      const result = await tool!.handler({
        project_id: 'PVT_kwDO1',
        issue_node_id: 'I_target',
      });

      expect(result.isError).toBeUndefined();
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(true);
      expect((parsed.project_item as { id: string }).id).toBe('PVTI_2');
    });

    it('should return error when item not found', async () => {
      const mockProjectItem = {
        node: {
          items: {
            nodes: [{ id: 'PVTI_1', content: { id: 'I_other' }, fieldValues: { nodes: [] } }],
            pageInfo: {
              hasNextPage: false,
              endCursor: null,
            },
          },
        },
      };

      vi.mocked(octokit.graphql).mockResolvedValueOnce(mockProjectItem as never);

      const tool = registeredTools.get(TOOL_GET_PROJECT_ITEM);
      const result = await tool!.handler({
        project_id: 'PVT_kwDO1',
        issue_node_id: 'I_notFound',
      });

      expect(result.isError).toBe(true);
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('not found');
    });
  });

  describe(TOOL_ADD_ISSUE_TO_PROJECT, () => {
    it('should register the tool', () => {
      expect(registeredTools.has(TOOL_ADD_ISSUE_TO_PROJECT)).toBe(true);
    });

    const resolvedAddPreview = {
      project: { __typename: 'ProjectV2', id: 'PVT_kwDO1', title: 'Sprint Board' },
      content: {
        __typename: 'Issue',
        number: 123,
        title: 'Real issue title',
        repository: { nameWithOwner: 'acme/widgets' },
      },
    };

    it('previews the project and issue resolved from the ids, not model-supplied labels', async () => {
      vi.mocked(octokit.graphql).mockResolvedValueOnce(resolvedAddPreview as never);

      const tool = registeredTools.get(TOOL_ADD_ISSUE_TO_PROJECT);
      const result = await tool!.handler({
        project_id: 'PVT_kwDO1',
        issue_node_id: 'I_kwDO123',
        display_project_name: 'Roadmap',
        display_issue_title: '#12 - Typo fix',
        display_repository: 'other/repo',
        _executeFromButton: false,
      });

      expect(octokit.graphql).toHaveBeenCalledTimes(1);
      expect(vi.mocked(octokit.graphql).mock.calls[0][1]).toEqual({ projectId: 'PVT_kwDO1', contentId: 'I_kwDO123' });
      const text = result.content[0].text;
      const parsed = parseResponse(result);
      expect(parsed.action).toBe('preview');
      expect(text).toContain('Sprint Board (PVT_kwDO1)');
      expect(text).toContain('#123 - Real issue title (I_kwDO123)');
      expect(text).toContain('acme/widgets');
      expect(text).not.toContain('Roadmap');
      expect(text).not.toContain('Typo fix');
      expect(text).not.toContain('other/repo');

      expect(decodeToken(parsed._confirmToken).params).toEqual({
        project_id: 'PVT_kwDO1',
        issue_node_id: 'I_kwDO123',
        display_project_name: 'Sprint Board',
        display_issue_title: '#123 - Real issue title',
        display_repository: 'acme/widgets',
      });
    });

    it('refuses to preview (no token) when the project id does not resolve to a project', async () => {
      vi.mocked(octokit.graphql).mockResolvedValueOnce({
        ...resolvedAddPreview,
        project: { __typename: 'Issue' },
      } as never);

      const tool = registeredTools.get(TOOL_ADD_ISSUE_TO_PROJECT);
      const result = await tool!.handler({ project_id: 'PVT_kwDO1', issue_node_id: 'I_kwDO123' });

      expect(result.isError).toBe(true);
      expect(parseResponse(result)._confirmToken).toBeUndefined();
    });

    it('refuses to preview (no token) when the lookup fails', async () => {
      vi.mocked(octokit.graphql).mockRejectedValueOnce(new Error('Could not resolve to a node'));

      const tool = registeredTools.get(TOOL_ADD_ISSUE_TO_PROJECT);
      const result = await tool!.handler({ project_id: 'PVT_kwDO1', issue_node_id: 'I_kwDO123' });

      expect(result.isError).toBe(true);
      expect(parseResponse(result)._confirmToken).toBeUndefined();
    });

    it('should add issue when executed from button', async () => {
      const mockAddResult = {
        addProjectV2ItemById: {
          item: {
            id: 'PVTI_lADO789',
          },
        },
      };

      vi.mocked(octokit.graphql).mockResolvedValueOnce(mockAddResult as never);

      const tool = registeredTools.get(TOOL_ADD_ISSUE_TO_PROJECT);
      const result = await tool!.handler({
        project_id: 'PVT_kwDO1',
        issue_node_id: 'I_kwDO123',
        _executeFromButton: true,
      });

      expect(result.isError).toBeUndefined();
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.item_id).toBe('PVTI_lADO789');
    });
  });

  describe(TOOL_UPDATE_PROJECT_ITEM_FIELDS, () => {
    it('should register the tool', () => {
      expect(registeredTools.has(TOOL_UPDATE_PROJECT_ITEM_FIELDS)).toBe(true);
    });

    const itemPreview = {
      node: {
        __typename: 'ProjectV2Item',
        project: { id: 'PVT_kwDO1', title: 'Sprint Board' },
        content: {
          __typename: 'Issue',
          number: 7,
          title: 'Real item title',
          repository: { nameWithOwner: 'acme/widgets' },
        },
      },
    };
    const projectFields = {
      node: {
        fields: {
          nodes: [
            {
              id: 'PVTSSF_status',
              name: 'Status',
              dataType: 'SINGLE_SELECT',
              options: [
                { id: 'opt_todo', name: 'Todo', color: 'GRAY' },
                { id: 'opt_progress', name: 'In Progress', color: 'YELLOW' },
              ],
            },
            {
              id: 'PVTIF_sprint',
              name: 'Sprint',
              dataType: 'ITERATION',
              configuration: {
                iterations: [{ id: 'iter_1', title: 'Sprint 1', startDate: '2026-01-01', duration: 14 }],
              },
            },
            { id: 'PVTF_estimate', name: 'Estimate', dataType: 'NUMBER' },
            { id: 'PVTF_target', name: 'Target date', dataType: 'DATE' },
          ],
        },
      },
    };

    // The two preview lookups run in parallel, so route each mock by query text rather than call order.
    const mockPreviewLookups = (overrides: { item?: unknown; fields?: unknown } = {}) => {
      vi.mocked(octokit.graphql).mockImplementation((async (query: string) =>
        query.includes('ProjectV2Item {') && !query.includes('fields(')
          ? (overrides.item ?? itemPreview)
          : (overrides.fields ?? projectFields)) as never);
    };

    const previewUpdate = (updates: Array<Record<string, unknown>>) =>
      registeredTools.get(TOOL_UPDATE_PROJECT_ITEM_FIELDS)!.handler({
        project_id: 'PVT_kwDO1',
        item_id: 'PVTI_lADO789',
        updates,
        display_project_name: 'Roadmap',
        display_issue_title: '#12 - Typo fix',
        _executeFromButton: false,
      });

    it('previews resolved field, option and iteration names, never the model labels', async () => {
      mockPreviewLookups();

      const result = await previewUpdate([
        { field_id: 'PVTSSF_status', value: 'opt_progress', field_name: 'Priority', new_value: 'Done' },
        { field_id: 'PVTIF_sprint', value: 'iter_1', new_value: 'Sprint 99' },
        { field_id: 'PVTF_estimate', value: 5, current_value: '1', new_value: '8' },
        { field_id: 'PVTF_target', value: '2026-03-01T00:00:00Z' },
      ]);

      const text = result.content[0].text;
      const parsed = parseResponse(result);
      expect(parsed.action).toBe('preview');
      expect(text).toContain('Sprint Board - #7 - Real item title');
      expect(text).toContain('Status (PVTSSF_status)');
      expect(text).toContain('In Progress');
      expect(text).toContain('Sprint 1');
      expect(text).toContain('2026-03-01');
      for (const modelLabel of ['Roadmap', 'Typo fix', 'Priority', 'Done', 'Sprint 99']) {
        expect(text).not.toContain(modelLabel);
      }

      expect(decodeToken(parsed._confirmToken).params).toEqual({
        project_id: 'PVT_kwDO1',
        item_id: 'PVTI_lADO789',
        display_project_name: 'Sprint Board',
        display_issue_title: '#7 - Real item title',
        display_repository: 'acme/widgets',
        updates: [
          {
            field_id: 'PVTSSF_status',
            value: 'opt_progress',
            display_field_name: 'Status',
            display_value: 'In Progress',
          },
          { field_id: 'PVTIF_sprint', value: 'iter_1', display_field_name: 'Sprint', display_value: 'Sprint 1' },
          { field_id: 'PVTF_estimate', value: 5, display_field_name: 'Estimate', display_value: '5' },
          {
            field_id: 'PVTF_target',
            value: '2026-03-01T00:00:00Z',
            display_field_name: 'Target date',
            display_value: '2026-03-01',
          },
        ],
      });
    });

    it.each([
      ['a field id that is not in the project', { field_id: 'PVTF_unknown', value: 3 }],
      ['an option id that is not one of the field options', { field_id: 'PVTSSF_status', value: 'opt_elsewhere' }],
      ['an iteration id that is not one of the field iterations', { field_id: 'PVTIF_sprint', value: 'iter_9' }],
    ])('refuses to preview (no token) for %s', async (_label, update) => {
      mockPreviewLookups();

      const result = await previewUpdate([update]);

      expect(result.isError).toBe(true);
      expect(parseResponse(result)._confirmToken).toBeUndefined();
    });

    it('refuses to preview (no token) when the item belongs to a different project', async () => {
      mockPreviewLookups({ item: { node: { ...itemPreview.node, project: { id: 'PVT_other', title: 'Other' } } } });

      const result = await previewUpdate([{ field_id: 'PVTSSF_status', value: 'opt_progress' }]);

      expect(result.isError).toBe(true);
      expect(parseResponse(result)._confirmToken).toBeUndefined();
    });

    it('should reject invalid item_id format', async () => {
      const tool = registeredTools.get(TOOL_UPDATE_PROJECT_ITEM_FIELDS);
      const result = await tool!.handler({
        project_id: 'PVT_kwDO1',
        item_id: 'I_kwDO123', // Wrong format - should be PVTI_
        updates: [
          {
            field_id: 'PVTSSF_status',
            value: 'opt_progress',
            field_name: 'Status',
            new_value: 'In Progress',
          },
        ],
        _executeFromButton: true,
      });

      expect(result.isError).toBe(true);
      const parsed = parseResponse(result);
      expect(parsed.error).toContain('Invalid item_id format');
      expect(parsed.problem).toContain('I_');
    });

    it('should update fields when executed from button', async () => {
      const mockUpdateResult = {
        updateProjectV2ItemFieldValue: {
          projectV2Item: {
            id: 'PVTI_lADO789',
          },
        },
      };

      vi.mocked(octokit.graphql).mockResolvedValueOnce(mockUpdateResult as never);

      const tool = registeredTools.get(TOOL_UPDATE_PROJECT_ITEM_FIELDS);
      const result = await tool!.handler({
        project_id: 'PVT_kwDO1',
        item_id: 'PVTI_lADO789',
        updates: [
          {
            field_id: 'PVTSSF_status',
            value: 'opt_progress',
            field_name: 'Status',
            new_value: 'In Progress',
          },
        ],
        _executeFromButton: true,
      });

      expect(result.isError).toBe(false);
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(true);
      expect(octokit.graphql).toHaveBeenCalled();
    });
  });
});
