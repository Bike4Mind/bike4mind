import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConfluenceApi } from '../api';
import type { ConfluenceConfig } from '../api';

describe('ConfluenceApi deletePage', () => {
  let mockConfig: ConfluenceConfig;
  let confluenceApi: ConfluenceApi;

  beforeEach(() => {
    mockConfig = {
      accessToken: 'test-token',
      cloudId: 'test-cloud-id',
      siteUrl: 'https://test.atlassian.net/wiki',
      webBaseUrl: 'https://test.atlassian.net/wiki',
      apiBaseUrlV1: 'https://test.atlassian.net/wiki/rest/api',
      apiBaseUrlV2: 'https://api.atlassian.com/ex/confluence/test-cloud-id/wiki/api/v2',
      authHeader: 'Bearer test-token',
    };
    confluenceApi = new ConfluenceApi(mockConfig);
  });

  describe('Input Validation', () => {
    it('should throw error when pageId is missing', async () => {
      await expect(confluenceApi.deletePage({ pageId: '' })).rejects.toThrow('pageId is required to delete a page.');
    });

    it('should throw error when pageId is undefined', async () => {
      await expect(confluenceApi.deletePage({ pageId: undefined as any })).rejects.toThrow(
        'pageId is required to delete a page.'
      );
    });

    it('should throw error when pageId is null', async () => {
      await expect(confluenceApi.deletePage({ pageId: null as any })).rejects.toThrow(
        'pageId is required to delete a page.'
      );
    });
  });

  describe('Valid Input Handling', () => {
    beforeEach(() => {
      // Mock the global fetch for these tests
      global.fetch = vi.fn();
    });

    it('should call DELETE endpoint with valid pageId', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 204,
        headers: {
          get: () => 'application/json',
        },
        text: async () => '',
      } as any);

      await confluenceApi.deletePage({ pageId: '123456' });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const callArgs = mockFetch.mock.calls[0];
      expect(callArgs[0]).toContain('/pages/123456');
      expect(callArgs[1]?.method).toBe('DELETE');
    });

    it('should handle API error responses', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () => JSON.stringify({ message: 'Page not found' }),
      } as any);

      await expect(confluenceApi.deletePage({ pageId: '999999' })).rejects.toThrow('Confluence API Error 404');
    });

    it('should accept pageId with various numeric formats', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
      mockFetch.mockResolvedValue({
        ok: true,
        status: 204,
        headers: {
          get: () => 'application/json',
        },
        text: async () => '',
      } as any);

      const validIds = ['1', '123', '999999', '123456789'];

      for (const id of validIds) {
        await confluenceApi.deletePage({ pageId: id });
        expect(mockFetch).toHaveBeenCalled();
      }
    });
  });

  describe('Security & Safety', () => {
    it('should only delete the specified page', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 204,
        headers: {
          get: () => 'application/json',
        },
        text: async () => '',
      } as any);
      global.fetch = mockFetch;

      await confluenceApi.deletePage({ pageId: '123456' });

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain('/pages/123456');
      expect(mockFetch.mock.calls[0][1]?.method).toBe('DELETE');
    });

    it('should handle 403 Forbidden errors with helpful message', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () => JSON.stringify({ message: 'Insufficient permissions' }),
      } as any);

      await expect(confluenceApi.deletePage({ pageId: '123456' })).rejects.toThrow('Confluence API returned 403');
    });
  });
});
