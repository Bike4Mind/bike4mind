import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

vi.mock('../../../../apiKeyService', () => ({
  getSerperKey: vi.fn(),
  getSearxngUrl: vi.fn(),
  getWebSearchProviderSetting: vi.fn(),
}));

import { getSerperKey, getSearxngUrl, getWebSearchProviderSetting } from '../../../../apiKeyService';
import { createSearxngProvider, createSerpApiProvider, resolveWebSearchProvider } from './providers';

const mockGetSerperKey = vi.mocked(getSerperKey);
const mockGetSearxngUrl = vi.mocked(getSearxngUrl);
const mockGetProvider = vi.mocked(getWebSearchProviderSetting);
const adapters = {} as Parameters<typeof resolveWebSearchProvider>[0];

function jsonRes(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Service Unavailable',
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const fetchMock = vi.fn();
const realFetch = globalThis.fetch;
vi.stubGlobal('fetch', fetchMock);
afterAll(() => {
  vi.stubGlobal('fetch', realFetch);
});

beforeEach(() => {
  fetchMock.mockReset();
  mockGetSerperKey.mockReset();
  mockGetSearxngUrl.mockReset();
  mockGetProvider.mockReset();
});

describe('createSearxngProvider', () => {
  it('parses results[].{title,url,content} and queries the JSON endpoint', async () => {
    fetchMock.mockResolvedValue(
      jsonRes({
        results: [
          { url: 'https://a.com', title: 'A', content: 'about a' },
          { url: 'https://b.com', title: 'B', content: 'about b' },
        ],
      })
    );

    const results = await createSearxngProvider('http://searxng:8080').search('cats', 5);

    expect(results).toEqual([
      { title: 'A', url: 'https://a.com', snippet: 'about a' },
      { title: 'B', url: 'https://b.com', snippet: 'about b' },
    ]);
    const calledUrl = String(fetchMock.mock.calls[0][0]);
    expect(calledUrl).toContain('http://searxng:8080/search');
    expect(calledUrl).toContain('format=json');
    expect(calledUrl).toContain('q=cats');
  });

  it('trims a trailing slash on the base URL', async () => {
    fetchMock.mockResolvedValue(jsonRes({ results: [] }));
    await createSearxngProvider('http://searxng:8080/').search('q');
    expect(String(fetchMock.mock.calls[0][0])).toContain('http://searxng:8080/search');
  });

  it('returns [] on a malformed body (results missing or not an array)', async () => {
    fetchMock.mockResolvedValue(jsonRes({ nope: true }));
    expect(await createSearxngProvider('http://s').search('q')).toEqual([]);
  });

  it('skips entries without a url and non-object entries', async () => {
    fetchMock.mockResolvedValue(jsonRes({ results: [{ title: 'no url' }, 42, null] }));
    expect(await createSearxngProvider('http://s').search('q')).toEqual([]);
  });

  it('returns [] when the request fails/aborts', async () => {
    fetchMock.mockRejectedValue(new Error('The operation was aborted'));
    expect(await createSearxngProvider('http://s').search('q')).toEqual([]);
  });

  it('returns [] on a non-OK response', async () => {
    fetchMock.mockResolvedValue(jsonRes({}, false, 503));
    expect(await createSearxngProvider('http://s').search('q')).toEqual([]);
  });

  it('caps results to numResults (default 3)', async () => {
    const results = Array.from({ length: 6 }, (_, i) => ({ url: `https://r${i}.com` }));
    fetchMock.mockResolvedValue(jsonRes({ results }));
    expect((await createSearxngProvider('http://s').search('q', 2)).length).toBe(2);
    fetchMock.mockResolvedValue(jsonRes({ results }));
    expect((await createSearxngProvider('http://s').search('q')).length).toBe(3);
  });
});

describe('createSerpApiProvider', () => {
  it('maps organic_results[].{title,link,snippet} and drops entries without a link', async () => {
    mockGetSerperKey.mockResolvedValue('serp-key');
    fetchMock.mockResolvedValue(
      jsonRes({
        organic_results: [{ title: 'T', link: 'https://x.com', snippet: 'snip' }, { title: 'no link' }],
      })
    );

    const results = await createSerpApiProvider(adapters).search('q', 3);

    expect(results).toEqual([{ title: 'T', url: 'https://x.com', snippet: 'snip' }]);
    expect(String(fetchMock.mock.calls[0][0])).toContain('serpapi.com/search');
  });
});

describe('resolveWebSearchProvider precedence', () => {
  it('forces SearXNG when the admin choice is searxng and a URL is set', async () => {
    mockGetProvider.mockResolvedValue('searxng');
    mockGetSearxngUrl.mockResolvedValue('http://searxng:8080');
    mockGetSerperKey.mockResolvedValue(null);
    expect((await resolveWebSearchProvider(adapters))?.name).toBe('searxng');
  });

  it('returns null when searxng is forced but no URL is configured', async () => {
    mockGetProvider.mockResolvedValue('searxng');
    mockGetSearxngUrl.mockResolvedValue(null);
    mockGetSerperKey.mockResolvedValue('serp-key'); // present but must be ignored
    expect(await resolveWebSearchProvider(adapters)).toBeNull();
  });

  it('forces SerpAPI when the admin choice is serpapi and a key is set', async () => {
    mockGetProvider.mockResolvedValue('serpapi');
    mockGetSerperKey.mockResolvedValue('serp-key');
    mockGetSearxngUrl.mockResolvedValue('http://searxng:8080'); // present but must be ignored
    expect((await resolveWebSearchProvider(adapters))?.name).toBe('serpapi');
  });

  it('returns null when serpapi is forced but no key is configured', async () => {
    mockGetProvider.mockResolvedValue('serpapi');
    mockGetSerperKey.mockResolvedValue(null);
    mockGetSearxngUrl.mockResolvedValue('http://searxng:8080');
    expect(await resolveWebSearchProvider(adapters)).toBeNull();
  });

  it('auto: prefers SearXNG when a URL is configured', async () => {
    mockGetProvider.mockResolvedValue(null); // unset -> auto
    mockGetSearxngUrl.mockResolvedValue('http://searxng:8080');
    mockGetSerperKey.mockResolvedValue('serp-key');
    expect((await resolveWebSearchProvider(adapters))?.name).toBe('searxng');
  });

  it('auto: falls back to SerpAPI when only a Serper key is set', async () => {
    mockGetProvider.mockResolvedValue('auto');
    mockGetSearxngUrl.mockResolvedValue(null);
    mockGetSerperKey.mockResolvedValue('serp-key');
    expect((await resolveWebSearchProvider(adapters))?.name).toBe('serpapi');
  });

  it('auto: returns null when neither is configured', async () => {
    mockGetProvider.mockResolvedValue(null);
    mockGetSearxngUrl.mockResolvedValue(null);
    mockGetSerperKey.mockResolvedValue(null);
    expect(await resolveWebSearchProvider(adapters)).toBeNull();
  });
});
