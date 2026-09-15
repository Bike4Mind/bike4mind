import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgileApi } from '../../agile/api';
import type { JiraConfig } from '../../api';

describe('AgileApi', () => {
  let mockConfig: JiraConfig;
  let agileApi: AgileApi;

  beforeEach(() => {
    mockConfig = {
      accessToken: 'test-token',
      cloudId: 'test-cloud-id',
      siteUrl: 'https://test.atlassian.net',
      webBaseUrl: 'https://test.atlassian.net/browse',
      apiBaseUrl: 'https://api.atlassian.com/ex/jira/test-cloud-id/rest/api/3',
      agileApiBaseUrl: 'https://api.atlassian.com/ex/jira/test-cloud-id/rest/agile/1.0',
      authHeader: 'Bearer test-token',
    };
    agileApi = new AgileApi(mockConfig);
    global.fetch = vi.fn();
  });

  // Board Operations
  describe('listBoards', () => {
    it('should call GET /board endpoint and format response', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
      const mockResponse = {
        maxResults: 50,
        startAt: 0,
        total: 2,
        isLast: true,
        values: [
          {
            id: 1,
            self: 'https://api.atlassian.com/...',
            name: 'Scrum Board',
            type: 'scrum',
            location: {
              projectId: 10000,
              projectKey: 'PROJ',
              projectName: 'Test Project',
            },
          },
          {
            id: 2,
            self: 'https://api.atlassian.com/...',
            name: 'Kanban Board',
            type: 'kanban',
            location: {
              projectId: 10001,
              projectKey: 'KAN',
              projectName: 'Kanban Project',
            },
          },
        ],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockResponse,
      } as Response);

      const result = await agileApi.listBoards();

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const callArgs = mockFetch.mock.calls[0];
      expect(callArgs[0]).toContain('/board');
      expect(callArgs[1]?.method).toBe('GET');

      expect(result).toEqual({
        total: 2,
        startAt: 0,
        maxResults: 50,
        isLast: true,
        boards: [
          {
            id: 1,
            name: 'Scrum Board',
            type: 'scrum',
            link: 'https://test.atlassian.net/jira/software/projects/PROJ/boards/1',
            project: { key: 'PROJ', name: 'Test Project' },
          },
          {
            id: 2,
            name: 'Kanban Board',
            type: 'kanban',
            link: 'https://test.atlassian.net/jira/software/projects/KAN/boards/2',
            project: { key: 'KAN', name: 'Kanban Project' },
          },
        ],
      });
    });

    it('should pass filter parameters to API', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ values: [], total: 0, startAt: 0, maxResults: 10, isLast: true }),
      } as Response);

      await agileApi.listBoards({
        startAt: 10,
        maxResults: 25,
        type: 'scrum',
        name: 'Test',
        projectKeyOrId: 'PROJ',
      });

      const callArgs = mockFetch.mock.calls[0];
      const url = callArgs[0] as string;
      expect(url).toContain('startAt=10');
      expect(url).toContain('maxResults=25');
      expect(url).toContain('type=scrum');
      expect(url).toContain('name=Test');
      expect(url).toContain('projectKeyOrId=PROJ');
    });
  });

  describe('getBoard', () => {
    it('should call GET /board/{boardId} endpoint and format response', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
      const mockResponse = {
        id: 1,
        self: 'https://api.atlassian.com/...',
        name: 'Scrum Board',
        type: 'scrum',
        location: {
          projectId: 10000,
          projectKey: 'PROJ',
          projectName: 'Test Project',
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockResponse,
      } as Response);

      const result = await agileApi.getBoard({ boardId: 1 });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const callArgs = mockFetch.mock.calls[0];
      expect(callArgs[0]).toContain('/board/1');
      expect(callArgs[1]?.method).toBe('GET');

      expect(result).toEqual({
        id: 1,
        name: 'Scrum Board',
        type: 'scrum',
        link: 'https://test.atlassian.net/jira/software/projects/PROJ/boards/1',
        project: { key: 'PROJ', name: 'Test Project' },
      });
    });
  });

  // Sprint Operations
  describe('listSprints', () => {
    it('should call GET /board/{boardId}/sprint endpoint and format response', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
      const mockResponse = {
        maxResults: 50,
        startAt: 0,
        isLast: true,
        values: [
          {
            id: 1,
            self: 'https://api.atlassian.com/...',
            state: 'active',
            name: 'Sprint 1',
            startDate: '2024-01-01T00:00:00.000Z',
            endDate: '2024-01-14T00:00:00.000Z',
            originBoardId: 1,
            goal: 'Complete feature X',
          },
          {
            id: 2,
            self: 'https://api.atlassian.com/...',
            state: 'future',
            name: 'Sprint 2',
            originBoardId: 1,
          },
        ],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockResponse,
      } as Response);

      const result = await agileApi.listSprints({ boardId: 1 });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const callArgs = mockFetch.mock.calls[0];
      expect(callArgs[0]).toContain('/board/1/sprint');
      expect(callArgs[1]?.method).toBe('GET');

      expect(result.sprints).toHaveLength(2);
      expect(result.sprints[0]).toMatchObject({
        id: 1,
        name: 'Sprint 1',
        state: 'active',
        goal: 'Complete feature X',
      });
      expect(result.sprints[1]).toMatchObject({
        id: 2,
        name: 'Sprint 2',
        state: 'future',
      });
    });

    it('should filter by sprint state', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ values: [], startAt: 0, maxResults: 50, isLast: true }),
      } as Response);

      await agileApi.listSprints({ boardId: 1, state: 'active' });

      const callArgs = mockFetch.mock.calls[0];
      const url = callArgs[0] as string;
      expect(url).toContain('state=active');
    });
  });

  describe('getSprint', () => {
    it('should call GET /sprint/{sprintId} endpoint and format response', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
      const mockResponse = {
        id: 1,
        self: 'https://api.atlassian.com/...',
        state: 'active',
        name: 'Sprint 1',
        startDate: '2024-01-01T00:00:00.000Z',
        endDate: '2024-01-14T00:00:00.000Z',
        originBoardId: 1,
        goal: 'Complete feature X',
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockResponse,
      } as Response);

      const result = await agileApi.getSprint({ sprintId: 1 });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const callArgs = mockFetch.mock.calls[0];
      expect(callArgs[0]).toContain('/sprint/1');
      expect(callArgs[1]?.method).toBe('GET');

      expect(result).toMatchObject({
        id: 1,
        name: 'Sprint 1',
        state: 'active',
        goal: 'Complete feature X',
        originBoardId: 1,
      });
    });
  });

  describe('createSprint', () => {
    it('should call POST /sprint endpoint with body and format response', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
      const mockResponse = {
        id: 3,
        self: 'https://api.atlassian.com/...',
        state: 'future',
        name: 'Sprint 3',
        originBoardId: 1,
        goal: 'New sprint goal',
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockResponse,
      } as Response);

      const result = await agileApi.createSprint({
        name: 'Sprint 3',
        originBoardId: 1,
        goal: 'New sprint goal',
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const callArgs = mockFetch.mock.calls[0];
      expect(callArgs[0]).toContain('/sprint');
      expect(callArgs[1]?.method).toBe('POST');

      const body = JSON.parse(callArgs[1]?.body as string);
      expect(body).toEqual({
        name: 'Sprint 3',
        originBoardId: 1,
        goal: 'New sprint goal',
      });

      expect(result).toMatchObject({
        id: 3,
        name: 'Sprint 3',
        state: 'future',
        goal: 'New sprint goal',
      });
    });

    it('should include optional dates when provided', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 1, name: 'Sprint', originBoardId: 1, state: 'future' }),
      } as Response);

      await agileApi.createSprint({
        name: 'Sprint',
        originBoardId: 1,
        startDate: '2024-01-01T00:00:00.000Z',
        endDate: '2024-01-14T00:00:00.000Z',
      });

      const callArgs = mockFetch.mock.calls[0];
      const body = JSON.parse(callArgs[1]?.body as string);
      expect(body.startDate).toBe('2024-01-01T00:00:00.000Z');
      expect(body.endDate).toBe('2024-01-14T00:00:00.000Z');
    });
  });

  describe('updateSprint', () => {
    it('should call POST /sprint/{sprintId} with only provided fields', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
      const mockResponse = {
        id: 1,
        self: 'https://api.atlassian.com/...',
        state: 'active',
        name: 'Updated Sprint Name',
        originBoardId: 1,
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockResponse,
      } as Response);

      await agileApi.updateSprint({
        sprintId: 1,
        name: 'Updated Sprint Name',
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const callArgs = mockFetch.mock.calls[0];
      expect(callArgs[0]).toContain('/sprint/1');
      expect(callArgs[1]?.method).toBe('POST');

      const body = JSON.parse(callArgs[1]?.body as string);
      expect(body).toEqual({ name: 'Updated Sprint Name' });
    });

    it('should start sprint by setting state to active', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 1, name: 'Sprint', state: 'active', originBoardId: 1 }),
      } as Response);

      await agileApi.updateSprint({
        sprintId: 1,
        state: 'active',
      });

      const callArgs = mockFetch.mock.calls[0];
      const body = JSON.parse(callArgs[1]?.body as string);
      expect(body).toEqual({ state: 'active' });
    });

    it('should close sprint by setting state to closed', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 1, name: 'Sprint', state: 'closed', originBoardId: 1 }),
      } as Response);

      await agileApi.updateSprint({
        sprintId: 1,
        state: 'closed',
      });

      const callArgs = mockFetch.mock.calls[0];
      const body = JSON.parse(callArgs[1]?.body as string);
      expect(body).toEqual({ state: 'closed' });
    });
  });

  // Sprint Issue Operations
  describe('getSprintIssues', () => {
    it('should call GET /sprint/{sprintId}/issue endpoint and format response', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
      const mockResponse = {
        startAt: 0,
        maxResults: 50,
        total: 1,
        issues: [
          {
            id: '10001',
            key: 'PROJ-1',
            self: 'https://api.atlassian.com/...',
            fields: {
              summary: 'Test Issue',
              status: { name: 'In Progress' },
              issuetype: { name: 'Story' },
              priority: { name: 'High' },
            },
          },
        ],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockResponse,
      } as Response);

      const result = await agileApi.getSprintIssues({ sprintId: 1 });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const callArgs = mockFetch.mock.calls[0];
      expect(callArgs[0]).toContain('/sprint/1/issue');
      expect(callArgs[1]?.method).toBe('GET');

      expect(result.total).toBe(1);
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0]).toMatchObject({
        id: '10001',
        key: 'PROJ-1',
        summary: 'Test Issue',
        status: 'In Progress',
        issueType: 'Story',
      });
    });

    it('should pass JQL filter when provided', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ issues: [], total: 0, startAt: 0, maxResults: 50 }),
      } as Response);

      await agileApi.getSprintIssues({
        sprintId: 1,
        jql: 'status = "In Progress"',
      });

      const callArgs = mockFetch.mock.calls[0];
      const url = callArgs[0] as string;
      expect(url).toContain('jql=');
    });
  });

  describe('moveIssuesToSprint', () => {
    it('should call POST /sprint/{sprintId}/issue with issues array', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 204,
        json: async () => ({}),
      } as Response);

      await agileApi.moveIssuesToSprint({
        sprintId: 1,
        issues: ['PROJ-1', 'PROJ-2', 'PROJ-3'],
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const callArgs = mockFetch.mock.calls[0];
      expect(callArgs[0]).toContain('/sprint/1/issue');
      expect(callArgs[1]?.method).toBe('POST');

      const body = JSON.parse(callArgs[1]?.body as string);
      expect(body).toEqual({ issues: ['PROJ-1', 'PROJ-2', 'PROJ-3'] });
    });

    it('should not make API call when issues array is empty', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;

      await agileApi.moveIssuesToSprint({
        sprintId: 1,
        issues: [],
      });

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should throw error when more than 50 issues are provided', async () => {
      const issues = Array.from({ length: 51 }, (_, i) => `PROJ-${i + 1}`);

      await expect(agileApi.moveIssuesToSprint({ sprintId: 1, issues })).rejects.toThrow(
        'Maximum 50 issues can be moved to a sprint in one operation'
      );
    });
  });

  // Board Configuration Operations
  describe('getBoardConfiguration', () => {
    it('should call GET /board/{boardId}/configuration endpoint and format response', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
      const mockResponse = {
        id: 1,
        name: 'Kanban Board',
        type: 'kanban',
        self: 'https://api.atlassian.com/...',
        filter: {
          id: '10001',
          name: 'Board Filter',
          self: 'https://api.atlassian.com/...',
        },
        subQuery: {
          query: 'project = PROJ ORDER BY Rank ASC',
        },
        columnConfig: {
          columns: [
            {
              name: 'To Do',
              statuses: [{ id: '10000', self: 'https://...' }],
            },
            {
              name: 'In Progress',
              statuses: [{ id: '10001', self: 'https://...' }],
              min: 1,
              max: 5,
            },
            {
              name: 'Done',
              statuses: [{ id: '10002', self: 'https://...' }],
            },
          ],
          constraintType: 'issueCount',
        },
        estimation: {
          type: 'field',
          field: {
            fieldId: 'customfield_10001',
            displayName: 'Story Points',
          },
        },
        ranking: {
          rankCustomFieldId: 10002,
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockResponse,
      } as Response);

      const result = await agileApi.getBoardConfiguration({ boardId: 1 });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const callArgs = mockFetch.mock.calls[0];
      expect(callArgs[0]).toContain('/board/1/configuration');
      expect(callArgs[1]?.method).toBe('GET');

      expect(result).toEqual({
        id: 1,
        name: 'Kanban Board',
        type: 'kanban',
        link: 'https://test.atlassian.net/jira/software/c/projects?rapidView=1',
        filter: {
          id: '10001',
          name: 'Board Filter',
        },
        jqlFilter: 'project = PROJ ORDER BY Rank ASC',
        columns: [
          { name: 'To Do', statusIds: ['10000'], min: undefined, max: undefined },
          { name: 'In Progress', statusIds: ['10001'], min: 1, max: 5 },
          { name: 'Done', statusIds: ['10002'], min: undefined, max: undefined },
        ],
        constraintType: 'issueCount',
        estimation: {
          type: 'field',
          fieldName: 'Story Points',
        },
        rankingFieldId: 10002,
      });
    });

    it('should throw error for invalid boardId', async () => {
      await expect(agileApi.getBoardConfiguration({ boardId: -1 })).rejects.toThrow(
        'Invalid boardId: -1. Must be a positive integer.'
      );
    });
  });

  // Board Issues Operations
  describe('getBoardIssues', () => {
    it('should call GET /board/{boardId}/issue endpoint and format response', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
      const mockResponse = {
        startAt: 0,
        maxResults: 50,
        total: 2,
        issues: [
          {
            id: '10001',
            key: 'PROJ-1',
            self: 'https://api.atlassian.com/...',
            fields: {
              summary: 'First Issue',
              status: { name: 'To Do' },
              issuetype: { name: 'Story' },
              priority: { name: 'High' },
              assignee: {
                accountId: 'user1',
                displayName: 'User One',
              },
            },
          },
          {
            id: '10002',
            key: 'PROJ-2',
            self: 'https://api.atlassian.com/...',
            fields: {
              summary: 'Second Issue',
              status: { name: 'In Progress' },
              issuetype: { name: 'Bug' },
              priority: { name: 'Critical' },
            },
          },
        ],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockResponse,
      } as Response);

      const result = await agileApi.getBoardIssues({ boardId: 1 });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const callArgs = mockFetch.mock.calls[0];
      expect(callArgs[0]).toContain('/board/1/issue');
      expect(callArgs[1]?.method).toBe('GET');

      expect(result.total).toBe(2);
      expect(result.issues).toHaveLength(2);
      expect(result.issues[0]).toMatchObject({
        id: '10001',
        key: 'PROJ-1',
        summary: 'First Issue',
        status: 'To Do',
      });
    });

    it('should pass JQL filter when provided', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ issues: [], total: 0, startAt: 0, maxResults: 50 }),
      } as Response);

      await agileApi.getBoardIssues({
        boardId: 1,
        jql: 'status = "In Progress"',
      });

      const callArgs = mockFetch.mock.calls[0];
      const url = callArgs[0] as string;
      expect(url).toContain('jql=');
    });

    it('should group issues by status when groupBy is specified', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
      const mockResponse = {
        startAt: 0,
        maxResults: 50,
        total: 3,
        issues: [
          {
            id: '10001',
            key: 'PROJ-1',
            fields: {
              summary: 'Issue 1',
              status: { name: 'To Do' },
              issuetype: { name: 'Story' },
            },
          },
          {
            id: '10002',
            key: 'PROJ-2',
            fields: {
              summary: 'Issue 2',
              status: { name: 'In Progress' },
              issuetype: { name: 'Story' },
            },
          },
          {
            id: '10003',
            key: 'PROJ-3',
            fields: {
              summary: 'Issue 3',
              status: { name: 'To Do' },
              issuetype: { name: 'Bug' },
            },
          },
        ],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockResponse,
      } as Response);

      const result = await agileApi.getBoardIssues({ boardId: 1, groupBy: 'status' });

      expect(result.groupedBy).toBe('status');
      expect(result.groups).toBeDefined();
      expect(result.groups).toHaveLength(2);

      const todoGroup = result.groups?.find(g => g.key === 'To Do');
      expect(todoGroup).toBeDefined();
      expect(todoGroup?.issues).toHaveLength(2);

      const inProgressGroup = result.groups?.find(g => g.key === 'In Progress');
      expect(inProgressGroup).toBeDefined();
      expect(inProgressGroup?.issues).toHaveLength(1);
    });

    it('should throw error for invalid boardId', async () => {
      await expect(agileApi.getBoardIssues({ boardId: 0 })).rejects.toThrow(
        'Invalid boardId: 0. Must be a positive integer.'
      );
    });
  });

  // Error Handling
  describe('error handling', () => {
    it('should throw descriptive error for Jira Software license issues', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => 'Jira Software is not enabled for this site',
      } as Response);

      await expect(agileApi.listBoards()).rejects.toThrow('Jira Software is not available');
    });

    it('should throw error with status code for other API errors', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => 'Board not found',
      } as Response);

      await expect(agileApi.getBoard({ boardId: 999 })).rejects.toThrow('Jira Agile API error (404)');
    });
  });
});
