import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the config module
vi.mock('../../config.js', () => ({
  githubToken: 'mock-token',
}));

// Mock the client module
vi.mock('../../client.js', () => ({
  octokit: {
    repos: {
      listForAuthenticatedUser: vi.fn(),
      get: vi.fn(),
    },
  },
}));

import { registerRepoTools } from '../../tools/repos.js';
import { octokit } from '../../client.js';
import { TOOL_LIST_REPOSITORIES, TOOL_GET_REPOSITORY } from '../../constants.js';
import { createMockServer, parseResponse, type RegisteredTool } from '../test-utils.js';

describe('Repository Tools', () => {
  let registeredTools: Map<string, RegisteredTool>;

  beforeEach(() => {
    vi.clearAllMocks();
    const mock = createMockServer();
    registeredTools = mock.registeredTools;
    registerRepoTools(mock.server);
  });

  describe(TOOL_LIST_REPOSITORIES, () => {
    it('should register the tool', () => {
      expect(registeredTools.has(TOOL_LIST_REPOSITORIES)).toBe(true);
    });

    it('should return repository list on success', async () => {
      const mockRepos = {
        data: [
          {
            full_name: 'owner/repo1',
            owner: { login: 'owner' },
            name: 'repo1',
            private: false,
            description: 'A test repository',
            html_url: 'https://github.com/owner/repo1',
            default_branch: 'main',
            language: 'TypeScript',
            created_at: '2020-01-01T00:00:00Z',
            updated_at: '2024-01-01T00:00:00Z',
            pushed_at: '2024-06-01T00:00:00Z',
            stargazers_count: 100,
            forks_count: 25,
            open_issues_count: 5,
          },
        ],
      };

      vi.mocked(octokit.repos.listForAuthenticatedUser).mockResolvedValueOnce(mockRepos as never);

      const tool = registeredTools.get(TOOL_LIST_REPOSITORIES);
      const result = await tool!.handler({});

      expect(result.isError).toBeUndefined();
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.total_count).toBe(1);
      expect((parsed.repositories as Array<{ full_name: string }>)[0].full_name).toBe('owner/repo1');
      expect((parsed.repositories as Array<{ stars: number }>)[0].stars).toBe(100);
    });

    it('should pass filter parameters to API', async () => {
      vi.mocked(octokit.repos.listForAuthenticatedUser).mockResolvedValueOnce({ data: [] } as never);

      const tool = registeredTools.get(TOOL_LIST_REPOSITORIES);
      await tool!.handler({
        visibility: 'private',
        affiliation: 'owner',
        sort: 'created',
        per_page: 50,
        page: 2,
      });

      expect(octokit.repos.listForAuthenticatedUser).toHaveBeenCalledWith({
        visibility: 'private',
        affiliation: 'owner',
        sort: 'created',
        per_page: 50,
        page: 2,
      });
    });

    it('should return error on API failure', async () => {
      vi.mocked(octokit.repos.listForAuthenticatedUser).mockRejectedValueOnce(new Error('Unauthorized'));

      const tool = registeredTools.get(TOOL_LIST_REPOSITORIES);
      const result = await tool!.handler({});

      expect(result.isError).toBe(true);
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toBe('Unauthorized');
    });
  });

  describe(TOOL_GET_REPOSITORY, () => {
    it('should register the tool', () => {
      expect(registeredTools.has(TOOL_GET_REPOSITORY)).toBe(true);
    });

    it('should return repository details on success', async () => {
      const mockRepo = {
        data: {
          full_name: 'owner/repo',
          owner: { login: 'owner' },
          name: 'repo',
          private: false,
          description: 'A great repository',
          html_url: 'https://github.com/owner/repo',
          default_branch: 'main',
          language: 'JavaScript',
          topics: ['web', 'nodejs'],
          created_at: '2020-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
          pushed_at: '2024-06-01T00:00:00Z',
          stargazers_count: 500,
          forks_count: 100,
          watchers_count: 50,
          open_issues_count: 10,
          has_issues: true,
          has_projects: true,
          has_wiki: false,
          license: { name: 'MIT License' },
        },
      };

      vi.mocked(octokit.repos.get).mockResolvedValueOnce(mockRepo as never);

      const tool = registeredTools.get(TOOL_GET_REPOSITORY);
      const result = await tool!.handler({ owner: 'owner', repo: 'repo' });

      expect(result.isError).toBeUndefined();
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(true);
      expect((parsed.repository as { full_name: string }).full_name).toBe('owner/repo');
      expect((parsed.repository as { stars: number }).stars).toBe(500);
      expect((parsed.repository as { topics: string[] }).topics).toEqual(['web', 'nodejs']);
      expect((parsed.repository as { license: string }).license).toBe('MIT License');
    });

    it('should handle repository without license', async () => {
      const mockRepo = {
        data: {
          full_name: 'owner/repo',
          owner: { login: 'owner' },
          name: 'repo',
          private: true,
          description: null,
          html_url: 'https://github.com/owner/repo',
          default_branch: 'main',
          language: null,
          topics: [],
          created_at: '2020-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
          pushed_at: null,
          stargazers_count: 0,
          forks_count: 0,
          watchers_count: 0,
          open_issues_count: 0,
          has_issues: true,
          has_projects: false,
          has_wiki: false,
          license: null,
        },
      };

      vi.mocked(octokit.repos.get).mockResolvedValueOnce(mockRepo as never);

      const tool = registeredTools.get(TOOL_GET_REPOSITORY);
      const result = await tool!.handler({ owner: 'owner', repo: 'repo' });

      const parsed = parseResponse(result);
      expect((parsed.repository as { license?: string }).license).toBeUndefined();
    });

    it('should return error for non-existent repository', async () => {
      const error = new Error('Not Found');
      (error as { status?: number }).status = 404;
      vi.mocked(octokit.repos.get).mockRejectedValueOnce(error);

      const tool = registeredTools.get(TOOL_GET_REPOSITORY);
      // Use whitelisted repo so whitelist check passes and API error can be returned
      const result = await tool!.handler({ owner: 'owner', repo: 'repo' });

      expect(result.isError).toBe(true);
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.status).toBe(404);
    });
  });
});
