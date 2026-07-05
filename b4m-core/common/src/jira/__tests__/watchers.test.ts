import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JiraApi } from '../api';
import type { JiraConfig } from '../api';

describe('JiraApi Watcher Operations', () => {
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
    global.fetch = vi.fn();
  });

  describe('getWatchers', () => {
    it('should call GET endpoint and format response', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
      const mockResponse = {
        self: 'https://api.atlassian.com/...',
        isWatching: false,
        watchCount: 1,
        watchers: [
          {
            self: 'https://api.atlassian.com/...',
            accountId: '12345',
            displayName: 'Test User',
            active: true,
          },
        ],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockResponse,
      } as Response);

      const result = await jiraApi.getWatchers({ issueKey: 'PROJ-123' });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const callArgs = mockFetch.mock.calls[0];
      expect(callArgs[0]).toContain('/issue/PROJ-123/watchers');
      expect(callArgs[1]?.method).toBe('GET');

      expect(result).toEqual({
        isWatching: false,
        watchCount: 1,
        watchers: [
          {
            accountId: '12345',
            displayName: 'Test User',
            active: true,
          },
        ],
      });
    });
  });

  describe('addWatcher', () => {
    it('should call POST endpoint with accountId as body', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 204,
        text: async () => '',
      } as Response);

      await jiraApi.addWatcher({ issueKey: 'PROJ-123', accountId: '12345' });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const callArgs = mockFetch.mock.calls[0];
      expect(callArgs[0]).toContain('/issue/PROJ-123/watchers');
      expect(callArgs[1]?.method).toBe('POST');
      expect(callArgs[1]?.body).toBe('"12345"'); // JSON string of the accountId
    });
  });

  describe('removeWatcher', () => {
    it('should call DELETE endpoint with accountId query param', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 204,
        text: async () => '',
      } as Response);

      await jiraApi.removeWatcher({ issueKey: 'PROJ-123', accountId: '12345' });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const callArgs = mockFetch.mock.calls[0];
      expect(callArgs[0]).toContain('/issue/PROJ-123/watchers');
      expect(callArgs[0]).toContain('accountId=12345');
      expect(callArgs[1]?.method).toBe('DELETE');
    });
  });
});
