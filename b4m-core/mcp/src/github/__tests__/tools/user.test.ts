import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the config module (must come before client mock since client imports config)
vi.mock('../../config.js', () => ({
  githubToken: 'test-token',
}));

// Mock the client module
vi.mock('../../client.js', () => ({
  octokit: {
    users: {
      getAuthenticated: vi.fn(),
    },
  },
}));

import { registerUserTools } from '../../tools/user.js';
import { octokit } from '../../client.js';
import { TOOL_CURRENT_USER } from '../../constants.js';
import { createMockServer, parseResponse, type RegisteredTool } from '../test-utils.js';

describe('User Tools', () => {
  let registeredTools: Map<string, RegisteredTool>;

  beforeEach(() => {
    vi.clearAllMocks();
    const mock = createMockServer();
    registeredTools = mock.registeredTools;
    registerUserTools(mock.server);
  });

  describe(TOOL_CURRENT_USER, () => {
    it('should register the tool', () => {
      expect(registeredTools.has(TOOL_CURRENT_USER)).toBe(true);
    });

    it('should return user data on success', async () => {
      const mockUserData = {
        data: {
          login: 'testuser',
          id: 12345,
          name: 'Test User',
          email: 'test@example.com',
          bio: 'A test user',
          company: 'Test Corp',
          location: 'Test City',
          html_url: 'https://github.com/testuser',
          avatar_url: 'https://avatars.githubusercontent.com/u/12345',
          type: 'User',
          created_at: '2020-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
          public_repos: 10,
          public_gists: 5,
          followers: 100,
          following: 50,
        },
      };

      vi.mocked(octokit.users.getAuthenticated).mockResolvedValueOnce(mockUserData as never);

      const tool = registeredTools.get(TOOL_CURRENT_USER);
      const result = await tool!.handler({});

      expect(result.isError).toBeUndefined();
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(true);
      expect((parsed.user as { login: string }).login).toBe('testuser');
      expect((parsed.user as { id: number }).id).toBe(12345);
      expect((parsed.user as { name: string }).name).toBe('Test User');
      expect((parsed.user as { email: string }).email).toBe('test@example.com');
    });

    it('should return error on API failure', async () => {
      vi.mocked(octokit.users.getAuthenticated).mockRejectedValueOnce(new Error('Authentication failed'));

      const tool = registeredTools.get(TOOL_CURRENT_USER);
      const result = await tool!.handler({});

      expect(result.isError).toBe(true);
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toBe('Authentication failed');
    });

    it('should include all user fields in response', async () => {
      const mockUserData = {
        data: {
          login: 'user',
          id: 1,
          name: 'Name',
          email: 'email@test.com',
          bio: 'Bio',
          company: 'Company',
          location: 'Location',
          html_url: 'https://github.com/user',
          avatar_url: 'https://avatars.githubusercontent.com/u/1',
          type: 'User',
          created_at: '2020-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
          public_repos: 10,
          public_gists: 5,
          followers: 100,
          following: 50,
        },
      };

      vi.mocked(octokit.users.getAuthenticated).mockResolvedValueOnce(mockUserData as never);

      const tool = registeredTools.get(TOOL_CURRENT_USER);
      const result = await tool!.handler({});
      const parsed = parseResponse(result);

      // Verify all expected fields are present
      const expectedFields = [
        'login',
        'id',
        'name',
        'email',
        'bio',
        'company',
        'location',
        'url',
        'avatar_url',
        'type',
        'created_at',
        'updated_at',
        'public_repos',
        'public_gists',
        'followers',
        'following',
      ];

      expectedFields.forEach(field => {
        expect(parsed.user).toHaveProperty(field);
      });
    });
  });
});
