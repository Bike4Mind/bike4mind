import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the config module
vi.mock('../../config.js', () => ({
  githubToken: 'mock-token',
}));

// Mock the client module
vi.mock('../../client.js', () => ({
  octokit: {
    pulls: {
      get: vi.fn(),
      createReview: vi.fn(),
    },
  },
}));

import { registerReviewTools } from '../../tools/reviews.js';
import { octokit } from '../../client.js';
import { TOOL_CREATE_REVIEW, TOOL_APPROVE_PR, TOOL_REQUEST_CHANGES } from '../../constants.js';
import { createMockServer, parseResponse, type RegisteredTool } from '../test-utils.js';

describe('Pull Request Review Tools', () => {
  let registeredTools: Map<string, RegisteredTool>;

  // Common mock PR data
  const mockPR = {
    data: {
      number: 123,
      title: 'Test PR',
      body: 'PR description',
      state: 'open',
      draft: false,
      html_url: 'https://github.com/owner/repo/pull/123',
      user: { login: 'developer' },
      head: { ref: 'feature-branch', sha: 'abc123def456' },
      base: { ref: 'main', sha: 'def456abc123' },
      merged: false,
      merged_at: null,
    },
  };

  // Common mock review response
  const mockReviewResponse = {
    data: {
      id: 12345,
      node_id: 'PRR_node123',
      state: 'APPROVED',
      html_url: 'https://github.com/owner/repo/pull/123#pullrequestreview-12345',
      commit_id: 'abc123def456',
      submitted_at: '2024-01-15T00:00:00Z',
    },
  };

  beforeEach(() => {
    vi.resetAllMocks();
    const mock = createMockServer();
    registeredTools = mock.registeredTools;
    registerReviewTools(mock.server);
  });

  describe(TOOL_CREATE_REVIEW, () => {
    it('should register the tool', () => {
      expect(registeredTools.has(TOOL_CREATE_REVIEW)).toBe(true);
    });

    it('should return preview when not executed from button', async () => {
      vi.mocked(octokit.pulls.get).mockResolvedValueOnce(mockPR as never);

      const tool = registeredTools.get(TOOL_CREATE_REVIEW);
      const result = await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        pull_number: 123,
        event: 'COMMENT',
        body: 'This looks good!',
      });

      expect(octokit.pulls.createReview).not.toHaveBeenCalled();
      const parsed = parseResponse(result);
      expect(parsed.action).toBe('preview');
      expect(parsed.review.event).toBe('COMMENT');
      expect(parsed.review.body).toBe('This looks good!');
    });

    it('should show comments count and paths in preview', async () => {
      vi.mocked(octokit.pulls.get).mockResolvedValueOnce(mockPR as never);

      const tool = registeredTools.get(TOOL_CREATE_REVIEW);
      const result = await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        pull_number: 123,
        event: 'COMMENT',
        body: 'Review with comments',
        comments: [
          { path: 'src/index.ts', line: 10, body: 'Comment 1' },
          { path: 'src/utils.ts', line: 20, body: 'Comment 2' },
        ],
      });

      const parsed = parseResponse(result);
      expect(parsed.action).toBe('preview');
      expect(parsed.review.comments_count).toBe(2);
      expect(parsed.review.comment_paths).toEqual(['src/index.ts', 'src/utils.ts']);
    });

    it('should warn when commit_id differs from HEAD in preview', async () => {
      vi.mocked(octokit.pulls.get).mockResolvedValueOnce(mockPR as never);

      const tool = registeredTools.get(TOOL_CREATE_REVIEW);
      const result = await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        pull_number: 123,
        event: 'APPROVE',
        commit_id: 'old-sha-123',
      });

      const parsed = parseResponse(result);
      expect(parsed.action).toBe('preview');
      expect(parsed.review.warning).toContain('differs from current HEAD');
    });

    it('should create APPROVE review when executed from button', async () => {
      vi.mocked(octokit.pulls.get).mockResolvedValueOnce(mockPR as never);
      vi.mocked(octokit.pulls.createReview).mockResolvedValueOnce(mockReviewResponse as never);

      const tool = registeredTools.get(TOOL_CREATE_REVIEW);
      const result = await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        pull_number: 123,
        event: 'APPROVE',
        body: 'LGTM!',
        _executeFromButton: true,
      });

      expect(octokit.pulls.createReview).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        pull_number: 123,
        event: 'APPROVE',
        body: 'LGTM!',
        commit_id: 'abc123def456',
      });

      const parsed = parseResponse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.review.id).toBe(12345);
      expect(parsed.review.state).toBe('APPROVED');
    });

    it('should create REQUEST_CHANGES review with inline comments', async () => {
      vi.mocked(octokit.pulls.get).mockResolvedValueOnce(mockPR as never);
      const changesReviewResponse = {
        data: {
          ...mockReviewResponse.data,
          state: 'CHANGES_REQUESTED',
        },
      };
      vi.mocked(octokit.pulls.createReview).mockResolvedValueOnce(changesReviewResponse as never);

      const tool = registeredTools.get(TOOL_CREATE_REVIEW);
      const result = await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        pull_number: 123,
        event: 'REQUEST_CHANGES',
        body: 'Please fix these issues',
        comments: [
          { path: 'src/index.ts', line: 10, side: 'RIGHT', body: 'Fix this bug' },
          { path: 'src/utils.ts', line: 20, body: 'Add error handling' },
        ],
        _executeFromButton: true,
      });

      expect(octokit.pulls.createReview).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        pull_number: 123,
        event: 'REQUEST_CHANGES',
        body: 'Please fix these issues',
        commit_id: 'abc123def456',
        comments: [
          { path: 'src/index.ts', line: 10, side: 'RIGHT', body: 'Fix this bug' },
          { path: 'src/utils.ts', line: 20, side: 'RIGHT', body: 'Add error handling' },
        ],
      });

      const parsed = parseResponse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.review.state).toBe('CHANGES_REQUESTED');
    });

    it('should support multi-line comments', async () => {
      vi.mocked(octokit.pulls.get).mockResolvedValueOnce(mockPR as never);
      vi.mocked(octokit.pulls.createReview).mockResolvedValueOnce(mockReviewResponse as never);

      const tool = registeredTools.get(TOOL_CREATE_REVIEW);
      await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        pull_number: 123,
        event: 'COMMENT',
        body: 'Review with multi-line comment',
        comments: [
          {
            path: 'src/index.ts',
            line: 20,
            start_line: 15,
            start_side: 'RIGHT',
            body: 'This entire block needs refactoring',
          },
        ],
        _executeFromButton: true,
      });

      expect(octokit.pulls.createReview).toHaveBeenCalledWith(
        expect.objectContaining({
          comments: [
            expect.objectContaining({
              path: 'src/index.ts',
              line: 20,
              start_line: 15,
              start_side: 'RIGHT',
            }),
          ],
        })
      );
    });

    it('should return error when body is missing for REQUEST_CHANGES', async () => {
      const tool = registeredTools.get(TOOL_CREATE_REVIEW);
      const result = await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        pull_number: 123,
        event: 'REQUEST_CHANGES',
        // body is missing
      });

      expect(result.isError).toBe(true);
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('body is required');
    });

    it('should return error when body is missing for COMMENT', async () => {
      const tool = registeredTools.get(TOOL_CREATE_REVIEW);
      const result = await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        pull_number: 123,
        event: 'COMMENT',
        // body is missing
      });

      expect(result.isError).toBe(true);
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('body is required');
    });

    it('should allow APPROVE without body', async () => {
      vi.mocked(octokit.pulls.get).mockResolvedValueOnce(mockPR as never);
      vi.mocked(octokit.pulls.createReview).mockResolvedValueOnce(mockReviewResponse as never);

      const tool = registeredTools.get(TOOL_CREATE_REVIEW);
      const result = await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        pull_number: 123,
        event: 'APPROVE',
        // No body - should be allowed for APPROVE
        _executeFromButton: true,
      });

      expect(result.isError).toBeUndefined();
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(true);
    });

    it('should return error when PR is not found', async () => {
      const notFoundError = new Error('Not Found');
      (notFoundError as Error & { status: number }).status = 404;
      vi.mocked(octokit.pulls.get).mockRejectedValueOnce(notFoundError);

      const tool = registeredTools.get(TOOL_CREATE_REVIEW);
      const result = await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        pull_number: 99999,
        event: 'APPROVE',
        _executeFromButton: true,
      });

      expect(result.isError).toBe(true);
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.suggestion).toContain('99999');
    });

    it('should return error when PR is merged', async () => {
      const mergedPR = {
        data: {
          ...mockPR.data,
          merged: true,
          merged_at: '2024-01-15T00:00:00Z',
        },
      };
      vi.mocked(octokit.pulls.get).mockResolvedValueOnce(mergedPR as never);

      const tool = registeredTools.get(TOOL_CREATE_REVIEW);
      const result = await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        pull_number: 123,
        event: 'APPROVE',
        _executeFromButton: true,
      });

      expect(octokit.pulls.createReview).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.suggestion).toContain('merged');
    });

    it('should return error when PR is closed', async () => {
      const closedPR = {
        data: {
          ...mockPR.data,
          state: 'closed',
        },
      };
      vi.mocked(octokit.pulls.get).mockResolvedValueOnce(closedPR as never);

      const tool = registeredTools.get(TOOL_CREATE_REVIEW);
      const result = await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        pull_number: 123,
        event: 'APPROVE',
        _executeFromButton: true,
      });

      expect(result.isError).toBe(true);
      const parsed = parseResponse(result);
      expect(parsed.suggestion).toContain('Reopen');
    });

    it('should handle self-review error (403)', async () => {
      vi.mocked(octokit.pulls.get).mockResolvedValueOnce(mockPR as never);

      const selfReviewError = new Error('Cannot review your own pull request');
      (selfReviewError as Error & { status: number }).status = 403;
      vi.mocked(octokit.pulls.createReview).mockRejectedValueOnce(selfReviewError);

      const tool = registeredTools.get(TOOL_CREATE_REVIEW);
      const result = await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        pull_number: 123,
        event: 'APPROVE',
        _executeFromButton: true,
      });

      expect(result.isError).toBe(true);
      const parsed = parseResponse(result);
      expect(parsed.suggestion).toContain('cannot review your own');
    });

    it('should handle permission denied error (403)', async () => {
      vi.mocked(octokit.pulls.get).mockResolvedValueOnce(mockPR as never);

      const permissionError = new Error('Resource not accessible');
      (permissionError as Error & { status: number }).status = 403;
      vi.mocked(octokit.pulls.createReview).mockRejectedValueOnce(permissionError);

      const tool = registeredTools.get(TOOL_CREATE_REVIEW);
      const result = await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        pull_number: 123,
        event: 'APPROVE',
        _executeFromButton: true,
      });

      expect(result.isError).toBe(true);
      const parsed = parseResponse(result);
      expect(parsed.suggestion).toContain('permission');
    });

    it('should handle invalid path 422 error', async () => {
      vi.mocked(octokit.pulls.get).mockResolvedValueOnce(mockPR as never);

      const invalidPathError = new Error('Validation failed for path field');
      (invalidPathError as Error & { status: number }).status = 422;
      vi.mocked(octokit.pulls.createReview).mockRejectedValueOnce(invalidPathError);

      const tool = registeredTools.get(TOOL_CREATE_REVIEW);
      const result = await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        pull_number: 123,
        event: 'COMMENT',
        body: 'Comment',
        comments: [{ path: 'nonexistent.ts', line: 1, body: 'Comment' }],
        _executeFromButton: true,
      });

      expect(result.isError).toBe(true);
      const parsed = parseResponse(result);
      expect(parsed.suggestion).toContain('paths');
    });

    it('should handle rate limit error', async () => {
      vi.mocked(octokit.pulls.get).mockResolvedValueOnce(mockPR as never);

      const rateLimitError = new Error('API rate limit exceeded');
      (rateLimitError as Error & { status: number }).status = 403;
      vi.mocked(octokit.pulls.createReview).mockRejectedValueOnce(rateLimitError);

      const tool = registeredTools.get(TOOL_CREATE_REVIEW);
      const result = await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        pull_number: 123,
        event: 'APPROVE',
        _executeFromButton: true,
      });

      expect(result.isError).toBe(true);
      const parsed = parseResponse(result);
      expect(parsed.suggestion).toContain('rate limit');
    });

    it('should handle token scope error (401)', async () => {
      vi.mocked(octokit.pulls.get).mockResolvedValueOnce(mockPR as never);

      const authError = new Error('Bad credentials');
      (authError as Error & { status: number }).status = 401;
      vi.mocked(octokit.pulls.createReview).mockRejectedValueOnce(authError);

      const tool = registeredTools.get(TOOL_CREATE_REVIEW);
      const result = await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        pull_number: 123,
        event: 'APPROVE',
        _executeFromButton: true,
      });

      expect(result.isError).toBe(true);
      const parsed = parseResponse(result);
      expect(parsed.suggestion).toContain('token');
    });
  });

  describe(TOOL_APPROVE_PR, () => {
    it('should register the tool', () => {
      expect(registeredTools.has(TOOL_APPROVE_PR)).toBe(true);
    });

    it('should return preview when not executed from button', async () => {
      const tool = registeredTools.get(TOOL_APPROVE_PR);
      const result = await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        pull_number: 123,
        body: 'LGTM!',
      });

      expect(octokit.pulls.createReview).not.toHaveBeenCalled();
      const parsed = parseResponse(result);
      expect(parsed.action).toBe('preview');
      expect(parsed.review.event).toBe('APPROVE');
    });

    it('should approve PR when executed from button', async () => {
      vi.mocked(octokit.pulls.get).mockResolvedValueOnce(mockPR as never);
      vi.mocked(octokit.pulls.createReview).mockResolvedValueOnce(mockReviewResponse as never);

      const tool = registeredTools.get(TOOL_APPROVE_PR);
      const result = await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        pull_number: 123,
        body: 'Approved!',
        _executeFromButton: true,
      });

      expect(octokit.pulls.createReview).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'APPROVE',
          body: 'Approved!',
        })
      );

      const parsed = parseResponse(result);
      expect(parsed.success).toBe(true);
    });

    it('should approve without body', async () => {
      vi.mocked(octokit.pulls.get).mockResolvedValueOnce(mockPR as never);
      vi.mocked(octokit.pulls.createReview).mockResolvedValueOnce(mockReviewResponse as never);

      const tool = registeredTools.get(TOOL_APPROVE_PR);
      const result = await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        pull_number: 123,
        _executeFromButton: true,
      });

      expect(result.isError).toBeUndefined();
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(true);
    });
  });

  describe(TOOL_REQUEST_CHANGES, () => {
    it('should register the tool', () => {
      expect(registeredTools.has(TOOL_REQUEST_CHANGES)).toBe(true);
    });

    it('should return preview when not executed from button', async () => {
      const tool = registeredTools.get(TOOL_REQUEST_CHANGES);
      const result = await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        pull_number: 123,
        body: 'Please fix these issues',
      });

      expect(octokit.pulls.createReview).not.toHaveBeenCalled();
      const parsed = parseResponse(result);
      expect(parsed.action).toBe('preview');
      expect(parsed.review.event).toBe('REQUEST_CHANGES');
    });

    it('should request changes when executed from button', async () => {
      vi.mocked(octokit.pulls.get).mockResolvedValueOnce(mockPR as never);
      const changesResponse = {
        data: {
          ...mockReviewResponse.data,
          state: 'CHANGES_REQUESTED',
        },
      };
      vi.mocked(octokit.pulls.createReview).mockResolvedValueOnce(changesResponse as never);

      const tool = registeredTools.get(TOOL_REQUEST_CHANGES);
      const result = await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        pull_number: 123,
        body: 'Please fix these issues',
        comments: [{ path: 'src/index.ts', line: 10, body: 'Fix this' }],
        _executeFromButton: true,
      });

      expect(octokit.pulls.createReview).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'REQUEST_CHANGES',
          body: 'Please fix these issues',
          comments: expect.arrayContaining([
            expect.objectContaining({
              path: 'src/index.ts',
              line: 10,
              body: 'Fix this',
            }),
          ]),
        })
      );

      const parsed = parseResponse(result);
      expect(parsed.success).toBe(true);
    });

    it('should require body for request_changes', async () => {
      const tool = registeredTools.get(TOOL_REQUEST_CHANGES);
      const result = await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        pull_number: 123,
        // body is missing
      });

      expect(result.isError).toBe(true);
      const parsed = parseResponse(result);
      expect(parsed.error).toContain('body is required');
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty comments array', async () => {
      vi.mocked(octokit.pulls.get).mockResolvedValueOnce(mockPR as never);
      vi.mocked(octokit.pulls.createReview).mockResolvedValueOnce(mockReviewResponse as never);

      const tool = registeredTools.get(TOOL_CREATE_REVIEW);
      const result = await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        pull_number: 123,
        event: 'COMMENT',
        body: 'Just a comment',
        comments: [],
        _executeFromButton: true,
      });

      // Empty comments array should not include comments in request
      expect(octokit.pulls.createReview).toHaveBeenCalledWith(
        expect.not.objectContaining({ comments: expect.anything() })
      );

      const parsed = parseResponse(result);
      expect(parsed.success).toBe(true);
    });

    it('should default side to RIGHT when not specified', async () => {
      vi.mocked(octokit.pulls.get).mockResolvedValueOnce(mockPR as never);
      vi.mocked(octokit.pulls.createReview).mockResolvedValueOnce(mockReviewResponse as never);

      const tool = registeredTools.get(TOOL_CREATE_REVIEW);
      await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        pull_number: 123,
        event: 'COMMENT',
        body: 'Comment',
        comments: [{ path: 'src/index.ts', line: 10, body: 'Comment without side' }],
        _executeFromButton: true,
      });

      expect(octokit.pulls.createReview).toHaveBeenCalledWith(
        expect.objectContaining({
          comments: [
            expect.objectContaining({
              side: 'RIGHT',
            }),
          ],
        })
      );
    });

    it('should use provided commit_id when specified', async () => {
      vi.mocked(octokit.pulls.get).mockResolvedValueOnce(mockPR as never);
      vi.mocked(octokit.pulls.createReview).mockResolvedValueOnce(mockReviewResponse as never);

      const tool = registeredTools.get(TOOL_CREATE_REVIEW);
      await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        pull_number: 123,
        event: 'APPROVE',
        commit_id: 'specific-sha-123',
        _executeFromButton: true,
      });

      expect(octokit.pulls.createReview).toHaveBeenCalledWith(
        expect.objectContaining({
          commit_id: 'specific-sha-123',
        })
      );
    });
  });
});
