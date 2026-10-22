import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConfluenceApi } from '../api';
import type { ConfluenceConfig } from '../api';

const jsonResponse = (body: unknown) => ({
  ok: true,
  status: 200,
  headers: new Headers({ 'content-type': 'application/json' }),
  text: async () => JSON.stringify(body),
  json: async () => body,
});

describe('ConfluenceApi updatePage', () => {
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

  it('refetches the current version when no expectedVersion is given', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ id: '42', title: 'Old', version: { number: 5 } }))
      .mockResolvedValueOnce(jsonResponse({ id: '42', title: 'Old', version: { number: 6 } }));

    await confluenceApi.updatePage({ pageId: '42', content: '<p>x</p>' });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const [, putInit] = mockFetch.mock.calls[1];
    expect(putInit.method).toBe('PUT');
    expect(JSON.parse(putInit.body).version.number).toBe(6);
  });

  it('skips the refetch and writes expectedVersion + 1 when expectedVersion is given', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ id: '42', title: 'T', version: { number: 4 } }));

    await confluenceApi.updatePage({ pageId: '42', title: 'T', content: '<p>x</p>', expectedVersion: 3 });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, putInit] = mockFetch.mock.calls[0];
    expect(putInit.method).toBe('PUT');
    const payload = JSON.parse(putInit.body);
    expect(payload.version.number).toBe(4);
    expect(payload.title).toBe('T');
  });

  it('requires a title when expectedVersion is given', async () => {
    await expect(confluenceApi.updatePage({ pageId: '42', content: '<p>x</p>', expectedVersion: 3 })).rejects.toThrow(
      'title is required'
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
