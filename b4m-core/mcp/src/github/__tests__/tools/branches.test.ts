import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the config module
vi.mock('../../config.js', () => ({
  githubToken: 'mock-token',
}));

// Mock the client module
vi.mock('../../client.js', () => ({
  octokit: {
    repos: {
      listBranches: vi.fn(),
      getBranch: vi.fn(),
    },
    git: {
      createRef: vi.fn(),
    },
  },
}));

import { registerBranchTools } from '../../tools/branches.js';
import { octokit } from '../../client.js';
import { TOOL_LIST_BRANCHES, TOOL_CREATE_BRANCH } from '../../constants.js';
import { createMockServer, parseResponse, type RegisteredTool } from '../test-utils.js';

describe('Branch Tools', () => {
  let registeredTools: Map<string, RegisteredTool>;

  beforeEach(() => {
    vi.clearAllMocks();
    const mock = createMockServer();
    registeredTools = mock.registeredTools;
    registerBranchTools(mock.server);
  });

  describe(TOOL_LIST_BRANCHES, () => {
    it('should register the tool', () => {
      expect(registeredTools.has(TOOL_LIST_BRANCHES)).toBe(true);
    });

    it('should return branch list on success', async () => {
      const mockBranches = {
        data: [
          {
            name: 'main',
            protected: true,
            commit: {
              sha: 'abc123',
              url: 'https://api.github.com/repos/owner/repo/commits/abc123',
            },
          },
          {
            name: 'develop',
            protected: false,
            commit: {
              sha: 'def456',
              url: 'https://api.github.com/repos/owner/repo/commits/def456',
            },
          },
        ],
      };

      vi.mocked(octokit.repos.listBranches).mockResolvedValueOnce(mockBranches as never);

      const tool = registeredTools.get(TOOL_LIST_BRANCHES);
      const result = await tool!.handler({ owner: 'owner', repo: 'repo' });

      expect(result.isError).toBeUndefined();
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.total_count).toBe(2);
      expect(parsed.branches).toHaveLength(2);
      expect((parsed.branches as Array<{ name: string }>)[0].name).toBe('main');
      expect((parsed.branches as Array<{ protected: boolean }>)[0].protected).toBe(true);
      expect((parsed.branches as Array<{ name: string }>)[1].name).toBe('develop');
    });

    it('should use default pagination values', async () => {
      vi.mocked(octokit.repos.listBranches).mockResolvedValueOnce({ data: [] } as never);

      const tool = registeredTools.get(TOOL_LIST_BRANCHES);
      await tool!.handler({ owner: 'owner', repo: 'repo' });

      expect(octokit.repos.listBranches).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        per_page: 30,
        page: 1,
      });
    });

    it('should use provided pagination values', async () => {
      vi.mocked(octokit.repos.listBranches).mockResolvedValueOnce({ data: [] } as never);

      const tool = registeredTools.get(TOOL_LIST_BRANCHES);
      await tool!.handler({ owner: 'owner', repo: 'repo', per_page: 50, page: 2 });

      expect(octokit.repos.listBranches).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        per_page: 50,
        page: 2,
      });
    });

    it('should return error on API failure', async () => {
      vi.mocked(octokit.repos.listBranches).mockRejectedValueOnce(new Error('Repository not found'));

      const tool = registeredTools.get(TOOL_LIST_BRANCHES);
      // Use whitelisted repo so whitelist check passes and API error can be returned
      const result = await tool!.handler({ owner: 'owner', repo: 'repo' });

      expect(result.isError).toBe(true);
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toBe('Repository not found');
    });

    it('should handle empty branch list', async () => {
      vi.mocked(octokit.repos.listBranches).mockResolvedValueOnce({ data: [] } as never);

      const tool = registeredTools.get(TOOL_LIST_BRANCHES);
      const result = await tool!.handler({ owner: 'owner', repo: 'repo' });

      const parsed = parseResponse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.total_count).toBe(0);
      expect(parsed.branches).toEqual([]);
    });
  });

  describe(TOOL_CREATE_BRANCH, () => {
    it('should register the tool', () => {
      expect(registeredTools.has(TOOL_CREATE_BRANCH)).toBe(true);
    });

    it('should return preview when not executed from button', async () => {
      // Mock branch doesn't exist (404)
      const error = new Error('Branch not found');
      (error as { status?: number }).status = 404;
      vi.mocked(octokit.repos.getBranch).mockRejectedValueOnce(error);

      const tool = registeredTools.get(TOOL_CREATE_BRANCH);
      const result = await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        branch_name: 'feature/new-branch',
        from_branch: 'main',
      });

      expect(octokit.git.createRef).not.toHaveBeenCalled();
      const parsed = parseResponse(result);
      expect(parsed.action).toBe('preview');
    });

    it('should detect existing branch in preview mode', async () => {
      vi.mocked(octokit.repos.getBranch).mockResolvedValueOnce({
        data: { name: 'feature/existing', commit: { sha: 'abc123' } },
      } as never);

      const tool = registeredTools.get(TOOL_CREATE_BRANCH);
      const result = await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        branch_name: 'feature/existing',
        from_branch: 'main',
      });

      expect(octokit.git.createRef).not.toHaveBeenCalled();
      const parsed = parseResponse(result);
      expect(parsed.action).toBe('branch_already_exists');
    });

    it('should create branch when executed from button', async () => {
      // Mock getting source branch SHA
      vi.mocked(octokit.repos.getBranch).mockResolvedValueOnce({
        data: { name: 'main', commit: { sha: 'abc123def456' } },
      } as never);

      // Mock creating the ref
      vi.mocked(octokit.git.createRef).mockResolvedValueOnce({
        data: {
          ref: 'refs/heads/feature/new-branch',
          object: { sha: 'abc123def456' },
          url: 'https://api.github.com/repos/owner/repo/git/refs/heads/feature/new-branch',
        },
      } as never);

      const tool = registeredTools.get(TOOL_CREATE_BRANCH);
      const result = await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        branch_name: 'feature/new-branch',
        from_branch: 'main',
        _executeFromButton: true,
      });

      expect(octokit.git.createRef).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        ref: 'refs/heads/feature/new-branch',
        sha: 'abc123def456',
      });

      const parsed = parseResponse(result);
      expect(parsed.success).toBe(true);
      expect((parsed.branch as { name: string }).name).toBe('feature/new-branch');
    });

    it('should return error when source branch not found', async () => {
      const error = new Error('Branch not found');
      (error as { status?: number }).status = 404;
      vi.mocked(octokit.repos.getBranch).mockRejectedValueOnce(error);

      const tool = registeredTools.get(TOOL_CREATE_BRANCH);
      const result = await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        branch_name: 'feature/new-branch',
        from_branch: 'nonexistent',
        _executeFromButton: true,
      });

      expect(result.isError).toBe(true);
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.suggestion).toContain('nonexistent');
    });

    it('should default from_branch to main', async () => {
      vi.mocked(octokit.repos.getBranch).mockResolvedValueOnce({
        data: { name: 'main', commit: { sha: 'sha123' } },
      } as never);

      vi.mocked(octokit.git.createRef).mockResolvedValueOnce({
        data: { ref: 'refs/heads/test', object: { sha: 'sha123' }, url: 'url' },
      } as never);

      const tool = registeredTools.get(TOOL_CREATE_BRANCH);
      await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        branch_name: 'test',
        _executeFromButton: true,
      });

      expect(octokit.repos.getBranch).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        branch: 'main',
      });
    });

    it('should handle API error on branch creation', async () => {
      vi.mocked(octokit.repos.getBranch).mockResolvedValueOnce({
        data: { name: 'main', commit: { sha: 'sha123' } },
      } as never);

      vi.mocked(octokit.git.createRef).mockRejectedValueOnce(new Error('API Error'));

      const tool = registeredTools.get(TOOL_CREATE_BRANCH);
      const result = await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        branch_name: 'test',
        _executeFromButton: true,
      });

      expect(result.isError).toBe(true);
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
    });

    it('should handle rate limit error with suggestion', async () => {
      vi.mocked(octokit.repos.getBranch).mockResolvedValueOnce({
        data: { name: 'main', commit: { sha: 'sha123' } },
      } as never);

      const rateLimitError = new Error('API rate limit exceeded');
      (rateLimitError as Error & { status: number }).status = 403;
      vi.mocked(octokit.git.createRef).mockRejectedValueOnce(rateLimitError);

      const tool = registeredTools.get(TOOL_CREATE_BRANCH);
      const result = await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        branch_name: 'test',
        _executeFromButton: true,
      });

      expect(result.isError).toBe(true);
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.suggestion).toContain('rate limit');
    });
  });
});
