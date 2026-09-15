import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../config.js', () => ({
  githubToken: 'mock-token',
}));

vi.mock('../../client.js', () => ({
  octokit: {
    pulls: {
      list: vi.fn(),
      get: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      merge: vi.fn(),
      listFiles: vi.fn(),
    },
    search: {},
    graphql: vi.fn(),
    request: vi.fn(),
  },
}));

import { registerPullTools } from '../../tools/pulls.js';
import { octokit } from '../../client.js';
import {
  TOOL_LIST_PULL_REQUESTS,
  TOOL_GET_PULL_REQUEST,
  TOOL_GET_PULL_REQUEST_FILES,
  TOOL_GET_PULL_REQUEST_DIFF,
  TOOL_CREATE_PULL_REQUEST,
  TOOL_UPDATE_PULL_REQUEST,
  TOOL_MERGE_PULL_REQUEST,
} from '../../constants.js';
import { createMockServer, parseResponse, type RegisteredTool } from '../test-utils.js';

describe('Pull Request Tools', () => {
  let registeredTools: Map<string, RegisteredTool>;

  beforeEach(() => {
    vi.resetAllMocks();
    const mock = createMockServer();
    registeredTools = mock.registeredTools;
    registerPullTools(mock.server);
  });

  describe(TOOL_LIST_PULL_REQUESTS, () => {
    it('should register the tool', () => {
      expect(registeredTools.has(TOOL_LIST_PULL_REQUESTS)).toBe(true);
    });

    it('should return PR list on success', async () => {
      const mockPRs = {
        data: [
          {
            number: 123,
            title: 'Add new feature',
            state: 'open',
            draft: false,
            html_url: 'https://github.com/owner/repo/pull/123',
            user: { login: 'contributor' },
            labels: [{ name: 'enhancement' }],
            head: { ref: 'feature-branch' },
            base: { ref: 'main' },
            created_at: '2024-01-01T00:00:00Z',
            updated_at: '2024-01-15T00:00:00Z',
            mergeable: true,
            merged: false,
          },
        ],
      };

      vi.mocked(octokit.pulls.list).mockResolvedValueOnce(mockPRs as never);

      const tool = registeredTools.get(TOOL_LIST_PULL_REQUESTS);
      const result = await tool!.handler({ owner: 'owner', repo: 'repo' });

      expect(result.isError).toBeUndefined();
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.pull_requests).toHaveLength(1);
      expect((parsed.pull_requests as Array<{ number: number }>)[0].number).toBe(123);
      expect((parsed.pull_requests as Array<{ head: string }>)[0].head).toBe('feature-branch');
    });

    it('should use search API when labels are provided', async () => {
      const mockSearchResults = {
        data: {
          total_count: 1,
          items: [
            {
              number: 456,
              title: 'Bug fix',
              state: 'open',
              draft: false,
              html_url: 'https://github.com/owner/repo/pull/456',
              user: { login: 'fixer' },
              labels: [{ name: 'bug' }],
              created_at: '2024-01-01T00:00:00Z',
              updated_at: '2024-01-10T00:00:00Z',
            },
          ],
        },
      };

      vi.mocked(octokit.request).mockResolvedValueOnce(mockSearchResults as never);

      const tool = registeredTools.get(TOOL_LIST_PULL_REQUESTS);
      const result = await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        labels: ['bug'],
      });

      expect(octokit.request).toHaveBeenCalledWith('GET /search/issues', expect.any(Object));
      expect(octokit.pulls.list).not.toHaveBeenCalled();

      const parsed = parseResponse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.total_count).toBe(1);
    });

    it('should handle state filter with search API', async () => {
      vi.mocked(octokit.request).mockResolvedValueOnce({
        data: { total_count: 0, items: [] },
      } as never);

      const tool = registeredTools.get(TOOL_LIST_PULL_REQUESTS);
      await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        labels: ['awaiting review'],
        state: 'closed',
      });

      const call = vi.mocked(octokit.request).mock.calls[0];
      expect(call[0]).toBe('GET /search/issues');
      expect((call[1] as { q: string }).q).toContain('is:closed');
      expect((call[1] as { q: string }).q).toContain('label:"awaiting review"');
    });

    it('should return error on API failure', async () => {
      vi.mocked(octokit.pulls.list).mockRejectedValueOnce(new Error('Not found'));

      const tool = registeredTools.get(TOOL_LIST_PULL_REQUESTS);
      const result = await tool!.handler({ owner: 'owner', repo: 'repo' });

      expect(result.isError).toBe(true);
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
    });
  });

  describe(TOOL_GET_PULL_REQUEST, () => {
    it('should register the tool', () => {
      expect(registeredTools.has(TOOL_GET_PULL_REQUEST)).toBe(true);
    });

    it('should return PR details on success', async () => {
      const mockPR = {
        data: {
          number: 789,
          title: 'Major refactor',
          body: 'This PR refactors the codebase.',
          state: 'open',
          draft: true,
          html_url: 'https://github.com/owner/repo/pull/789',
          user: { login: 'developer' },
          head: {
            ref: 'refactor-branch',
            sha: 'abc123',
          },
          base: {
            ref: 'main',
            sha: 'def456',
          },
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-20T00:00:00Z',
          merged: false,
          mergeable: true,
          mergeable_state: 'clean',
          additions: 500,
          deletions: 200,
          changed_files: 25,
          comments: 10,
          review_comments: 5,
          commits: 15,
        },
      };

      vi.mocked(octokit.pulls.get).mockResolvedValueOnce(mockPR as never);

      const tool = registeredTools.get(TOOL_GET_PULL_REQUEST);
      const result = await tool!.handler({ owner: 'owner', repo: 'repo', pull_number: 789 });

      expect(result.isError).toBeUndefined();
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(true);
      expect((parsed.pull_request as { number: number }).number).toBe(789);
      expect((parsed.pull_request as { draft: boolean }).draft).toBe(true);
      expect((parsed.pull_request as { additions: number }).additions).toBe(500);
      expect((parsed.pull_request as { mergeable_state: string }).mergeable_state).toBe('clean');
    });

    it('should return error for non-existent PR', async () => {
      const error = new Error('Not Found');
      (error as { status?: number }).status = 404;
      vi.mocked(octokit.pulls.get).mockRejectedValueOnce(error);

      const tool = registeredTools.get(TOOL_GET_PULL_REQUEST);
      const result = await tool!.handler({ owner: 'owner', repo: 'repo', pull_number: 99999 });

      expect(result.isError).toBe(true);
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.status).toBe(404);
    });
  });

  describe(TOOL_CREATE_PULL_REQUEST, () => {
    it('should register the tool', () => {
      expect(registeredTools.has(TOOL_CREATE_PULL_REQUEST)).toBe(true);
    });

    it('should return preview when not executed from button', async () => {
      // Mock empty list for existing PR check
      vi.mocked(octokit.pulls.list).mockResolvedValueOnce({ data: [] } as never);

      const tool = registeredTools.get(TOOL_CREATE_PULL_REQUEST);
      const result = await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        title: 'Add new feature',
        head: 'feature-branch',
        base: 'main',
        _executeFromButton: false,
      });

      expect(octokit.pulls.create).not.toHaveBeenCalled();
      const parsed = parseResponse(result);
      expect(parsed.action).toBe('preview');
    });

    it('should detect existing PR in preview mode', async () => {
      const existingPR = {
        data: [
          {
            number: 123,
            title: 'Existing PR',
            html_url: 'https://github.com/owner/repo/pull/123',
            state: 'open',
          },
        ],
      };
      vi.mocked(octokit.pulls.list).mockResolvedValueOnce(existingPR as never);

      const tool = registeredTools.get(TOOL_CREATE_PULL_REQUEST);
      const result = await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        title: 'Add new feature',
        head: 'feature-branch',
        base: 'main',
        _executeFromButton: false,
      });

      expect(octokit.pulls.create).not.toHaveBeenCalled();
      const parsed = parseResponse(result);
      expect(parsed.action).toBe('existing_pr_found');
      expect((parsed.pull_request as { number: number }).number).toBe(123);
    });

    it('should create PR when executed from button', async () => {
      const mockResult = {
        data: {
          number: 456,
          title: 'Add new feature',
          html_url: 'https://github.com/owner/repo/pull/456',
          state: 'open',
          draft: true,
          head: { ref: 'feature-branch' },
          base: { ref: 'main' },
          created_at: '2024-01-01T00:00:00Z',
          user: { login: 'developer' },
        },
      };

      vi.mocked(octokit.pulls.create).mockResolvedValueOnce(mockResult as never);

      const tool = registeredTools.get(TOOL_CREATE_PULL_REQUEST);
      const result = await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        title: 'Add new feature',
        body: 'PR description',
        head: 'feature-branch',
        base: 'main',
        draft: true,
        _executeFromButton: true,
      });

      expect(octokit.pulls.create).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        title: 'Add new feature',
        body: 'PR description',
        head: 'feature-branch',
        base: 'main',
        draft: true,
        maintainer_can_modify: true,
      });

      const parsed = parseResponse(result);
      expect(parsed.success).toBe(true);
      expect((parsed.pull_request as { number: number }).number).toBe(456);
      expect((parsed.pull_request as { draft: boolean }).draft).toBe(true);
    });

    it('should return error on API failure', async () => {
      vi.mocked(octokit.pulls.create).mockRejectedValueOnce(new Error('API Error'));

      const tool = registeredTools.get(TOOL_CREATE_PULL_REQUEST);
      const result = await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        title: 'Test',
        head: 'branch',
        base: 'main',
        _executeFromButton: true,
      });

      expect(result.isError).toBe(true);
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
    });

    it('should handle duplicate PR error with suggestion', async () => {
      const error = new Error('A pull request already exists for owner:branch');
      (error as { status?: number }).status = 422;
      vi.mocked(octokit.pulls.create).mockRejectedValueOnce(error);

      const tool = registeredTools.get(TOOL_CREATE_PULL_REQUEST);
      const result = await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        title: 'Test',
        head: 'branch',
        base: 'main',
        _executeFromButton: true,
      });

      expect(result.isError).toBe(true);
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.suggestion).toContain('list_pull_requests');
    });

    it('should handle no commits between branches error', async () => {
      const error = new Error('No commits between main and branch');
      (error as { status?: number }).status = 422;
      vi.mocked(octokit.pulls.create).mockRejectedValueOnce(error);

      const tool = registeredTools.get(TOOL_CREATE_PULL_REQUEST);
      const result = await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        title: 'Test',
        head: 'branch',
        base: 'main',
        _executeFromButton: true,
      });

      expect(result.isError).toBe(true);
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.suggestion).toContain('commits');
    });

    it('should default draft to true', async () => {
      const mockResult = {
        data: {
          number: 789,
          title: 'Test',
          html_url: 'https://github.com/owner/repo/pull/789',
          state: 'open',
          draft: true,
          head: { ref: 'branch' },
          base: { ref: 'main' },
          created_at: '2024-01-01T00:00:00Z',
          user: { login: 'developer' },
        },
      };

      vi.mocked(octokit.pulls.create).mockResolvedValueOnce(mockResult as never);

      const tool = registeredTools.get(TOOL_CREATE_PULL_REQUEST);
      await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        title: 'Test',
        head: 'branch',
        _executeFromButton: true,
      });

      expect(octokit.pulls.create).toHaveBeenCalledWith(
        expect.objectContaining({
          draft: true,
        })
      );
    });

    it('should default base to main when not provided', async () => {
      const mockResult = {
        data: {
          number: 789,
          title: 'Test',
          html_url: 'https://github.com/owner/repo/pull/789',
          state: 'open',
          draft: true,
          head: { ref: 'branch' },
          base: { ref: 'main' },
          created_at: '2024-01-01T00:00:00Z',
          user: { login: 'developer' },
        },
      };

      vi.mocked(octokit.pulls.create).mockResolvedValueOnce(mockResult as never);

      const tool = registeredTools.get(TOOL_CREATE_PULL_REQUEST);
      await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        title: 'Test',
        head: 'branch',
        _executeFromButton: true,
      });

      expect(octokit.pulls.create).toHaveBeenCalledWith(
        expect.objectContaining({
          base: 'main',
        })
      );
    });

    it('should handle rate limit error with suggestion', async () => {
      const error = new Error('API rate limit exceeded');
      (error as { status?: number }).status = 403;
      vi.mocked(octokit.pulls.create).mockRejectedValueOnce(error);

      const tool = registeredTools.get(TOOL_CREATE_PULL_REQUEST);
      const result = await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        title: 'Test',
        head: 'branch',
        base: 'main',
        _executeFromButton: true,
      });

      expect(result.isError).toBe(true);
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.suggestion).toContain('rate limit');
    });

    it('should support cross-repo PR format with username:branch', async () => {
      vi.mocked(octokit.pulls.list).mockResolvedValueOnce({ data: [] } as never);

      const tool = registeredTools.get(TOOL_CREATE_PULL_REQUEST);
      await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        title: 'Cross-repo PR',
        head: 'contributor:feature-branch',
        base: 'main',
      });

      // The head should be passed as-is since it already includes the username
      expect(octokit.pulls.list).toHaveBeenCalledWith(
        expect.objectContaining({
          head: 'contributor:feature-branch',
        })
      );
    });
  });

  describe(TOOL_UPDATE_PULL_REQUEST, () => {
    const mockPR = {
      data: {
        number: 123,
        title: 'Original Title',
        body: 'Original body',
        state: 'open',
        draft: true,
        html_url: 'https://github.com/owner/repo/pull/123',
        user: { login: 'developer' },
        head: { ref: 'feature-branch', sha: 'abc123' },
        base: { ref: 'main', sha: 'def456' },
        merged: false,
        node_id: 'PR_node123',
        updated_at: '2024-01-15T00:00:00Z',
        maintainer_can_modify: true,
      },
    };

    it('should register the tool', () => {
      expect(registeredTools.has(TOOL_UPDATE_PULL_REQUEST)).toBe(true);
    });

    it('should return preview when not executed from button', async () => {
      vi.mocked(octokit.pulls.get).mockResolvedValueOnce(mockPR as never);

      const tool = registeredTools.get(TOOL_UPDATE_PULL_REQUEST);
      const result = await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        pull_number: 123,
        title: 'New Title',
      });

      expect(octokit.pulls.update).not.toHaveBeenCalled();
      const parsed = parseResponse(result);
      expect(parsed.action).toBe('preview');
      expect(parsed.pull_request_update.changes.title).toBeDefined();
    });

    it('should update PR title when executed from button', async () => {
      vi.mocked(octokit.pulls.get).mockResolvedValueOnce(mockPR as never);
      const updatedMockPR = {
        data: {
          ...mockPR.data,
          title: 'New Title',
        },
      };
      vi.mocked(octokit.pulls.update).mockResolvedValueOnce(updatedMockPR as never);

      const tool = registeredTools.get(TOOL_UPDATE_PULL_REQUEST);
      const result = await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        pull_number: 123,
        title: 'New Title',
        _executeFromButton: true,
      });

      expect(octokit.pulls.update).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        pull_number: 123,
        title: 'New Title',
      });

      const parsed = parseResponse(result);
      expect(parsed.success).toBe(true);
      expect((parsed.pull_request as { title: string }).title).toBe('New Title');
    });

    it('should update multiple fields at once', async () => {
      vi.mocked(octokit.pulls.get).mockResolvedValueOnce(mockPR as never);
      const updatedMockPR = {
        data: {
          ...mockPR.data,
          title: 'New Title',
          body: 'New body',
          state: 'closed',
        },
      };
      vi.mocked(octokit.pulls.update).mockResolvedValueOnce(updatedMockPR as never);

      const tool = registeredTools.get(TOOL_UPDATE_PULL_REQUEST);
      await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        pull_number: 123,
        title: 'New Title',
        body: 'New body',
        state: 'closed',
        _executeFromButton: true,
      });

      expect(octokit.pulls.update).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        pull_number: 123,
        title: 'New Title',
        body: 'New body',
        state: 'closed',
      });
    });

    it('should mark PR ready for review via GraphQL', async () => {
      vi.mocked(octokit.pulls.get).mockResolvedValueOnce(mockPR as never);
      vi.mocked(octokit.graphql).mockResolvedValueOnce({
        markPullRequestReadyForReview: {
          pullRequest: { id: 'PR_node123', isDraft: false, number: 123, title: 'Original Title' },
        },
      } as never);

      const tool = registeredTools.get(TOOL_UPDATE_PULL_REQUEST);
      const result = await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        pull_number: 123,
        draft: false,
        _executeFromButton: true,
      });

      expect(octokit.graphql).toHaveBeenCalledWith(expect.stringContaining('markPullRequestReadyForReview'), {
        pullRequestId: 'PR_node123',
      });

      const parsed = parseResponse(result);
      expect(parsed.success).toBe(true);
      expect((parsed.pull_request as { draft: boolean }).draft).toBe(false);
    });

    it('should convert PR to draft via GraphQL', async () => {
      const nonDraftPR = {
        data: {
          ...mockPR.data,
          draft: false,
        },
      };
      vi.mocked(octokit.pulls.get).mockResolvedValueOnce(nonDraftPR as never);
      vi.mocked(octokit.graphql).mockResolvedValueOnce({
        convertPullRequestToDraft: {
          pullRequest: { id: 'PR_node123', isDraft: true, number: 123, title: 'Original Title' },
        },
      } as never);

      const tool = registeredTools.get(TOOL_UPDATE_PULL_REQUEST);
      const result = await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        pull_number: 123,
        draft: true,
        _executeFromButton: true,
      });

      expect(octokit.graphql).toHaveBeenCalledWith(expect.stringContaining('convertPullRequestToDraft'), {
        pullRequestId: 'PR_node123',
      });

      const parsed = parseResponse(result);
      expect(parsed.success).toBe(true);
      expect((parsed.pull_request as { draft: boolean }).draft).toBe(true);
    });

    it('should return no_changes when values already match', async () => {
      vi.mocked(octokit.pulls.get).mockResolvedValueOnce(mockPR as never);

      const tool = registeredTools.get(TOOL_UPDATE_PULL_REQUEST);
      const result = await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        pull_number: 123,
        title: 'Original Title', // Same as current
        _executeFromButton: true,
      });

      expect(octokit.pulls.update).not.toHaveBeenCalled();
      const parsed = parseResponse(result);
      expect(parsed.action).toBe('no_changes');
    });

    it('should return error when no update fields provided', async () => {
      const tool = registeredTools.get(TOOL_UPDATE_PULL_REQUEST);
      const result = await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        pull_number: 123,
        _executeFromButton: true,
      });

      expect(result.isError).toBe(true);
      const parsed = parseResponse(result);
      expect(parsed.suggestion).toContain('at least one field');
    });

    it('should block draft change on merged PR', async () => {
      const mergedPR = {
        data: {
          ...mockPR.data,
          merged: true,
        },
      };
      vi.mocked(octokit.pulls.get).mockResolvedValueOnce(mergedPR as never);

      const tool = registeredTools.get(TOOL_UPDATE_PULL_REQUEST);
      const result = await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        pull_number: 123,
        draft: false,
        _executeFromButton: true,
      });

      expect(result.isError).toBe(true);
      const parsed = parseResponse(result);
      expect(parsed.suggestion).toContain('Merged');
    });

    it('should block draft change on closed PR', async () => {
      const closedPR = {
        data: {
          ...mockPR.data,
          state: 'closed',
        },
      };
      vi.mocked(octokit.pulls.get).mockResolvedValueOnce(closedPR as never);

      const tool = registeredTools.get(TOOL_UPDATE_PULL_REQUEST);
      const result = await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        pull_number: 123,
        draft: false,
        _executeFromButton: true,
      });

      expect(result.isError).toBe(true);
      const parsed = parseResponse(result);
      expect(parsed.suggestion).toContain('Reopen');
    });

    it('should return error when PR is not found', async () => {
      const notFoundError = new Error('Not Found');
      (notFoundError as Error & { status: number }).status = 404;
      vi.mocked(octokit.pulls.get).mockRejectedValueOnce(notFoundError);

      const tool = registeredTools.get(TOOL_UPDATE_PULL_REQUEST);
      const result = await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        pull_number: 99999,
        title: 'New Title',
        _executeFromButton: true,
      });

      expect(result.isError).toBe(true);
      const parsed = parseResponse(result);
      expect(parsed.suggestion).toContain('99999');
      expect(parsed.suggestion).toContain('not found');
    });

    it('should handle rate limit error with suggestion', async () => {
      vi.mocked(octokit.pulls.get).mockResolvedValueOnce(mockPR as never);

      const rateLimitError = new Error('API rate limit exceeded');
      (rateLimitError as Error & { status: number }).status = 403;
      vi.mocked(octokit.pulls.update).mockRejectedValueOnce(rateLimitError);

      const tool = registeredTools.get(TOOL_UPDATE_PULL_REQUEST);
      const result = await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        pull_number: 123,
        title: 'New Title',
        _executeFromButton: true,
      });

      expect(result.isError).toBe(true);
      const parsed = parseResponse(result);
      expect(parsed.suggestion).toContain('rate limit');
    });

    it('should handle API error on update', async () => {
      vi.mocked(octokit.pulls.get).mockResolvedValueOnce(mockPR as never);
      vi.mocked(octokit.pulls.update).mockRejectedValueOnce(new Error('API Error'));

      const tool = registeredTools.get(TOOL_UPDATE_PULL_REQUEST);
      const result = await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        pull_number: 123,
        title: 'New Title',
        _executeFromButton: true,
      });

      expect(result.isError).toBe(true);
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
    });

    it('should update base branch', async () => {
      vi.mocked(octokit.pulls.get).mockResolvedValueOnce(mockPR as never);
      const updatedMockPR = {
        data: {
          ...mockPR.data,
          base: { ref: 'develop', sha: 'xyz789' },
        },
      };
      vi.mocked(octokit.pulls.update).mockResolvedValueOnce(updatedMockPR as never);

      const tool = registeredTools.get(TOOL_UPDATE_PULL_REQUEST);
      await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        pull_number: 123,
        base: 'develop',
        _executeFromButton: true,
      });

      expect(octokit.pulls.update).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        pull_number: 123,
        base: 'develop',
      });
    });

    it('should update maintainer_can_modify', async () => {
      vi.mocked(octokit.pulls.get).mockResolvedValueOnce(mockPR as never);
      const updatedMockPR = {
        data: {
          ...mockPR.data,
          maintainer_can_modify: false,
        },
      };
      vi.mocked(octokit.pulls.update).mockResolvedValueOnce(updatedMockPR as never);

      const tool = registeredTools.get(TOOL_UPDATE_PULL_REQUEST);
      await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        pull_number: 123,
        maintainer_can_modify: false,
        _executeFromButton: true,
      });

      expect(octokit.pulls.update).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        pull_number: 123,
        maintainer_can_modify: false,
      });
    });

    it('should return error when GraphQL fails after REST update succeeds', async () => {
      // Use explicit mock with draft: true to ensure change is detected
      const prWithDraft = {
        data: {
          ...mockPR.data,
          draft: true,
        },
      };
      vi.mocked(octokit.pulls.get).mockResolvedValueOnce(prWithDraft as never);

      const updatedMockPR = {
        data: {
          ...mockPR.data,
          title: 'New Title',
          draft: true, // Still draft after REST update
        },
      };
      vi.mocked(octokit.pulls.update).mockResolvedValueOnce(updatedMockPR as never);

      const graphqlError = new Error('GraphQL mutation failed');
      vi.mocked(octokit.graphql).mockRejectedValueOnce(graphqlError);

      const tool = registeredTools.get(TOOL_UPDATE_PULL_REQUEST);
      const result = await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        pull_number: 123,
        title: 'New Title',
        draft: false, // Change from true to false triggers GraphQL
        _executeFromButton: true,
      });

      expect(octokit.pulls.update).toHaveBeenCalled();
      expect(octokit.graphql).toHaveBeenCalled();
      expect(result.isError).toBe(true);
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
    });

    it('should handle GraphQL error with suggestion', async () => {
      // Use explicit mock with draft: true to ensure change is detected
      const prWithDraft = {
        data: {
          ...mockPR.data,
          draft: true,
        },
      };
      vi.mocked(octokit.pulls.get).mockResolvedValueOnce(prWithDraft as never);

      // Error message containing 'GraphQL' triggers the specific handler
      const graphqlError = new Error('GraphQL: Could not resolve to a PullRequest');
      vi.mocked(octokit.graphql).mockRejectedValueOnce(graphqlError);

      const tool = registeredTools.get(TOOL_UPDATE_PULL_REQUEST);
      const result = await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        pull_number: 123,
        draft: false, // Change from true to false triggers GraphQL
        _executeFromButton: true,
      });

      expect(result.isError).toBe(true);
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.suggestion).toContain('GraphQL');
    });

    it('should skip REST API when only draft status changes', async () => {
      const draftPR = {
        data: {
          ...mockPR.data,
          draft: true,
        },
      };
      vi.mocked(octokit.pulls.get).mockResolvedValueOnce(draftPR as never);
      vi.mocked(octokit.graphql).mockResolvedValueOnce({
        markPullRequestReadyForReview: {
          pullRequest: { id: 'PR_node123', isDraft: false, number: 123, title: 'Original Title' },
        },
      } as never);

      const tool = registeredTools.get(TOOL_UPDATE_PULL_REQUEST);
      const result = await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        pull_number: 123,
        draft: false, // Only changing draft status (from true to false)
        _executeFromButton: true,
      });

      // REST update should NOT be called (no REST fields to update)
      expect(octokit.pulls.update).not.toHaveBeenCalled();
      expect(octokit.graphql).toHaveBeenCalledWith(
        expect.stringContaining('markPullRequestReadyForReview'),
        expect.any(Object)
      );

      const parsed = parseResponse(result);
      expect(parsed.success).toBe(true);
      expect((parsed.pull_request as { draft: boolean }).draft).toBe(false);
    });

    it('should handle invalid base branch 422 error with suggestion', async () => {
      vi.mocked(octokit.pulls.get).mockResolvedValueOnce(mockPR as never);

      const baseError = new Error('Validation failed: base branch does not exist');
      (baseError as Error & { status: number }).status = 422;
      vi.mocked(octokit.pulls.update).mockRejectedValueOnce(baseError);

      const tool = registeredTools.get(TOOL_UPDATE_PULL_REQUEST);
      const result = await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        pull_number: 123,
        base: 'nonexistent-branch',
        _executeFromButton: true,
      });

      expect(result.isError).toBe(true);
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.suggestion).toContain('base');
    });

    it('should handle combined title and draft updates', async () => {
      // Start with an open draft PR (can change both title and draft)
      const openDraftPR = {
        data: {
          ...mockPR.data,
          state: 'open',
          draft: true,
        },
      };
      vi.mocked(octokit.pulls.get).mockResolvedValueOnce(openDraftPR as never);

      const updatedPR = {
        data: {
          ...mockPR.data,
          title: 'New Title',
          draft: true, // Still draft after REST update
        },
      };
      vi.mocked(octokit.pulls.update).mockResolvedValueOnce(updatedPR as never);

      vi.mocked(octokit.graphql).mockResolvedValueOnce({
        markPullRequestReadyForReview: {
          pullRequest: { id: 'PR_node123', isDraft: false, number: 123, title: 'New Title' },
        },
      } as never);

      const tool = registeredTools.get(TOOL_UPDATE_PULL_REQUEST);
      const result = await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        pull_number: 123,
        title: 'New Title',
        draft: false,
        _executeFromButton: true,
      });

      expect(octokit.pulls.update).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        pull_number: 123,
        title: 'New Title',
      });
      expect(octokit.graphql).toHaveBeenCalledWith(
        expect.stringContaining('markPullRequestReadyForReview'),
        expect.any(Object)
      );

      const parsed = parseResponse(result);
      expect(parsed.success).toBe(true);
      expect((parsed.pull_request as { draft: boolean }).draft).toBe(false);
    });
  });

  describe(TOOL_MERGE_PULL_REQUEST, () => {
    const mockPR = {
      data: {
        number: 123,
        title: 'Test PR',
        body: 'PR description',
        state: 'open',
        draft: false,
        html_url: 'https://github.com/owner/repo/pull/123',
        user: { login: 'developer' },
        head: { ref: 'feature-branch', sha: 'abc123' },
        base: { ref: 'main', sha: 'def456' },
        merged: false,
        merged_at: null,
        mergeable: true,
        mergeable_state: 'clean',
        additions: 100,
        deletions: 50,
        changed_files: 10,
        commits: 5,
      },
    };

    it('should register the tool', () => {
      expect(registeredTools.has(TOOL_MERGE_PULL_REQUEST)).toBe(true);
    });

    it('should return preview when not executed from button', async () => {
      vi.mocked(octokit.pulls.get).mockResolvedValueOnce(mockPR as never);

      const tool = registeredTools.get(TOOL_MERGE_PULL_REQUEST);
      const result = await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        pull_number: 123,
      });

      expect(octokit.pulls.merge).not.toHaveBeenCalled();
      const parsed = parseResponse(result);
      expect(parsed.action).toBe('preview');
      expect(parsed.merge.pull_request.number).toBe(123);
      expect(parsed.merge.merge_method).toBe('merge');
    });

    it('should merge PR when executed from button', async () => {
      vi.mocked(octokit.pulls.get).mockResolvedValueOnce(mockPR as never);
      vi.mocked(octokit.pulls.merge).mockResolvedValueOnce({
        data: {
          merged: true,
          message: 'Pull Request successfully merged',
          sha: 'merged-sha-123',
        },
      } as never);

      const tool = registeredTools.get(TOOL_MERGE_PULL_REQUEST);
      const result = await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        pull_number: 123,
        _executeFromButton: true,
      });

      expect(octokit.pulls.merge).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        pull_number: 123,
        merge_method: 'merge',
      });

      const parsed = parseResponse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.merged).toBe(true);
      expect(parsed.sha).toBe('merged-sha-123');
    });

    it('should support squash merge method', async () => {
      vi.mocked(octokit.pulls.get).mockResolvedValueOnce(mockPR as never);
      vi.mocked(octokit.pulls.merge).mockResolvedValueOnce({
        data: { merged: true, message: 'Merged', sha: 'sha' },
      } as never);

      const tool = registeredTools.get(TOOL_MERGE_PULL_REQUEST);
      await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        pull_number: 123,
        merge_method: 'squash',
        _executeFromButton: true,
      });

      expect(octokit.pulls.merge).toHaveBeenCalledWith(
        expect.objectContaining({
          merge_method: 'squash',
        })
      );
    });

    it('should support rebase merge method', async () => {
      vi.mocked(octokit.pulls.get).mockResolvedValueOnce(mockPR as never);
      vi.mocked(octokit.pulls.merge).mockResolvedValueOnce({
        data: { merged: true, message: 'Merged', sha: 'sha' },
      } as never);

      const tool = registeredTools.get(TOOL_MERGE_PULL_REQUEST);
      await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        pull_number: 123,
        merge_method: 'rebase',
        _executeFromButton: true,
      });

      expect(octokit.pulls.merge).toHaveBeenCalledWith(
        expect.objectContaining({
          merge_method: 'rebase',
        })
      );
    });

    it('should pass custom commit title and message', async () => {
      vi.mocked(octokit.pulls.get).mockResolvedValueOnce(mockPR as never);
      vi.mocked(octokit.pulls.merge).mockResolvedValueOnce({
        data: { merged: true, message: 'Merged', sha: 'sha' },
      } as never);

      const tool = registeredTools.get(TOOL_MERGE_PULL_REQUEST);
      await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        pull_number: 123,
        commit_title: 'Custom title',
        commit_message: 'Custom message',
        _executeFromButton: true,
      });

      expect(octokit.pulls.merge).toHaveBeenCalledWith(
        expect.objectContaining({
          commit_title: 'Custom title',
          commit_message: 'Custom message',
        })
      );
    });

    it('should pass SHA when provided', async () => {
      vi.mocked(octokit.pulls.get).mockResolvedValueOnce(mockPR as never);
      vi.mocked(octokit.pulls.merge).mockResolvedValueOnce({
        data: { merged: true, message: 'Merged', sha: 'sha' },
      } as never);

      const tool = registeredTools.get(TOOL_MERGE_PULL_REQUEST);
      await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        pull_number: 123,
        sha: 'abc123',
        _executeFromButton: true,
      });

      expect(octokit.pulls.merge).toHaveBeenCalledWith(
        expect.objectContaining({
          sha: 'abc123',
        })
      );
    });

    it('should handle already merged PR', async () => {
      const mergedPR = {
        data: {
          ...mockPR.data,
          merged: true,
          merged_at: '2024-01-15T00:00:00Z',
        },
      };
      vi.mocked(octokit.pulls.get).mockResolvedValueOnce(mergedPR as never);

      const tool = registeredTools.get(TOOL_MERGE_PULL_REQUEST);
      const result = await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        pull_number: 123,
        _executeFromButton: true,
      });

      expect(octokit.pulls.merge).not.toHaveBeenCalled();
      const parsed = parseResponse(result);
      expect(parsed.action).toBe('already_merged');
    });

    it('should return error for closed PR', async () => {
      const closedPR = {
        data: {
          ...mockPR.data,
          state: 'closed',
          merged: false,
        },
      };
      vi.mocked(octokit.pulls.get).mockResolvedValueOnce(closedPR as never);

      const tool = registeredTools.get(TOOL_MERGE_PULL_REQUEST);
      const result = await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        pull_number: 123,
        _executeFromButton: true,
      });

      expect(octokit.pulls.merge).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
      const parsed = parseResponse(result);
      expect(parsed.suggestion).toContain('Reopen');
    });

    it('should return error when PR is not mergeable', async () => {
      const nonMergeablePR = {
        data: {
          ...mockPR.data,
          mergeable: false,
          mergeable_state: 'dirty',
        },
      };
      vi.mocked(octokit.pulls.get).mockResolvedValueOnce(nonMergeablePR as never);

      const tool = registeredTools.get(TOOL_MERGE_PULL_REQUEST);
      const result = await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        pull_number: 123,
        _executeFromButton: true,
      });

      expect(octokit.pulls.merge).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
      const parsed = parseResponse(result);
      expect(parsed.suggestion).toContain('dirty');
    });

    it('should return error when PR is not found', async () => {
      const notFoundError = new Error('Not Found');
      (notFoundError as Error & { status: number }).status = 404;
      vi.mocked(octokit.pulls.get).mockRejectedValueOnce(notFoundError);

      const tool = registeredTools.get(TOOL_MERGE_PULL_REQUEST);
      const result = await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        pull_number: 99999,
        _executeFromButton: true,
      });

      expect(result.isError).toBe(true);
      const parsed = parseResponse(result);
      expect(parsed.suggestion).toContain('99999');
      expect(parsed.suggestion).toContain('not found');
    });

    it('should handle rate limit error with suggestion', async () => {
      vi.mocked(octokit.pulls.get).mockResolvedValueOnce(mockPR as never);

      const rateLimitError = new Error('API rate limit exceeded');
      (rateLimitError as Error & { status: number }).status = 403;
      vi.mocked(octokit.pulls.merge).mockRejectedValueOnce(rateLimitError);

      const tool = registeredTools.get(TOOL_MERGE_PULL_REQUEST);
      const result = await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        pull_number: 123,
        _executeFromButton: true,
      });

      expect(result.isError).toBe(true);
      const parsed = parseResponse(result);
      expect(parsed.suggestion).toContain('rate limit');
    });

    it('should handle 405 not mergeable error', async () => {
      vi.mocked(octokit.pulls.get).mockResolvedValueOnce(mockPR as never);

      const notMergeableError = new Error('Not mergeable');
      (notMergeableError as Error & { status: number }).status = 405;
      vi.mocked(octokit.pulls.merge).mockRejectedValueOnce(notMergeableError);

      const tool = registeredTools.get(TOOL_MERGE_PULL_REQUEST);
      const result = await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        pull_number: 123,
        _executeFromButton: true,
      });

      expect(result.isError).toBe(true);
      const parsed = parseResponse(result);
      expect(parsed.suggestion).toContain('not mergeable');
    });

    it('should handle 409 SHA mismatch error', async () => {
      vi.mocked(octokit.pulls.get).mockResolvedValueOnce(mockPR as never);

      const shaError = new Error('Head SHA mismatch');
      (shaError as Error & { status: number }).status = 409;
      vi.mocked(octokit.pulls.merge).mockRejectedValueOnce(shaError);

      const tool = registeredTools.get(TOOL_MERGE_PULL_REQUEST);
      const result = await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        pull_number: 123,
        _executeFromButton: true,
      });

      expect(result.isError).toBe(true);
      const parsed = parseResponse(result);
      expect(parsed.suggestion).toContain('SHA');
    });

    it('should handle 422 merge conflict error', async () => {
      vi.mocked(octokit.pulls.get).mockResolvedValueOnce(mockPR as never);

      const conflictError = new Error('Merge conflict');
      (conflictError as Error & { status: number }).status = 422;
      vi.mocked(octokit.pulls.merge).mockRejectedValueOnce(conflictError);

      const tool = registeredTools.get(TOOL_MERGE_PULL_REQUEST);
      const result = await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        pull_number: 123,
        _executeFromButton: true,
      });

      expect(result.isError).toBe(true);
      const parsed = parseResponse(result);
      expect(parsed.suggestion).toContain('conflict');
    });
  });

  describe(TOOL_GET_PULL_REQUEST_FILES, () => {
    it('should register the tool', () => {
      expect(registeredTools.has(TOOL_GET_PULL_REQUEST_FILES)).toBe(true);
    });

    it('should return file list on success', async () => {
      const mockFiles = {
        data: [
          {
            sha: 'abc123',
            filename: 'src/index.ts',
            status: 'modified',
            additions: 10,
            deletions: 5,
            changes: 15,
            blob_url: 'https://github.com/owner/repo/blob/abc/src/index.ts',
            raw_url: 'https://github.com/owner/repo/raw/abc/src/index.ts',
            patch: '@@ -1,5 +1,10 @@\n-old\n+new',
          },
        ],
      };

      vi.mocked(octokit.pulls.listFiles).mockResolvedValueOnce(mockFiles as never);

      const tool = registeredTools.get(TOOL_GET_PULL_REQUEST_FILES);
      const result = await tool!.handler({ owner: 'owner', repo: 'repo', pull_number: 123 });

      expect(result.isError).toBeUndefined();
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.total_count).toBe(1);
      expect(parsed.files).toHaveLength(1);
      expect((parsed.files as Array<{ filename: string }>)[0].filename).toBe('src/index.ts');
      expect((parsed.files as Array<{ additions: number }>)[0].additions).toBe(10);
      expect((parsed.files as Array<{ patch: string }>)[0].patch).toContain('@@ -1,5 +1,10 @@');
    });

    it('should handle binary files without patches', async () => {
      const mockFiles = {
        data: [
          {
            sha: 'def456',
            filename: 'assets/image.png',
            status: 'added',
            additions: 0,
            deletions: 0,
            changes: 0,
            blob_url: 'https://github.com/owner/repo/blob/abc/assets/image.png',
            raw_url: 'https://github.com/owner/repo/raw/abc/assets/image.png',
            // No patch for binary files
          },
        ],
      };

      vi.mocked(octokit.pulls.listFiles).mockResolvedValueOnce(mockFiles as never);

      const tool = registeredTools.get(TOOL_GET_PULL_REQUEST_FILES);
      const result = await tool!.handler({ owner: 'owner', repo: 'repo', pull_number: 123 });

      const parsed = parseResponse(result);
      expect(parsed.success).toBe(true);
      expect((parsed.files as Array<{ is_binary: boolean }>)[0].is_binary).toBe(true);
      expect((parsed.files as Array<{ patch: string | null }>)[0].patch).toBeNull();
    });

    it('should handle renamed files with previous_filename', async () => {
      const mockFiles = {
        data: [
          {
            sha: 'ghi789',
            filename: 'src/new-name.ts',
            status: 'renamed',
            additions: 0,
            deletions: 0,
            changes: 0,
            previous_filename: 'src/old-name.ts',
            blob_url: 'https://github.com/owner/repo/blob/abc/src/new-name.ts',
            raw_url: 'https://github.com/owner/repo/raw/abc/src/new-name.ts',
            patch: '',
          },
        ],
      };

      vi.mocked(octokit.pulls.listFiles).mockResolvedValueOnce(mockFiles as never);

      const tool = registeredTools.get(TOOL_GET_PULL_REQUEST_FILES);
      const result = await tool!.handler({ owner: 'owner', repo: 'repo', pull_number: 123 });

      const parsed = parseResponse(result);
      expect(parsed.success).toBe(true);
      expect((parsed.files as Array<{ status: string }>)[0].status).toBe('renamed');
      expect((parsed.files as Array<{ previous_filename: string }>)[0].previous_filename).toBe('src/old-name.ts');
    });

    it('should handle pagination parameters', async () => {
      vi.mocked(octokit.pulls.listFiles).mockResolvedValueOnce({ data: [] } as never);

      const tool = registeredTools.get(TOOL_GET_PULL_REQUEST_FILES);
      await tool!.handler({ owner: 'owner', repo: 'repo', pull_number: 123, per_page: 50, page: 2 });

      expect(octokit.pulls.listFiles).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        pull_number: 123,
        per_page: 50,
        page: 2,
      });
    });

    it('should return error for non-existent PR', async () => {
      const notFoundError = new Error('Not Found');
      (notFoundError as Error & { status: number }).status = 404;
      vi.mocked(octokit.pulls.listFiles).mockRejectedValueOnce(notFoundError);

      const tool = registeredTools.get(TOOL_GET_PULL_REQUEST_FILES);
      const result = await tool!.handler({ owner: 'owner', repo: 'repo', pull_number: 99999 });

      expect(result.isError).toBe(true);
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.suggestion).toContain('not found');
    });

    it('should handle rate limit error', async () => {
      const rateLimitError = new Error('API rate limit exceeded');
      (rateLimitError as Error & { status: number }).status = 403;
      vi.mocked(octokit.pulls.listFiles).mockRejectedValueOnce(rateLimitError);

      const tool = registeredTools.get(TOOL_GET_PULL_REQUEST_FILES);
      const result = await tool!.handler({ owner: 'owner', repo: 'repo', pull_number: 123 });

      expect(result.isError).toBe(true);
      const parsed = parseResponse(result);
      expect(parsed.suggestion).toContain('rate limit');
    });

    it('should return pagination info', async () => {
      // Return exactly 100 items to indicate there may be more
      const mockFiles = {
        data: Array(100)
          .fill(null)
          .map((_, i) => ({
            sha: `sha${i}`,
            filename: `file${i}.ts`,
            status: 'modified',
            additions: 1,
            deletions: 0,
            changes: 1,
            blob_url: `https://github.com/owner/repo/blob/abc/file${i}.ts`,
            raw_url: `https://github.com/owner/repo/raw/abc/file${i}.ts`,
            patch: '+line',
          })),
      };

      vi.mocked(octokit.pulls.listFiles).mockResolvedValueOnce(mockFiles as never);

      const tool = registeredTools.get(TOOL_GET_PULL_REQUEST_FILES);
      const result = await tool!.handler({ owner: 'owner', repo: 'repo', pull_number: 123 });

      const parsed = parseResponse(result);
      expect(parsed.pagination).toBeDefined();
      expect((parsed.pagination as { has_more: boolean }).has_more).toBe(true);
    });

    it('should handle deleted files without marking as binary', async () => {
      const mockFiles = {
        data: [
          {
            sha: 'abc123',
            filename: 'deleted-file.ts',
            status: 'removed',
            additions: 0,
            deletions: 10,
            changes: 10,
            blob_url: 'https://github.com/owner/repo/blob/abc/deleted-file.ts',
            raw_url: 'https://github.com/owner/repo/raw/abc/deleted-file.ts',
            // No patch for deleted files
          },
        ],
      };

      vi.mocked(octokit.pulls.listFiles).mockResolvedValueOnce(mockFiles as never);

      const tool = registeredTools.get(TOOL_GET_PULL_REQUEST_FILES);
      const result = await tool!.handler({ owner: 'owner', repo: 'repo', pull_number: 123 });

      const parsed = parseResponse(result);
      expect(parsed.success).toBe(true);
      // Deleted files should NOT be marked as binary even without a patch
      expect((parsed.files as Array<{ is_binary: boolean }>)[0].is_binary).toBe(false);
      expect((parsed.files as Array<{ status: string }>)[0].status).toBe('removed');
    });

    it('should warn when 3000 file limit is reached', async () => {
      // Return exactly 3000 items to trigger the warning
      const mockFiles = {
        data: Array(3000)
          .fill(null)
          .map((_, i) => ({
            sha: `sha${i}`,
            filename: `file${i}.ts`,
            status: 'modified',
            additions: 1,
            deletions: 0,
            changes: 1,
            blob_url: `https://github.com/owner/repo/blob/abc/file${i}.ts`,
            raw_url: `https://github.com/owner/repo/raw/abc/file${i}.ts`,
            patch: '+line',
          })),
      };

      vi.mocked(octokit.pulls.listFiles).mockResolvedValueOnce(mockFiles as never);

      const tool = registeredTools.get(TOOL_GET_PULL_REQUEST_FILES);
      const result = await tool!.handler({ owner: 'owner', repo: 'repo', pull_number: 123 });

      const parsed = parseResponse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.warning).toBeDefined();
      expect(parsed.warning).toContain('3000');
    });
  });

  describe(TOOL_GET_PULL_REQUEST_DIFF, () => {
    it('should register the tool', () => {
      expect(registeredTools.has(TOOL_GET_PULL_REQUEST_DIFF)).toBe(true);
    });

    it('should return raw diff on success', async () => {
      const mockDiff = `diff --git a/src/index.ts b/src/index.ts
index abc123..def456 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -1,5 +1,10 @@
-old code
+new code`;

      vi.mocked(octokit.request).mockResolvedValueOnce({
        data: mockDiff,
        headers: {},
      } as never);

      const tool = registeredTools.get(TOOL_GET_PULL_REQUEST_DIFF);
      const result = await tool!.handler({ owner: 'owner', repo: 'repo', pull_number: 123 });

      expect(result.isError).toBeUndefined();
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.pull_number).toBe(123);
      expect(parsed.diff).toContain('diff --git');
      expect(parsed.diff).toContain('--- a/src/index.ts');
      expect(parsed.diff).toContain('+++ b/src/index.ts');
      expect(parsed.diff_lines).toBeGreaterThan(0);
    });

    it('should handle empty diff', async () => {
      vi.mocked(octokit.request).mockResolvedValueOnce({
        data: '',
        headers: {},
      } as never);

      const tool = registeredTools.get(TOOL_GET_PULL_REQUEST_DIFF);
      const result = await tool!.handler({ owner: 'owner', repo: 'repo', pull_number: 123 });

      const parsed = parseResponse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.diff).toBe('');
      expect(parsed.diff_lines).toBe(0);
    });

    it('should return error for non-existent PR', async () => {
      const notFoundError = new Error('Not Found');
      (notFoundError as Error & { status: number }).status = 404;
      vi.mocked(octokit.request).mockRejectedValueOnce(notFoundError);

      const tool = registeredTools.get(TOOL_GET_PULL_REQUEST_DIFF);
      const result = await tool!.handler({ owner: 'owner', repo: 'repo', pull_number: 99999 });

      expect(result.isError).toBe(true);
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.suggestion).toContain('not found');
    });

    it('should handle 406 error for diff too large', async () => {
      const tooLargeError = new Error('Diff is too large');
      (tooLargeError as Error & { status: number }).status = 406;
      vi.mocked(octokit.request).mockRejectedValueOnce(tooLargeError);

      const tool = registeredTools.get(TOOL_GET_PULL_REQUEST_DIFF);
      const result = await tool!.handler({ owner: 'owner', repo: 'repo', pull_number: 123 });

      expect(result.isError).toBe(true);
      const parsed = parseResponse(result);
      expect(parsed.suggestion).toContain('get_pull_request_files');
    });

    it('should handle rate limit error', async () => {
      const rateLimitError = new Error('API rate limit exceeded');
      (rateLimitError as Error & { status: number }).status = 403;
      vi.mocked(octokit.request).mockRejectedValueOnce(rateLimitError);

      const tool = registeredTools.get(TOOL_GET_PULL_REQUEST_DIFF);
      const result = await tool!.handler({ owner: 'owner', repo: 'repo', pull_number: 123 });

      expect(result.isError).toBe(true);
      const parsed = parseResponse(result);
      expect(parsed.suggestion).toContain('rate limit');
    });

    it('should call request with correct Accept header', async () => {
      vi.mocked(octokit.request).mockResolvedValueOnce({
        data: 'diff content',
        headers: {},
      } as never);

      const tool = registeredTools.get(TOOL_GET_PULL_REQUEST_DIFF);
      await tool!.handler({ owner: 'owner', repo: 'repo', pull_number: 123 });

      expect(octokit.request).toHaveBeenCalledWith('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
        owner: 'owner',
        repo: 'repo',
        pull_number: 123,
        headers: {
          accept: 'application/vnd.github.diff',
        },
      });
    });
  });
});
