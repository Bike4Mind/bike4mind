import { describe, it, expect } from 'vitest';
import {
  formatBoard,
  formatBoardList,
  formatSprint,
  formatSprintList,
  formatSprintIssues,
  formatBoardConfiguration,
  formatBoardIssues,
} from '../../agile/format';

const SITE_URL = 'https://test.atlassian.net';

describe('Agile Formatters', () => {
  // Board Formatters
  describe('formatBoard', () => {
    it('should format board with project info', () => {
      const rawBoard = {
        id: 1,
        self: 'https://api.atlassian.com/ex/jira/xxx/rest/agile/1.0/board/1',
        name: 'Scrum Board',
        type: 'scrum' as const,
        location: {
          projectId: 10000,
          projectKey: 'PROJ',
          projectName: 'Test Project',
          displayName: 'Test Project (PROJ)',
        },
      };

      const result = formatBoard(rawBoard, SITE_URL);

      expect(result).toEqual({
        id: 1,
        name: 'Scrum Board',
        type: 'scrum',
        link: 'https://test.atlassian.net/jira/software/projects/PROJ/boards/1',
        project: {
          key: 'PROJ',
          name: 'Test Project',
        },
      });
    });

    it('should handle board without location', () => {
      const rawBoard = {
        id: 1,
        name: 'Simple Board',
        type: 'kanban' as const,
      };

      const result = formatBoard(rawBoard, SITE_URL);

      expect(result.id).toBe(1);
      expect(result.name).toBe('Simple Board');
      expect(result.type).toBe('kanban');
      expect(result.project).toBeUndefined();
    });

    it('should strip /wiki suffix from siteUrl when building link', () => {
      const rawBoard = {
        id: 1,
        name: 'Board',
        type: 'scrum' as const,
        location: { projectKey: 'PROJ', projectName: 'Project' },
      };

      const result = formatBoard(rawBoard, 'https://test.atlassian.net/wiki');

      expect(result.link).toBe('https://test.atlassian.net/jira/software/projects/PROJ/boards/1');
    });
  });

  describe('formatBoardList', () => {
    it('should format list of boards with pagination', () => {
      const rawResponse = {
        maxResults: 50,
        startAt: 0,
        total: 2,
        isLast: true,
        values: [
          {
            id: 1,
            name: 'Board 1',
            type: 'scrum' as const,
            location: { projectKey: 'P1', projectName: 'Project 1' },
          },
          {
            id: 2,
            name: 'Board 2',
            type: 'kanban' as const,
            location: { projectKey: 'P2', projectName: 'Project 2' },
          },
        ],
      };

      const result = formatBoardList(rawResponse, SITE_URL);

      expect(result.total).toBe(2);
      expect(result.startAt).toBe(0);
      expect(result.maxResults).toBe(50);
      expect(result.isLast).toBe(true);
      expect(result.boards).toHaveLength(2);
      expect(result.boards[0].id).toBe(1);
      expect(result.boards[1].id).toBe(2);
    });

    it('should handle empty board list', () => {
      const rawResponse = {
        maxResults: 50,
        startAt: 0,
        total: 0,
        isLast: true,
        values: [],
      };

      const result = formatBoardList(rawResponse, SITE_URL);

      expect(result.total).toBe(0);
      expect(result.boards).toHaveLength(0);
    });
  });

  // Sprint Formatters
  describe('formatSprint', () => {
    it('should format active sprint with all fields', () => {
      const rawSprint = {
        id: 1,
        self: 'https://api.atlassian.com/...',
        state: 'active' as const,
        name: 'Sprint 1',
        startDate: '2024-01-01T00:00:00.000Z',
        endDate: '2024-01-14T00:00:00.000Z',
        originBoardId: 10,
        goal: 'Complete feature X',
      };

      const result = formatSprint(rawSprint, SITE_URL);

      expect(result).toEqual({
        id: 1,
        name: 'Sprint 1',
        state: 'active',
        goal: 'Complete feature X',
        startDate: '2024-01-01T00:00:00.000Z',
        endDate: '2024-01-14T00:00:00.000Z',
        completeDate: undefined,
        originBoardId: 10,
        link: 'https://test.atlassian.net/jira/software/c/projects?selectedProjectType=software&rapidView=10',
      });
    });

    it('should format closed sprint with completeDate', () => {
      const rawSprint = {
        id: 2,
        state: 'closed' as const,
        name: 'Sprint 2',
        startDate: '2024-01-01T00:00:00.000Z',
        endDate: '2024-01-14T00:00:00.000Z',
        completeDate: '2024-01-13T00:00:00.000Z',
        originBoardId: 10,
      };

      const result = formatSprint(rawSprint, SITE_URL);

      expect(result.state).toBe('closed');
      expect(result.completeDate).toBe('2024-01-13T00:00:00.000Z');
    });

    it('should format future sprint without dates', () => {
      const rawSprint = {
        id: 3,
        state: 'future' as const,
        name: 'Sprint 3',
        originBoardId: 10,
      };

      const result = formatSprint(rawSprint, SITE_URL);

      expect(result.state).toBe('future');
      expect(result.startDate).toBeUndefined();
      expect(result.endDate).toBeUndefined();
      expect(result.goal).toBeUndefined();
    });

    it('should use provided boardId for link when available', () => {
      const rawSprint = {
        id: 1,
        name: 'Sprint',
        state: 'active' as const,
        originBoardId: 10,
      };

      const result = formatSprint(rawSprint, SITE_URL, 20);

      expect(result.link).toContain('rapidView=20');
    });
  });

  describe('formatSprintList', () => {
    it('should format list of sprints with pagination', () => {
      const rawResponse = {
        maxResults: 50,
        startAt: 0,
        isLast: true,
        values: [
          {
            id: 1,
            name: 'Sprint 1',
            state: 'closed' as const,
            originBoardId: 10,
          },
          {
            id: 2,
            name: 'Sprint 2',
            state: 'active' as const,
            originBoardId: 10,
          },
          {
            id: 3,
            name: 'Sprint 3',
            state: 'future' as const,
            originBoardId: 10,
          },
        ],
      };

      const result = formatSprintList(rawResponse, SITE_URL, 10);

      expect(result.startAt).toBe(0);
      expect(result.maxResults).toBe(50);
      expect(result.isLast).toBe(true);
      expect(result.sprints).toHaveLength(3);
      expect(result.sprints[0].state).toBe('closed');
      expect(result.sprints[1].state).toBe('active');
      expect(result.sprints[2].state).toBe('future');
    });

    it('should handle empty sprint list', () => {
      const rawResponse = {
        maxResults: 50,
        startAt: 0,
        isLast: true,
        values: [],
      };

      const result = formatSprintList(rawResponse, SITE_URL, 10);

      expect(result.sprints).toHaveLength(0);
    });
  });

  // Sprint Issues Formatter
  describe('formatSprintIssues', () => {
    it('should format sprint issues with pagination', () => {
      const rawResponse = {
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

      const result = formatSprintIssues(rawResponse, SITE_URL);

      expect(result.total).toBe(2);
      expect(result.startAt).toBe(0);
      expect(result.maxResults).toBe(50);
      expect(result.issues).toHaveLength(2);

      // First issue with assignee
      expect(result.issues[0]).toMatchObject({
        id: '10001',
        key: 'PROJ-1',
        summary: 'First Issue',
        status: 'To Do',
        issueType: 'Story',
        priority: 'High',
      });
      expect(result.issues[0].assignee).toMatchObject({
        accountId: 'user1',
        displayName: 'User One',
      });

      // Second issue without assignee
      expect(result.issues[1]).toMatchObject({
        id: '10002',
        key: 'PROJ-2',
        summary: 'Second Issue',
        status: 'In Progress',
        issueType: 'Bug',
        priority: 'Critical',
      });
    });

    it('should handle empty issues list', () => {
      const rawResponse = {
        startAt: 0,
        maxResults: 50,
        total: 0,
        issues: [],
      };

      const result = formatSprintIssues(rawResponse, SITE_URL);

      expect(result.total).toBe(0);
      expect(result.issues).toHaveLength(0);
    });
  });

  // Board Configuration Formatter
  describe('formatBoardConfiguration', () => {
    it('should format board configuration with columns and WIP limits', () => {
      const rawConfig = {
        id: 1,
        name: 'Kanban Board',
        type: 'kanban' as const,
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
              statuses: [
                { id: '10001', self: 'https://...' },
                { id: '10002', self: 'https://...' },
              ],
              min: 1,
              max: 5,
            },
            {
              name: 'Done',
              statuses: [{ id: '10003', self: 'https://...' }],
            },
          ],
          constraintType: 'issueCount' as const,
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

      const result = formatBoardConfiguration(rawConfig, SITE_URL);

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
          { name: 'In Progress', statusIds: ['10001', '10002'], min: 1, max: 5 },
          { name: 'Done', statusIds: ['10003'], min: undefined, max: undefined },
        ],
        constraintType: 'issueCount',
        estimation: {
          type: 'field',
          fieldName: 'Story Points',
        },
        rankingFieldId: 10002,
      });
    });

    it('should handle Scrum board without WIP limits', () => {
      const rawConfig = {
        id: 2,
        name: 'Scrum Board',
        type: 'scrum' as const,
        columnConfig: {
          columns: [
            { name: 'To Do', statuses: [{ id: '1' }] },
            { name: 'In Progress', statuses: [{ id: '2' }] },
            { name: 'Done', statuses: [{ id: '3' }] },
          ],
        },
      };

      const result = formatBoardConfiguration(rawConfig, SITE_URL);

      expect(result.type).toBe('scrum');
      expect(result.columns).toHaveLength(3);
      expect(result.columns[1].min).toBeUndefined();
      expect(result.columns[1].max).toBeUndefined();
      expect(result.filter).toBeUndefined();
      expect(result.jqlFilter).toBeUndefined();
    });

    it('should strip /wiki suffix from siteUrl', () => {
      const rawConfig = {
        id: 1,
        name: 'Board',
        type: 'kanban' as const,
        columnConfig: { columns: [] },
      };

      const result = formatBoardConfiguration(rawConfig, 'https://test.atlassian.net/wiki');

      expect(result.link).toBe('https://test.atlassian.net/jira/software/c/projects?rapidView=1');
    });

    it('should throw error for invalid config', () => {
      expect(() => formatBoardConfiguration(null as unknown as never, SITE_URL)).toThrow(
        'Invalid board configuration data received'
      );
    });
  });

  // Board Issues Formatter
  describe('formatBoardIssues', () => {
    it('should format board issues without grouping', () => {
      const rawResponse = {
        startAt: 0,
        maxResults: 50,
        total: 2,
        issues: [
          {
            id: '10001',
            key: 'PROJ-1',
            fields: {
              summary: 'First Issue',
              status: { name: 'To Do' },
              issuetype: { name: 'Story' },
            },
          },
          {
            id: '10002',
            key: 'PROJ-2',
            fields: {
              summary: 'Second Issue',
              status: { name: 'In Progress' },
              issuetype: { name: 'Bug' },
            },
          },
        ],
      };

      const result = formatBoardIssues(rawResponse, SITE_URL);

      expect(result.total).toBe(2);
      expect(result.issues).toHaveLength(2);
      expect(result.groupedBy).toBeUndefined();
      expect(result.groups).toBeUndefined();
    });

    it('should group issues by status', () => {
      const rawResponse = {
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

      const result = formatBoardIssues(rawResponse, SITE_URL, 'status');

      expect(result.groupedBy).toBe('status');
      expect(result.groups).toHaveLength(2);

      const todoGroup = result.groups?.find(g => g.key === 'To Do');
      expect(todoGroup?.name).toBe('To Do');
      expect(todoGroup?.issues).toHaveLength(2);

      const inProgressGroup = result.groups?.find(g => g.key === 'In Progress');
      expect(inProgressGroup?.name).toBe('In Progress');
      expect(inProgressGroup?.issues).toHaveLength(1);
    });

    it('should group issues by assignee', () => {
      const rawResponse = {
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
              assignee: { accountId: 'user1', displayName: 'User One' },
            },
          },
          {
            id: '10002',
            key: 'PROJ-2',
            fields: {
              summary: 'Issue 2',
              status: { name: 'To Do' },
              issuetype: { name: 'Story' },
              assignee: { accountId: 'user2', displayName: 'User Two' },
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

      const result = formatBoardIssues(rawResponse, SITE_URL, 'assignee');

      expect(result.groupedBy).toBe('assignee');
      expect(result.groups).toHaveLength(3);

      const user1Group = result.groups?.find(g => g.key === 'user1');
      expect(user1Group?.name).toBe('User One');
      expect(user1Group?.issues).toHaveLength(1);

      const unassignedGroup = result.groups?.find(g => g.key === 'unassigned');
      expect(unassignedGroup?.name).toBe('Unassigned');
      expect(unassignedGroup?.issues).toHaveLength(1);
    });

    it('should not add groups when issues list is empty', () => {
      const rawResponse = {
        startAt: 0,
        maxResults: 50,
        total: 0,
        issues: [],
      };

      const result = formatBoardIssues(rawResponse, SITE_URL, 'status');

      expect(result.groupedBy).toBeUndefined();
      expect(result.groups).toBeUndefined();
    });

    it('should throw error for invalid response', () => {
      expect(() => formatBoardIssues(null as unknown as never, SITE_URL)).toThrow(
        'Invalid board issues response received'
      );
    });
  });
});
