import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JiraApi } from '../api';
import type { JiraConfig } from '../api';

describe('JiraApi Project Member Operations', () => {
  let mockConfig: JiraConfig;
  let jiraApi: JiraApi;

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
    jiraApi = new JiraApi(mockConfig);
    global.fetch = vi.fn();
  });

  describe('getProjectRoles', () => {
    it('should call GET /project/{key}/role and return formatted roles', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
      const mockResponse = {
        Administrators: 'https://api.atlassian.com/ex/jira/test-cloud-id/rest/api/3/project/PROJ/role/10002',
        Developers: 'https://api.atlassian.com/ex/jira/test-cloud-id/rest/api/3/project/PROJ/role/10003',
        Viewers: 'https://api.atlassian.com/ex/jira/test-cloud-id/rest/api/3/project/PROJ/role/10004',
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockResponse,
      } as Response);

      const result = await jiraApi.getProjectRoles({ projectKey: 'PROJ' });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const callArgs = mockFetch.mock.calls[0];
      expect(callArgs[0]).toContain('/project/PROJ/role');
      expect(callArgs[1]?.method).toBe('GET');

      expect(result).toHaveLength(3);
      expect(result).toEqual([
        { name: 'Administrators', id: 10002 },
        { name: 'Developers', id: 10003 },
        { name: 'Viewers', id: 10004 },
      ]);
    });

    it('should handle empty roles response', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({}),
      } as Response);

      const result = await jiraApi.getProjectRoles({ projectKey: 'PROJ' });

      expect(result).toEqual([]);
    });

    it('should throw error for non-existent project', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        text: async () => 'Project does not exist or you do not have permission',
        headers: new Headers({ 'content-type': 'application/json' }),
      } as Response);

      await expect(jiraApi.getProjectRoles({ projectKey: 'NOPE' })).rejects.toThrow('Jira API error (404)');
    });
  });

  describe('getProjectRoleMembers', () => {
    it('should call GET /project/{key}/role/{id} and return formatted members', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
      const mockResponse = {
        self: 'https://api.atlassian.com/.../role/10003',
        name: 'Developers',
        id: 10003,
        description: 'A project role for developers',
        actors: [
          {
            id: 1001,
            displayName: 'John Doe',
            type: 'atlassian-user-role-actor',
            name: 'john.doe',
            actorUser: { accountId: '5b10ac8d82e05b22cc7d4ef5' },
          },
          {
            id: 2001,
            displayName: 'jira-developers',
            type: 'atlassian-group-role-actor',
            name: 'jira-developers',
            actorGroup: { name: 'jira-developers', displayName: 'Jira Developers' },
          },
        ],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockResponse,
      } as Response);

      const result = await jiraApi.getProjectRoleMembers({ projectKey: 'PROJ', roleId: 10003 });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const callArgs = mockFetch.mock.calls[0];
      expect(callArgs[0]).toContain('/project/PROJ/role/10003');
      expect(callArgs[1]?.method).toBe('GET');

      expect(result.name).toBe('Developers');
      expect(result.id).toBe(10003);
      expect(result.description).toBe('A project role for developers');
      expect(result.members).toHaveLength(2);
      expect(result.members[0]).toEqual({
        type: 'user',
        displayName: 'John Doe',
        accountId: '5b10ac8d82e05b22cc7d4ef5',
      });
      expect(result.members[1]).toEqual({
        type: 'group',
        displayName: 'Jira Developers',
        groupName: 'jira-developers',
      });
    });

    it('should return empty members for role with no actors', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          self: 'https://api.atlassian.com/.../role/10005',
          name: 'Empty Role',
          id: 10005,
          description: 'No members yet',
          actors: [],
        }),
      } as Response);

      const result = await jiraApi.getProjectRoleMembers({ projectKey: 'PROJ', roleId: 10005 });

      expect(result.name).toBe('Empty Role');
      expect(result.members).toEqual([]);
    });
  });

  describe('getAllProjectMembers', () => {
    it('should fetch all roles then all members and deduplicate', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;

      // First call: getProjectRoles -> GET /project/PROJ/role
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          Administrators: 'https://api.atlassian.com/.../project/PROJ/role/10002',
          Developers: 'https://api.atlassian.com/.../project/PROJ/role/10003',
        }),
      } as Response);

      // Second call: getProjectRoleMembers for Administrators
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          self: 'https://api.atlassian.com/.../role/10002',
          name: 'Administrators',
          id: 10002,
          description: 'Admin role',
          actors: [
            {
              id: 1001,
              displayName: 'Alice Admin',
              type: 'atlassian-user-role-actor',
              actorUser: { accountId: 'alice-123' },
            },
          ],
        }),
      } as Response);

      // Third call: getProjectRoleMembers for Developers
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          self: 'https://api.atlassian.com/.../role/10003',
          name: 'Developers',
          id: 10003,
          description: 'Developer role',
          actors: [
            {
              id: 1001,
              displayName: 'Alice Admin',
              type: 'atlassian-user-role-actor',
              actorUser: { accountId: 'alice-123' },
            },
            {
              id: 1002,
              displayName: 'Bob Dev',
              type: 'atlassian-user-role-actor',
              actorUser: { accountId: 'bob-456' },
            },
          ],
        }),
      } as Response);

      const result = await jiraApi.getAllProjectMembers({ projectKey: 'PROJ' });

      // 3 fetch calls: 1 for roles + 2 for role members
      expect(mockFetch).toHaveBeenCalledTimes(3);

      expect(result.projectKey).toBe('PROJ');

      // Should have 2 roles
      expect(result.roles).toHaveLength(2);
      expect(result.roles[0].name).toBe('Administrators');
      expect(result.roles[0].members).toHaveLength(1);
      expect(result.roles[1].name).toBe('Developers');
      expect(result.roles[1].members).toHaveLength(2);

      // Deduplicated: Alice appears in both roles, should only appear once in allMembers
      expect(result.allMembers).toHaveLength(2);

      const alice = result.allMembers.find(m => m.accountId === 'alice-123');
      expect(alice).toBeDefined();
      expect(alice!.displayName).toBe('Alice Admin');
      expect(alice!.roles).toEqual(['Administrators', 'Developers']);

      const bob = result.allMembers.find(m => m.accountId === 'bob-456');
      expect(bob).toBeDefined();
      expect(bob!.displayName).toBe('Bob Dev');
      expect(bob!.roles).toEqual(['Developers']);
    });

    it('should handle project with no roles', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({}),
      } as Response);

      const result = await jiraApi.getAllProjectMembers({ projectKey: 'EMPTY' });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(result.projectKey).toBe('EMPTY');
      expect(result.roles).toEqual([]);
      expect(result.allMembers).toEqual([]);
    });

    it('should deduplicate groups across roles', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;

      // Roles
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          Admins: 'https://api.atlassian.com/.../project/PROJ/role/10002',
          Devs: 'https://api.atlassian.com/.../project/PROJ/role/10003',
        }),
      } as Response);

      // Admins role
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          name: 'Admins',
          id: 10002,
          description: '',
          actors: [
            {
              id: 2001,
              displayName: 'team-leads',
              type: 'atlassian-group-role-actor',
              actorGroup: { name: 'team-leads', displayName: 'Team Leads' },
            },
          ],
        }),
      } as Response);

      // Devs role (same group)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          name: 'Devs',
          id: 10003,
          description: '',
          actors: [
            {
              id: 2001,
              displayName: 'team-leads',
              type: 'atlassian-group-role-actor',
              actorGroup: { name: 'team-leads', displayName: 'Team Leads' },
            },
          ],
        }),
      } as Response);

      const result = await jiraApi.getAllProjectMembers({ projectKey: 'PROJ' });

      // Group should appear in both roles but be deduplicated in allMembers
      expect(result.allMembers).toHaveLength(1);
      expect(result.allMembers[0].groupName).toBe('team-leads');
      expect(result.allMembers[0].roles).toEqual(['Admins', 'Devs']);
    });
  });
});
