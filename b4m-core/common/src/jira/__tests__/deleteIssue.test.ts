import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JiraApi } from '../api';
import type { JiraConfig } from '../api';

describe('JiraApi deleteIssue', () => {
  let mockConfig: JiraConfig;
  let jiraApi: JiraApi;

  beforeEach(() => {
    mockConfig = {
      accessToken: 'test-token',
      cloudId: 'test-cloud-id',
      siteUrl: 'https://test.atlassian.net',
      webBaseUrl: 'https://test.atlassian.net/browse',
      apiBaseUrl: 'https://api.atlassian.com/ex/jira/test-cloud-id/rest/api/3',
      authHeader: 'Bearer test-token',
    };
    jiraApi = new JiraApi(mockConfig);
  });

  describe('Input Validation', () => {
    it('should throw error when issueKey is missing', async () => {
      await expect(jiraApi.deleteIssue({ issueKey: '' })).rejects.toThrow('issueKey is required to delete an issue.');
    });

    it('should throw error when issueKey is undefined', async () => {
      await expect(jiraApi.deleteIssue({ issueKey: undefined as any })).rejects.toThrow(
        'issueKey is required to delete an issue.'
      );
    });

    it('should throw error when issueKey is null', async () => {
      await expect(jiraApi.deleteIssue({ issueKey: null as any })).rejects.toThrow(
        'issueKey is required to delete an issue.'
      );
    });
  });

  describe('Valid Input Handling', () => {
    beforeEach(() => {
      global.fetch = vi.fn();
    });

    it('should call DELETE endpoint with valid issueKey', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 204,
        text: async () => '',
      } as Response);

      await jiraApi.deleteIssue({ issueKey: 'PROJ-123' });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const callArgs = mockFetch.mock.calls[0];
      expect(callArgs[0]).toContain('/issue/PROJ-123');
      expect(callArgs[1]?.method).toBe('DELETE');
    });

    it('should handle API error responses', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () => 'Issue not found',
      } as Response);

      await expect(jiraApi.deleteIssue({ issueKey: 'NONEXISTENT-999' })).rejects.toThrow('Jira API error (404)');
    });

    it('should accept issueKey with various formats', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
      mockFetch.mockResolvedValue({
        ok: true,
        status: 204,
        text: async () => '',
      } as Response);

      const validKeys = ['PROJ-1', 'ABC-999', 'TEST-12345'];

      for (const key of validKeys) {
        await jiraApi.deleteIssue({ issueKey: key });
        expect(mockFetch).toHaveBeenCalled();
      }
    });
  });

  describe('Security & Safety', () => {
    it('should only delete the specified issue', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 204,
        text: async () => '',
      } as Response);
      global.fetch = mockFetch;

      await jiraApi.deleteIssue({ issueKey: 'PROJ-123' });

      // Verify the exact endpoint was called with the specific issue key
      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain('/issue/PROJ-123');
      expect(url).toMatch(/\/issue\/PROJ-123(\?|$)/); // Ensure it ends with the issue key (or query params)
      expect(mockFetch.mock.calls[0][1]?.method).toBe('DELETE');
    });
  });
});
