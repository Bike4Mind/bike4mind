import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the config module
vi.mock('../../config.js', () => ({
  githubToken: 'mock-token',
}));

// Mock the client module
vi.mock('../../client.js', () => ({
  octokit: {
    repos: {
      listCommits: vi.fn(),
      getCommit: vi.fn(),
    },
  },
}));

import { registerCommitTools } from '../../tools/commits.js';
import { octokit } from '../../client.js';
import { TOOL_LIST_COMMITS, TOOL_GET_COMMIT } from '../../constants.js';
import { createMockServer, parseResponse, type RegisteredTool } from '../test-utils.js';

describe('Commit Tools', () => {
  let registeredTools: Map<string, RegisteredTool>;

  beforeEach(() => {
    vi.clearAllMocks();
    const mock = createMockServer();
    registeredTools = mock.registeredTools;
    registerCommitTools(mock.server);
  });

  describe(TOOL_LIST_COMMITS, () => {
    it('should register the tool', () => {
      expect(registeredTools.has(TOOL_LIST_COMMITS)).toBe(true);
    });

    it('should return commit list on success', async () => {
      const mockCommits = {
        data: [
          {
            sha: 'abc123',
            commit: {
              message: 'Fix bug',
              author: {
                name: 'Test Author',
                email: 'author@test.com',
                date: '2024-01-01T00:00:00Z',
              },
            },
            author: { login: 'testauthor' },
            html_url: 'https://github.com/owner/repo/commit/abc123',
            stats: { additions: 10, deletions: 5 },
          },
        ],
      };

      vi.mocked(octokit.repos.listCommits).mockResolvedValueOnce(mockCommits as never);

      const tool = registeredTools.get(TOOL_LIST_COMMITS);
      const result = await tool!.handler({ owner: 'owner', repo: 'repo' });

      expect(result.isError).toBeUndefined();
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.total_count).toBe(1);
      expect((parsed.commits as Array<{ sha: string }>)[0].sha).toBe('abc123');
      expect((parsed.commits as Array<{ message: string }>)[0].message).toBe('Fix bug');
      expect((parsed.commits as Array<{ author: { username: string } }>)[0].author.username).toBe('testauthor');
    });

    it('should pass all filter parameters', async () => {
      vi.mocked(octokit.repos.listCommits).mockResolvedValueOnce({ data: [] } as never);

      const tool = registeredTools.get(TOOL_LIST_COMMITS);
      await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        sha: 'main',
        path: 'src/index.ts',
        author: 'testuser',
        per_page: 50,
        page: 2,
      });

      expect(octokit.repos.listCommits).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        sha: 'main',
        path: 'src/index.ts',
        author: 'testuser',
        per_page: 50,
        page: 2,
      });
    });

    it('should return error on API failure', async () => {
      vi.mocked(octokit.repos.listCommits).mockRejectedValueOnce(new Error('Repository not found'));

      const tool = registeredTools.get(TOOL_LIST_COMMITS);
      const result = await tool!.handler({ owner: 'owner', repo: 'repo' });

      expect(result.isError).toBe(true);
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
    });
  });

  describe(TOOL_GET_COMMIT, () => {
    it('should register the tool', () => {
      expect(registeredTools.has(TOOL_GET_COMMIT)).toBe(true);
    });

    it('should return commit details on success', async () => {
      const mockCommit = {
        data: {
          sha: 'abc123def456',
          commit: {
            message: 'Add new feature\n\nDetailed description',
            author: {
              name: 'Author Name',
              email: 'author@example.com',
              date: '2024-01-15T10:30:00Z',
            },
            committer: {
              name: 'Committer Name',
              email: 'committer@example.com',
              date: '2024-01-15T10:35:00Z',
            },
          },
          author: { login: 'authoruser' },
          html_url: 'https://github.com/owner/repo/commit/abc123def456',
          stats: {
            additions: 100,
            deletions: 50,
            total: 150,
          },
          files: [
            {
              filename: 'src/feature.ts',
              status: 'added',
              additions: 80,
              deletions: 0,
              changes: 80,
              patch: '@@ -0,0 +1,80 @@\n+// new file content',
            },
            {
              filename: 'src/old.ts',
              status: 'modified',
              additions: 20,
              deletions: 50,
              changes: 70,
              patch: '@@ -1,50 +1,20 @@\n-old\n+new',
            },
          ],
        },
      };

      vi.mocked(octokit.repos.getCommit).mockResolvedValueOnce(mockCommit as never);

      const tool = registeredTools.get(TOOL_GET_COMMIT);
      const result = await tool!.handler({ owner: 'owner', repo: 'repo', ref: 'abc123def456' });

      expect(result.isError).toBeUndefined();
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(true);
      expect((parsed.commit as { sha: string }).sha).toBe('abc123def456');
      expect((parsed.commit as { message: string }).message).toContain('Add new feature');
      expect((parsed.commit as { stats: { additions: number } }).stats.additions).toBe(100);
      expect((parsed.commit as { files: Array<unknown> }).files).toHaveLength(2);
      expect((parsed.commit as { files: Array<{ filename: string }> }).files[0].filename).toBe('src/feature.ts');
    });

    it('should handle commit without author login', async () => {
      const mockCommit = {
        data: {
          sha: 'abc123',
          commit: {
            message: 'Bot commit',
            author: {
              name: 'Bot',
              email: 'bot@example.com',
              date: '2024-01-01T00:00:00Z',
            },
            committer: null,
          },
          author: null,
          html_url: 'https://github.com/owner/repo/commit/abc123',
          stats: null,
          files: [],
        },
      };

      vi.mocked(octokit.repos.getCommit).mockResolvedValueOnce(mockCommit as never);

      const tool = registeredTools.get(TOOL_GET_COMMIT);
      const result = await tool!.handler({ owner: 'owner', repo: 'repo', ref: 'abc123' });

      const parsed = parseResponse(result);
      expect(parsed.success).toBe(true);
      expect((parsed.commit as { author: { username?: string } }).author.username).toBeUndefined();
    });

    it('should return error for non-existent commit', async () => {
      const error = new Error('Not Found');
      (error as { status?: number }).status = 404;
      vi.mocked(octokit.repos.getCommit).mockRejectedValueOnce(error);

      const tool = registeredTools.get(TOOL_GET_COMMIT);
      const result = await tool!.handler({ owner: 'owner', repo: 'repo', ref: 'invalid' });

      expect(result.isError).toBe(true);
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.status).toBe(404);
    });
  });
});
