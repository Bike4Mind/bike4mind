import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the config module
vi.mock('../../config.js', () => ({
  githubToken: 'mock-token',
}));

// Mock the client module
vi.mock('../../client.js', () => ({
  octokit: {
    issues: {
      createMilestone: vi.fn(),
      updateMilestone: vi.fn(),
      listMilestones: vi.fn(),
      getMilestone: vi.fn(),
    },
  },
}));

import { registerMilestoneTools } from '../../tools/milestones.js';
import { octokit } from '../../client.js';
import {
  TOOL_CREATE_MILESTONE,
  TOOL_UPDATE_MILESTONE,
  TOOL_LIST_MILESTONES,
  TOOL_CLOSE_MILESTONE,
} from '../../constants.js';
import { createMockServer, parseResponse, type RegisteredTool } from '../test-utils.js';

describe('Milestone Tools', () => {
  let registeredTools: Map<string, RegisteredTool>;

  beforeEach(() => {
    vi.clearAllMocks();
    const mock = createMockServer();
    registeredTools = mock.registeredTools;
    registerMilestoneTools(mock.server);
  });

  describe(TOOL_CREATE_MILESTONE, () => {
    it('should register the tool', () => {
      expect(registeredTools.has(TOOL_CREATE_MILESTONE)).toBe(true);
    });

    it('should return preview when not executed from button', async () => {
      const tool = registeredTools.get(TOOL_CREATE_MILESTONE);
      const result = await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        title: 'v1.0 Release',
        description: 'First stable release',
        due_on: '2024-03-01T00:00:00Z',
        _executeFromButton: false,
      });

      // Should return a preview, not actually create
      expect(octokit.issues.createMilestone).not.toHaveBeenCalled();
      const parsed = parseResponse(result);
      expect(parsed.action).toBe('preview');
      expect(parsed.message).toContain('Preview');
    });

    it('should create milestone when executed from button', async () => {
      const mockResult = {
        data: {
          number: 1,
          html_url: 'https://github.com/owner/repo/milestone/1',
          title: 'v1.0 Release',
          description: 'First stable release',
          state: 'open',
          due_on: '2024-03-01T00:00:00Z',
          open_issues: 0,
          closed_issues: 0,
        },
      };

      vi.mocked(octokit.issues.createMilestone).mockResolvedValueOnce(mockResult as never);

      const tool = registeredTools.get(TOOL_CREATE_MILESTONE);
      const result = await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        title: 'v1.0 Release',
        description: 'First stable release',
        due_on: '2024-03-01T00:00:00Z',
        _executeFromButton: true,
      });

      expect(octokit.issues.createMilestone).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        title: 'v1.0 Release',
        description: 'First stable release',
        due_on: '2024-03-01T12:00:00Z', // Normalized to noon UTC to avoid timezone issues
        state: undefined,
      });

      const parsed = parseResponse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.number).toBe(1);
      expect(parsed.title).toBe('v1.0 Release');
      expect(parsed.progress_percent).toBe(0);
    });

    it('should return error on API failure', async () => {
      vi.mocked(octokit.issues.createMilestone).mockRejectedValueOnce(new Error('API Error'));

      const tool = registeredTools.get(TOOL_CREATE_MILESTONE);
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

    it('should calculate progress percentage correctly', async () => {
      const mockResult = {
        data: {
          number: 1,
          html_url: 'https://github.com/owner/repo/milestone/1',
          title: 'v1.0 Release',
          description: 'First stable release',
          state: 'open',
          due_on: '2024-03-01T00:00:00Z',
          open_issues: 5,
          closed_issues: 12,
        },
      };

      vi.mocked(octokit.issues.createMilestone).mockResolvedValueOnce(mockResult as never);

      const tool = registeredTools.get(TOOL_CREATE_MILESTONE);
      const result = await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        title: 'v1.0 Release',
        _executeFromButton: true,
      });

      const parsed = parseResponse(result);
      expect(parsed.success).toBe(true);
      // 12 / (5 + 12) * 100 = 70.588... rounded to 70.6
      expect(parsed.progress_percent).toBe(70.6);
    });
  });

  describe(TOOL_UPDATE_MILESTONE, () => {
    it('should register the tool', () => {
      expect(registeredTools.has(TOOL_UPDATE_MILESTONE)).toBe(true);
    });

    it('should return preview when not executed from button', async () => {
      const tool = registeredTools.get(TOOL_UPDATE_MILESTONE);
      const result = await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        milestone_number: 1,
        title: 'Updated Title',
        _executeFromButton: false,
      });

      expect(octokit.issues.updateMilestone).not.toHaveBeenCalled();
      const parsed = parseResponse(result);
      expect(parsed.action).toBe('preview');
    });

    it('should update milestone when executed from button', async () => {
      const mockResult = {
        data: {
          number: 1,
          html_url: 'https://github.com/owner/repo/milestone/1',
          title: 'Updated Title',
          description: 'Updated description',
          state: 'open',
          due_on: '2024-04-01T00:00:00Z',
          open_issues: 3,
          closed_issues: 7,
          updated_at: '2024-01-15T00:00:00Z',
        },
      };

      vi.mocked(octokit.issues.updateMilestone).mockResolvedValueOnce(mockResult as never);

      const tool = registeredTools.get(TOOL_UPDATE_MILESTONE);
      const result = await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        milestone_number: 1,
        title: 'Updated Title',
        description: 'Updated description',
        due_on: '2024-04-01T00:00:00Z',
        _executeFromButton: true,
      });

      expect(octokit.issues.updateMilestone).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        milestone_number: 1,
        title: 'Updated Title',
        description: 'Updated description',
        due_on: '2024-04-01T12:00:00Z', // Normalized to noon UTC to avoid timezone issues
      });

      const parsed = parseResponse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.number).toBe(1);
      expect(parsed.title).toBe('Updated Title');
    });

    it('should only send provided fields in update', async () => {
      const mockResult = {
        data: {
          number: 1,
          html_url: 'https://github.com/owner/repo/milestone/1',
          title: 'Existing Title',
          description: 'Existing description',
          state: 'closed',
          due_on: null,
          open_issues: 0,
          closed_issues: 10,
          updated_at: '2024-01-15T00:00:00Z',
        },
      };

      vi.mocked(octokit.issues.updateMilestone).mockResolvedValueOnce(mockResult as never);

      const tool = registeredTools.get(TOOL_UPDATE_MILESTONE);
      await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        milestone_number: 1,
        state: 'closed',
        _executeFromButton: true,
      });

      // Should only include state, not title/description/due_on
      expect(octokit.issues.updateMilestone).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        milestone_number: 1,
        state: 'closed',
      });
    });

    it('should return error on API failure', async () => {
      vi.mocked(octokit.issues.updateMilestone).mockRejectedValueOnce(new Error('API Error'));

      const tool = registeredTools.get(TOOL_UPDATE_MILESTONE);
      const result = await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        milestone_number: 1,
        title: 'Test',
        _executeFromButton: true,
      });

      expect(result.isError).toBe(true);
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
    });
  });

  describe(TOOL_LIST_MILESTONES, () => {
    it('should register the tool', () => {
      expect(registeredTools.has(TOOL_LIST_MILESTONES)).toBe(true);
    });

    it('should return milestone list on success', async () => {
      const mockMilestones = {
        data: [
          {
            number: 1,
            title: 'v1.0',
            description: 'First release',
            state: 'open',
            html_url: 'https://github.com/owner/repo/milestone/1',
            due_on: '2024-03-01T00:00:00Z',
            open_issues: 5,
            closed_issues: 12,
            created_at: '2024-01-01T00:00:00Z',
            updated_at: '2024-01-15T00:00:00Z',
            closed_at: null,
          },
          {
            number: 2,
            title: 'v1.1',
            description: 'Feature release',
            state: 'open',
            html_url: 'https://github.com/owner/repo/milestone/2',
            due_on: '2024-06-01T00:00:00Z',
            open_issues: 10,
            closed_issues: 0,
            created_at: '2024-01-10T00:00:00Z',
            updated_at: '2024-01-15T00:00:00Z',
            closed_at: null,
          },
        ],
      };

      vi.mocked(octokit.issues.listMilestones).mockResolvedValueOnce(mockMilestones as never);

      const tool = registeredTools.get(TOOL_LIST_MILESTONES);
      const result = await tool!.handler({ owner: 'owner', repo: 'repo' });

      expect(result.isError).toBeUndefined();
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.milestones).toHaveLength(2);
      expect((parsed.milestones as Array<{ number: number }>)[0].number).toBe(1);
      expect((parsed.milestones as Array<{ progress_percent: number }>)[0].progress_percent).toBe(70.6);
      expect((parsed.milestones as Array<{ progress_percent: number }>)[1].progress_percent).toBe(0);
    });

    it('should pass filters to API', async () => {
      vi.mocked(octokit.issues.listMilestones).mockResolvedValueOnce({ data: [] } as never);

      const tool = registeredTools.get(TOOL_LIST_MILESTONES);
      await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        state: 'closed',
        sort: 'completeness',
        direction: 'desc',
        per_page: 50,
      });

      expect(octokit.issues.listMilestones).toHaveBeenCalledWith(
        expect.objectContaining({
          state: 'closed',
          sort: 'completeness',
          direction: 'desc',
          per_page: 50,
        })
      );
    });

    it('should use default values when not provided', async () => {
      vi.mocked(octokit.issues.listMilestones).mockResolvedValueOnce({ data: [] } as never);

      const tool = registeredTools.get(TOOL_LIST_MILESTONES);
      await tool!.handler({ owner: 'owner', repo: 'repo' });

      expect(octokit.issues.listMilestones).toHaveBeenCalledWith(
        expect.objectContaining({
          state: 'open',
          sort: 'due_on',
          direction: 'asc',
          per_page: 30,
          page: 1,
        })
      );
    });

    it('should return error on API failure', async () => {
      vi.mocked(octokit.issues.listMilestones).mockRejectedValueOnce(new Error('API Error'));

      const tool = registeredTools.get(TOOL_LIST_MILESTONES);
      const result = await tool!.handler({ owner: 'owner', repo: 'repo' });

      expect(result.isError).toBe(true);
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
    });
  });

  describe(TOOL_CLOSE_MILESTONE, () => {
    it('should register the tool', () => {
      expect(registeredTools.has(TOOL_CLOSE_MILESTONE)).toBe(true);
    });

    it('should return preview when not executed from button', async () => {
      const mockMilestone = {
        data: {
          title: 'v1.0 Release',
        },
      };

      vi.mocked(octokit.issues.getMilestone).mockResolvedValueOnce(mockMilestone as never);

      const tool = registeredTools.get(TOOL_CLOSE_MILESTONE);
      const result = await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        milestone_number: 1,
        _executeFromButton: false,
      });

      expect(octokit.issues.updateMilestone).not.toHaveBeenCalled();
      const parsed = parseResponse(result);
      expect(parsed.action).toBe('preview');
      expect((parsed.milestone as { title: string }).title).toBe('v1.0 Release');
    });

    it('should handle getMilestone failure gracefully in preview', async () => {
      vi.mocked(octokit.issues.getMilestone).mockRejectedValueOnce(new Error('Not found'));

      const tool = registeredTools.get(TOOL_CLOSE_MILESTONE);
      const result = await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        milestone_number: 1,
        _executeFromButton: false,
      });

      const parsed = parseResponse(result);
      expect(parsed.action).toBe('preview');
      // Should fallback to "Milestone #1"
      expect((parsed.milestone as { title: string }).title).toBe('Milestone #1');
    });

    it('should close milestone when executed from button', async () => {
      const mockResult = {
        data: {
          number: 1,
          html_url: 'https://github.com/owner/repo/milestone/1',
          title: 'v1.0 Release',
          state: 'closed',
          open_issues: 0,
          closed_issues: 15,
          closed_at: '2024-01-20T00:00:00Z',
        },
      };

      vi.mocked(octokit.issues.updateMilestone).mockResolvedValueOnce(mockResult as never);

      const tool = registeredTools.get(TOOL_CLOSE_MILESTONE);
      const result = await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        milestone_number: 1,
        _executeFromButton: true,
      });

      expect(octokit.issues.updateMilestone).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        milestone_number: 1,
        state: 'closed',
      });

      const parsed = parseResponse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.state).toBe('closed');
      expect(parsed.progress_percent).toBe(100);
    });

    it('should return error on API failure', async () => {
      vi.mocked(octokit.issues.updateMilestone).mockRejectedValueOnce(new Error('API Error'));

      const tool = registeredTools.get(TOOL_CLOSE_MILESTONE);
      const result = await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        milestone_number: 1,
        _executeFromButton: true,
      });

      expect(result.isError).toBe(true);
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
    });
  });

  describe('Progress Calculation', () => {
    it('should calculate 0% when no issues', async () => {
      const mockResult = {
        data: {
          number: 1,
          html_url: 'https://github.com/owner/repo/milestone/1',
          title: 'Empty Milestone',
          description: null,
          state: 'open',
          due_on: null,
          open_issues: 0,
          closed_issues: 0,
        },
      };

      vi.mocked(octokit.issues.createMilestone).mockResolvedValueOnce(mockResult as never);

      const tool = registeredTools.get(TOOL_CREATE_MILESTONE);
      const result = await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        title: 'Empty Milestone',
        _executeFromButton: true,
      });

      const parsed = parseResponse(result);
      expect(parsed.progress_percent).toBe(0);
    });

    it('should calculate 100% when all issues closed', async () => {
      const mockResult = {
        data: {
          number: 1,
          html_url: 'https://github.com/owner/repo/milestone/1',
          title: 'Complete Milestone',
          description: null,
          state: 'closed',
          due_on: null,
          open_issues: 0,
          closed_issues: 20,
        },
      };

      vi.mocked(octokit.issues.createMilestone).mockResolvedValueOnce(mockResult as never);

      const tool = registeredTools.get(TOOL_CREATE_MILESTONE);
      const result = await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        title: 'Complete Milestone',
        _executeFromButton: true,
      });

      const parsed = parseResponse(result);
      expect(parsed.progress_percent).toBe(100);
    });

    it('should round to one decimal place', async () => {
      const mockResult = {
        data: {
          number: 1,
          html_url: 'https://github.com/owner/repo/milestone/1',
          title: 'In Progress',
          description: null,
          state: 'open',
          due_on: null,
          open_issues: 3,
          closed_issues: 7,
        },
      };

      vi.mocked(octokit.issues.createMilestone).mockResolvedValueOnce(mockResult as never);

      const tool = registeredTools.get(TOOL_CREATE_MILESTONE);
      const result = await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        title: 'In Progress',
        _executeFromButton: true,
      });

      const parsed = parseResponse(result);
      // 7 / 10 * 100 = 70.0
      expect(parsed.progress_percent).toBe(70);
    });
  });
});
