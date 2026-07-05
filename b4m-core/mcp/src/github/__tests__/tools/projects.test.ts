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

describe('Project Tools', () => {
  let registeredTools: Map<string, RegisteredTool>;

  beforeEach(() => {
    vi.clearAllMocks();
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

    it('should return preview when not executed from button', async () => {
      const tool = registeredTools.get(TOOL_ADD_ISSUE_TO_PROJECT);
      const result = await tool!.handler({
        project_id: 'PVT_kwDO1',
        issue_node_id: 'I_kwDO123',
        display_project_name: 'Sprint Board',
        display_issue_title: '#123 - Test Issue',
        _executeFromButton: false,
      });

      expect(octokit.graphql).not.toHaveBeenCalled();
      const parsed = parseResponse(result);
      expect(parsed.action).toBe('preview');
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

    it('should return preview when not executed from button', async () => {
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
        _executeFromButton: false,
      });

      expect(octokit.graphql).not.toHaveBeenCalled();
      const parsed = parseResponse(result);
      expect(parsed.action).toBe('preview');
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
