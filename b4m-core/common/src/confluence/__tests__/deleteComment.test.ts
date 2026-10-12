import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConfluenceApi } from '../api';
import type { ConfluenceConfig } from '../api';

const notFound = () =>
  ({
    ok: false,
    status: 404,
    statusText: 'Not Found',
    headers: new Headers({ 'content-type': 'application/json' }),
    text: async () => JSON.stringify({ message: 'Not found' }),
  }) as Response;

const okJson = (body: unknown) =>
  ({
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    text: async () => JSON.stringify(body),
    json: async () => body,
  }) as Response;

const noContent = () => ({ ok: true, status: 204, headers: new Headers(), text: async () => '' }) as Response;

describe('ConfluenceApi deleteComment', () => {
  let confluenceApi: ConfluenceApi;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    const config: ConfluenceConfig = {
      accessToken: 'test-token',
      cloudId: 'test-cloud-id',
      siteUrl: 'https://test.atlassian.net/wiki',
      webBaseUrl: 'https://test.atlassian.net/wiki',
      apiBaseUrlV1: 'https://test.atlassian.net/wiki/rest/api',
      apiBaseUrlV2: 'https://api.atlassian.com/ex/confluence/test-cloud-id/wiki/api/v2',
      authHeader: 'Bearer test-token',
    };
    confluenceApi = new ConfluenceApi(config);
    mockFetch = vi.fn();
    global.fetch = mockFetch;
  });

  it('deletes a footer comment through v2 without reaching the v1 fallback', async () => {
    mockFetch.mockResolvedValueOnce(noContent());

    await confluenceApi.deleteComment({ commentId: '42' });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toContain('/footer-comments/42');
  });

  it('falls back to v1 delete once the id is confirmed to be a comment', async () => {
    mockFetch
      .mockResolvedValueOnce(notFound())
      .mockResolvedValueOnce(notFound())
      .mockResolvedValueOnce(okJson({ id: '42', type: 'comment' }))
      .mockResolvedValueOnce(noContent());

    await confluenceApi.deleteComment({ commentId: '42' });

    expect(mockFetch).toHaveBeenCalledTimes(4);
    const [lookupUrl, lookupInit] = mockFetch.mock.calls[2];
    expect(lookupUrl).toBe('https://test.atlassian.net/wiki/rest/api/content/42');
    expect(lookupInit.method).toBe('GET');
    const [deleteUrl, deleteInit] = mockFetch.mock.calls[3];
    expect(deleteUrl).toBe('https://test.atlassian.net/wiki/rest/api/content/42');
    expect(deleteInit.method).toBe('DELETE');
  });

  it.each(['page', 'attachment', 'blogpost'])('refuses the v1 delete when the content is a %s', async type => {
    mockFetch
      .mockResolvedValueOnce(notFound())
      .mockResolvedValueOnce(notFound())
      .mockResolvedValueOnce(okJson({ id: '42', type }));

    await expect(confluenceApi.deleteComment({ commentId: '42' })).rejects.toThrow('is not a comment');

    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(mockFetch.mock.calls[2][1].method).toBe('GET');
  });
});
