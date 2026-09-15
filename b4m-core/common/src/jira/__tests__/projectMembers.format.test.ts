import { describe, it, expect } from 'vitest';
import { formatProjectRoles, formatProjectRoleMembers } from '../format';

describe('Project Role Formatters', () => {
  describe('formatProjectRoles', () => {
    it('should extract role names and IDs from URL map', () => {
      const rolesMap = {
        Administrators: 'https://api.atlassian.com/ex/jira/xxx/rest/api/3/project/PROJ/role/10002',
        Developers: 'https://api.atlassian.com/ex/jira/xxx/rest/api/3/project/PROJ/role/10003',
        'Service Desk Team': 'https://api.atlassian.com/ex/jira/xxx/rest/api/3/project/PROJ/role/10100',
      };

      const result = formatProjectRoles(rolesMap);

      expect(result).toEqual([
        { name: 'Administrators', id: 10002 },
        { name: 'Developers', id: 10003 },
        { name: 'Service Desk Team', id: 10100 },
      ]);
    });

    it('should return empty array for null input', () => {
      expect(formatProjectRoles(null as unknown as Record<string, string>)).toEqual([]);
    });

    it('should return empty array for undefined input', () => {
      expect(formatProjectRoles(undefined as unknown as Record<string, string>)).toEqual([]);
    });

    it('should return empty array for empty object', () => {
      expect(formatProjectRoles({})).toEqual([]);
    });

    it('should return id 0 when URL does not contain a role ID', () => {
      const rolesMap = {
        'Bad Role': 'https://api.atlassian.com/ex/jira/xxx/rest/api/3/project/PROJ/norole',
      };

      const result = formatProjectRoles(rolesMap);

      expect(result).toEqual([{ name: 'Bad Role', id: 0 }]);
    });

    it('should handle single role', () => {
      const rolesMap = {
        Viewers: 'https://api.atlassian.com/ex/jira/xxx/rest/api/3/project/PROJ/role/10001',
      };

      const result = formatProjectRoles(rolesMap);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ name: 'Viewers', id: 10001 });
    });
  });

  describe('formatProjectRoleMembers', () => {
    it('should format user actors correctly', () => {
      const role = {
        self: 'https://api.atlassian.com/.../role/10003',
        name: 'Developers',
        id: 10003,
        description: 'A project role for developers',
        actors: [
          {
            id: 1001,
            displayName: 'John Doe',
            type: 'atlassian-user-role-actor',
            actorUser: { accountId: '5b10ac8d82e05b22cc7d4ef5' },
          },
          {
            id: 1002,
            displayName: 'Jane Smith',
            type: 'atlassian-user-role-actor',
            actorUser: { accountId: '5b10ac8d82e05b22cc7d4ef6' },
          },
        ],
      };

      const result = formatProjectRoleMembers(role);

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
        type: 'user',
        displayName: 'Jane Smith',
        accountId: '5b10ac8d82e05b22cc7d4ef6',
      });
    });

    it('should format group actors correctly', () => {
      const role = {
        name: 'Administrators',
        id: 10002,
        description: 'Admin role',
        actors: [
          {
            id: 2001,
            displayName: 'jira-administrators',
            type: 'atlassian-group-role-actor',
            actorGroup: { name: 'jira-administrators', displayName: 'Jira Administrators' },
          },
        ],
      };

      const result = formatProjectRoleMembers(role);

      expect(result.members).toHaveLength(1);
      expect(result.members[0]).toEqual({
        type: 'group',
        displayName: 'Jira Administrators',
        groupName: 'jira-administrators',
      });
    });

    it('should handle mixed user and group actors', () => {
      const role = {
        name: 'Team',
        id: 10004,
        description: 'Team role',
        actors: [
          {
            id: 1001,
            displayName: 'Alice',
            type: 'atlassian-user-role-actor',
            actorUser: { accountId: 'alice-123' },
          },
          {
            id: 2001,
            displayName: 'dev-team',
            type: 'atlassian-group-role-actor',
            actorGroup: { name: 'dev-team', displayName: 'Development Team' },
          },
          {
            id: 1002,
            displayName: 'Bob',
            type: 'atlassian-user-role-actor',
            actorUser: { accountId: 'bob-456' },
          },
        ],
      };

      const result = formatProjectRoleMembers(role);

      expect(result.members).toHaveLength(3);
      expect(result.members[0].type).toBe('user');
      expect(result.members[1].type).toBe('group');
      expect(result.members[2].type).toBe('user');
    });

    it('should handle role with no actors', () => {
      const role = {
        name: 'Empty Role',
        id: 10005,
        description: 'No members',
        actors: [],
      };

      const result = formatProjectRoleMembers(role);

      expect(result.name).toBe('Empty Role');
      expect(result.members).toEqual([]);
    });

    it('should handle role with missing actors field', () => {
      const role = {
        name: 'No Actors Field',
        id: 10006,
        description: 'Missing actors',
      };

      const result = formatProjectRoleMembers(role);

      expect(result.members).toEqual([]);
    });

    it('should pass through error responses unchanged', () => {
      const errorResponse = { error: 'Project not found' };
      const result = formatProjectRoleMembers(errorResponse as any);

      expect(result).toEqual(errorResponse);
    });

    it('should pass through errors field responses unchanged', () => {
      const errorsResponse = { errors: { projectKey: 'Invalid project key' } };
      const result = formatProjectRoleMembers(errorsResponse as any);

      expect(result).toEqual(errorsResponse);
    });

    it('should return null for null input', () => {
      const result = formatProjectRoleMembers(null as any);
      expect(result).toBeNull();
    });

    it('should handle missing optional fields with defaults', () => {
      const role = {
        actors: [
          {
            displayName: 'User Without AccountId',
            type: 'atlassian-user-role-actor',
            actorUser: {},
          },
        ],
      };

      const result = formatProjectRoleMembers(role);

      expect(result.name).toBe('');
      expect(result.id).toBe(0);
      expect(result.description).toBe('');
      expect(result.members[0].accountId).toBe('');
    });

    it('should use actor displayName as fallback for group displayName', () => {
      const role = {
        name: 'Role',
        id: 1,
        description: '',
        actors: [
          {
            displayName: 'Fallback Name',
            type: 'atlassian-group-role-actor',
            actorGroup: { name: 'group-key' },
          },
        ],
      };

      const result = formatProjectRoleMembers(role);

      expect(result.members[0].displayName).toBe('Fallback Name');
      expect(result.members[0].groupName).toBe('group-key');
    });
  });
});
