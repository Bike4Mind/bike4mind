import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConfluenceApi, isValidConfluencePageId } from '../api';
import type { ConfluenceConfig } from '../api';

describe('isValidConfluencePageId', () => {
  it('accepts numeric ids only', () => {
    expect(isValidConfluencePageId('123456')).toBe(true);
    expect(isValidConfluencePageId('123/../../x')).toBe(false);
    expect(isValidConfluencePageId('123?foo=bar')).toBe(false);
    expect(isValidConfluencePageId('12 3')).toBe(false);
    expect(isValidConfluencePageId('123\n')).toBe(false);
    expect(isValidConfluencePageId('')).toBe(false);
  });
});

describe('ConfluenceApi getPageStorage', () => {
  let confluenceApi: ConfluenceApi;

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
    global.fetch = vi.fn();
  });

  it('requests the storage body format and returns title, version and storage', async () => {
    const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () =>
        JSON.stringify({ id: '42', title: 'T', version: { number: 7 }, body: { storage: { value: '<p>x</p>' } } }),
      json: async () => ({ id: '42', title: 'T', version: { number: 7 }, body: { storage: { value: '<p>x</p>' } } }),
    });

    const result = await confluenceApi.getPageStorage({ pageId: '42' });

    expect(result).toEqual({ title: 'T', version: 7, storage: '<p>x</p>' });
    const url = String(mockFetch.mock.calls[0][0]);
    expect(url).toContain('/pages/42');
    expect(url).toContain('body-format=storage');
  });

  it('throws when the version is missing', async () => {
    const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
    const body = { id: '42', title: 'T' };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify(body),
      json: async () => body,
    });

    await expect(confluenceApi.getPageStorage({ pageId: '42' })).rejects.toThrow('current version');
  });
});
