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

  describe('issue key handling in watcher paths', () => {
    it('encodes the issue key as a single path segment', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 204,
        headers: new Headers(),
        text: async () => '',
      } as Response);

      await jiraApi.addWatcher({ issueKey: 'PROJ-1/comment', accountId: 'acc-1' });

      expect(mockFetch.mock.calls[0][0]).toContain('/issue/PROJ-1%2Fcomment/watchers');
    });

    it.each(['PROJ-1?x=', 'PROJ-1#', '%2e%2e'])('keeps issue key %s inside one encoded segment', async issueKey => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 204,
        headers: new Headers(),
        text: async () => '',
      } as Response);

      await jiraApi.removeWatcher({ issueKey, accountId: 'acc-1' });

      const url = new URL(mockFetch.mock.calls[0][0]);
      expect(url.pathname.endsWith(`/issue/${encodeURIComponent(issueKey)}/watchers`)).toBe(true);
      expect(url.hash).toBe('');
      expect([...url.searchParams.keys()]).toEqual(['accountId']);
    });

    it.each(['addWatcher', 'removeWatcher'] as const)(
      '%s rejects a dot-segment issue key without sending a request',
      async method => {
        const mockFetch = global.fetch as ReturnType<typeof vi.fn>;

        await expect(jiraApi[method]({ issueKey: '..', accountId: 'acc-1' })).rejects.toThrow('Invalid API path');
        expect(mockFetch).not.toHaveBeenCalled();
      }
    );

    it('keeps a multi-segment issue key inside one segment on other issue endpoints', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 204,
        headers: new Headers(),
        text: async () => '',
      } as Response);

      await jiraApi.deleteIssue({ issueKey: 'PROJ-1/comment/10001' });

      const [url, init] = mockFetch.mock.calls[0];
      expect(new URL(url).pathname.endsWith('/issue/PROJ-1%2Fcomment%2F10001')).toBe(true);
      expect(init.method).toBe('DELETE');
    });
  });
});
