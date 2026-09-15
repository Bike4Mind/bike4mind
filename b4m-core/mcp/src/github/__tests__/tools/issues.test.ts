import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the config module
vi.mock('../../config.js', () => ({
  githubToken: 'mock-token',
}));

// Mock the client module
vi.mock('../../client.js', () => ({
  octokit: {
    issues: {
      create: vi.fn(),
      update: vi.fn(),
      listForRepo: vi.fn(),
      listLabelsForRepo: vi.fn(),
      get: vi.fn(),
      createComment: vi.fn(),
    },
    rest: {
      issues: {
        list: vi.fn(),
      },
    },
    graphql: vi.fn(),
  },
}));

import { registerIssueTools } from '../../tools/issues.js';
import { octokit } from '../../client.js';
import {
  TOOL_CREATE_ISSUE,
  TOOL_UPDATE_ISSUE,
  TOOL_LIST_ISSUES,
  TOOL_GET_ISSUE,
  TOOL_CREATE_ISSUE_COMMENT,
} from '../../constants.js';
import { createMockServer, parseResponse, type RegisteredTool } from '../test-utils.js';

describe('Issue Tools', () => {
  let registeredTools: Map<string, RegisteredTool>;

  beforeEach(() => {
    vi.clearAllMocks();
    const mock = createMockServer();
    registeredTools = mock.registeredTools;
    registerIssueTools(mock.server);
  });

  describe(TOOL_CREATE_ISSUE, () => {
    it('should register the tool', () => {
      expect(registeredTools.has(TOOL_CREATE_ISSUE)).toBe(true);
    });

    it('should return preview when not executed from button', async () => {
      const tool = registeredTools.get(TOOL_CREATE_ISSUE);
      const result = await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        title: 'Test Issue',
        body: 'Issue description',
        _executeFromButton: false,
      });

      // Should return a preview, not actually create
      expect(octokit.issues.create).not.toHaveBeenCalled();
      const parsed = parseResponse(result);
      expect(parsed.action).toBe('preview');
    });

    it('should create issue when executed from button', async () => {
      const mockResult = {
        data: {
          number: 42,
          html_url: 'https://github.com/owner/repo/issues/42',
          title: 'Test Issue',
          state: 'open',
        },
      };

      // Mock label validation to return 'bug' as existing label
      vi.mocked(octokit.issues.listLabelsForRepo).mockResolvedValueOnce({
        data: [{ name: 'bug' }, { name: 'feature' }],
      } as never);

      vi.mocked(octokit.issues.create).mockResolvedValueOnce(mockResult as never);

      const tool = registeredTools.get(TOOL_CREATE_ISSUE);
      const result = await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        title: 'Test Issue',
        body: 'Issue description',
        labels: ['bug'],
        assignees: ['user1'],
        _executeFromButton: true,
      });

      expect(octokit.issues.create).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        title: 'Test Issue',
        body: 'Issue description',
        labels: ['bug'],
        assignees: ['user1'],
      });

      const parsed = parseResponse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.issue_number).toBe(42);
    });

    it('should return error on API failure', async () => {
      vi.mocked(octokit.issues.create).mockRejectedValueOnce(new Error('API Error'));

      const tool = registeredTools.get(TOOL_CREATE_ISSUE);
      const result = await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        title: 'Test',
        _executeFromButton: true,
      });

      expect(result.isError).toBe(true);
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
    });
  });

  describe(TOOL_UPDATE_ISSUE, () => {
    it('should register the tool', () => {
      expect(registeredTools.has(TOOL_UPDATE_ISSUE)).toBe(true);
    });

    it('should return preview when not executed from button', async () => {
      const tool = registeredTools.get(TOOL_UPDATE_ISSUE);
      const result = await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        issue_number: 42,
        title: 'Updated Title',
        _executeFromButton: false,
      });

      expect(octokit.issues.update).not.toHaveBeenCalled();
      const parsed = parseResponse(result);
      expect(parsed.action).toBe('preview');
    });

    it('should update issue when executed from button', async () => {
      const mockResult = {
        data: {
          number: 42,
          html_url: 'https://github.com/owner/repo/issues/42',
          title: 'Updated Title',
          state: 'open',
          labels: [{ name: 'bug' }],
          assignees: [{ login: 'user1' }],
          updated_at: '2024-01-15T00:00:00Z',
        },
      };

      vi.mocked(octokit.issues.update).mockResolvedValueOnce(mockResult as never);

      const tool = registeredTools.get(TOOL_UPDATE_ISSUE);
      const result = await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        issue_number: 42,
        title: 'Updated Title',
        state: 'closed',
        _executeFromButton: true,
      });

      expect(octokit.issues.update).toHaveBeenCalled();
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.issue_number).toBe(42);
    });
  });

  describe(TOOL_LIST_ISSUES, () => {
    it('should register the tool', () => {
      expect(registeredTools.has(TOOL_LIST_ISSUES)).toBe(true);
    });

    it('should return issue list on success', async () => {
      const mockIssues = {
        data: [
          {
            number: 1,
            title: 'First issue',
            state: 'open',
            html_url: 'https://github.com/owner/repo/issues/1',
            labels: [{ name: 'bug' }],
            assignees: [{ login: 'user1' }],
            created_at: '2024-01-01T00:00:00Z',
            updated_at: '2024-01-15T00:00:00Z',
            closed_at: null,
          },
        ],
      };

      vi.mocked(octokit.issues.listForRepo).mockResolvedValueOnce(mockIssues as never);

      const tool = registeredTools.get(TOOL_LIST_ISSUES);
      const result = await tool!.handler({ owner: 'owner', repo: 'repo' });

      expect(result.isError).toBeUndefined();
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.issues).toHaveLength(1);
      expect((parsed.issues as Array<{ number: number }>)[0].number).toBe(1);
    });

    it('should pass filters to API', async () => {
      vi.mocked(octokit.issues.listForRepo).mockResolvedValueOnce({ data: [] } as never);

      const tool = registeredTools.get(TOOL_LIST_ISSUES);
      await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        state: 'closed',
        labels: 'bug,enhancement',
        assignee: 'user1',
        per_page: 50,
      });

      expect(octokit.issues.listForRepo).toHaveBeenCalledWith(
        expect.objectContaining({
          state: 'closed',
          labels: 'bug,enhancement',
          assignee: 'user1',
          per_page: 50,
        })
      );
    });
  });

  describe(TOOL_GET_ISSUE, () => {
    it('should register the tool', () => {
      expect(registeredTools.has(TOOL_GET_ISSUE)).toBe(true);
    });

    it('should return issue details with projects', async () => {
      const mockIssue = {
        data: {
          number: 42,
          node_id: 'I_kwDOABC123',
          title: 'Test Issue',
          body: 'Issue body',
          state: 'open',
          html_url: 'https://github.com/owner/repo/issues/42',
          labels: [{ name: 'bug' }],
          assignees: [{ login: 'user1' }],
          user: { login: 'creator' },
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-15T00:00:00Z',
          closed_at: null,
          comments: 10,
          milestone: { title: 'v1.0' },
          type: 'Bug',
        },
      };

      const mockProjects = {
        node: {
          projectItems: {
            nodes: [{ project: { id: 'PVT_123', title: 'Project 1', url: 'https://github.com/orgs/org/projects/1' } }],
          },
        },
      };

      vi.mocked(octokit.issues.get).mockResolvedValueOnce(mockIssue as never);
      vi.mocked(octokit.graphql).mockResolvedValueOnce(mockProjects as never);

      const tool = registeredTools.get(TOOL_GET_ISSUE);
      const result = await tool!.handler({ owner: 'owner', repo: 'repo', issue_number: 42 });

      const parsed = parseResponse(result);
      expect(parsed.success).toBe(true);
      expect((parsed.issue as { number: number }).number).toBe(42);
      expect((parsed.issue as { node_id: string }).node_id).toBe('I_kwDOABC123');
      expect((parsed.issue as { projects: Array<unknown> }).projects).toHaveLength(1);
      expect((parsed.issue as { projects: Array<{ title: string }> }).projects[0].title).toBe('Project 1');
    });
  });

  describe(TOOL_CREATE_ISSUE_COMMENT, () => {
    it('should register the tool', () => {
      expect(registeredTools.has(TOOL_CREATE_ISSUE_COMMENT)).toBe(true);
    });

    it('should return preview when not executed from button', async () => {
      const tool = registeredTools.get(TOOL_CREATE_ISSUE_COMMENT);
      const result = await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        issue_number: 42,
        body: 'My comment',
        _executeFromButton: false,
      });

      expect(octokit.issues.createComment).not.toHaveBeenCalled();
      const parsed = parseResponse(result);
      expect(parsed.action).toBe('preview');
    });

    it('should create comment when executed from button', async () => {
      const mockResult = {
        data: {
          id: 12345,
          html_url: 'https://github.com/owner/repo/issues/42#issuecomment-12345',
        },
      };

      vi.mocked(octokit.issues.createComment).mockResolvedValueOnce(mockResult as never);

      const tool = registeredTools.get(TOOL_CREATE_ISSUE_COMMENT);
      const result = await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        issue_number: 42,
        body: 'My comment',
        _executeFromButton: true,
      });

      expect(octokit.issues.createComment).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        issue_number: 42,
        body: 'My comment',
      });

      const parsed = parseResponse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.comment_id).toBe(12345);
    });

    it('should truncate body preview for long comments', async () => {
      const mockResult = {
        data: {
          id: 12345,
          html_url: 'https://github.com/owner/repo/issues/42#issuecomment-12345',
        },
      };

      vi.mocked(octokit.issues.createComment).mockResolvedValueOnce(mockResult as never);

      const longBody = 'a'.repeat(200);
      const tool = registeredTools.get(TOOL_CREATE_ISSUE_COMMENT);
      const result = await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        issue_number: 42,
        body: longBody,
        _executeFromButton: true,
      });

      const parsed = parseResponse(result);
      expect((parsed.body_preview as string).length).toBeLessThan(longBody.length);
      expect(parsed.body_preview).toContain('...');
    });
  });
});
