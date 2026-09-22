import { describe, it, expect, vi } from 'vitest';
import {
  safeHostname,
  serpApiSearch,
  performWebSearch,
  shouldIncludeImages,
  WEB_SEARCH_NOT_CONFIGURED_MSG,
} from './index';

vi.mock('../../../../apiKeyService', () => ({
  getSerperKey: vi.fn(),
  getSearxngUrl: vi.fn(),
  getWebSearchProviderSetting: vi.fn(),
}));

import { getSerperKey, getSearxngUrl, getWebSearchProviderSetting } from '../../../../apiKeyService';

const mockGetSerperKey = vi.mocked(getSerperKey);
const mockGetSearxngUrl = vi.mocked(getSearxngUrl);
const mockGetProvider = vi.mocked(getWebSearchProviderSetting);
const mockAdapters = {} as Parameters<typeof serpApiSearch>[0];

describe('serpApiSearch — missing key', () => {
  it('returns an object with empty organic_results when no API key is configured', async () => {
    mockGetSerperKey.mockResolvedValue(null);

    const result = await serpApiSearch(mockAdapters, 'test query');

    expect(result).toEqual({ organic_results: [] });
  });
});

describe('performWebSearch - no provider configured', () => {
  it('returns a clear not-configured message and empty citables when no provider resolves', async () => {
    mockGetSerperKey.mockResolvedValue(null);
    mockGetSearxngUrl.mockResolvedValue(null);
    mockGetProvider.mockResolvedValue(null);

    const result = await performWebSearch(mockAdapters, { query: 'test query' });

    expect(result.formattedResults).toBe(WEB_SEARCH_NOT_CONFIGURED_MSG);
    expect(result.citables).toEqual([]);
  });
});

describe('safeHostname', () => {
  it('extracts the hostname from a valid absolute URL', () => {
    expect(safeHostname('https://example.com/path?q=1')).toBe('example.com');
  });

  it('returns the raw input when the URL is invalid (e.g. SerpAPI redirect path)', () => {
    const relative = '/goto?url=https%3A%2F%2Fexample.com%2F';
    expect(safeHostname(relative)).toBe(relative);
  });
});

describe('shouldIncludeImages', () => {
  const hit = (thumbnail?: string) => ({ title: 't', url: 'https://x.com', snippet: 's', thumbnail });

  it('is false when the model did not ask, however many thumbnails came back', () => {
    expect(shouldIncludeImages([hit('https://i/1.jpg'), hit('https://i/2.jpg')], undefined)).toBe(false);
    expect(shouldIncludeImages([hit('https://i/1.jpg'), hit('https://i/2.jpg')], false)).toBe(false);
  });

  it('is false when the model asked but only one hit carries a picture', () => {
    expect(shouldIncludeImages([hit('https://i/1.jpg'), hit()], true)).toBe(false);
  });

  it('is true once the model asked and a real cluster of pictures came back', () => {
    expect(shouldIncludeImages([hit('https://i/1.jpg'), hit('https://i/2.jpg'), hit()], true)).toBe(true);
  });
});

describe('performWebSearch - image handling', () => {
  const serpResponse = (organic: unknown[]) =>
    ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ organic_results: organic }),
      text: async () => '',
    }) as unknown as Response;

  const twoImageHits = [
    { title: 'A', link: 'https://a.com', snippet: 'about a', thumbnail: 'https://img/a.jpg' },
    { title: 'B', link: 'https://b.com', snippet: 'about b', thumbnail: 'https://img/b.jpg' },
  ];

  const useSerpApi = () => {
    mockGetSerperKey.mockResolvedValue('serp-key');
    mockGetSearxngUrl.mockResolvedValue(null);
    mockGetProvider.mockResolvedValue('serpapi');
  };

  it('leaves the model-facing output untouched when include_images is unset', async () => {
    useSerpApi();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(serpResponse(twoImageHits)));

    const result = await performWebSearch(mockAdapters, { query: 'q' });

    expect(result.formattedResults).not.toContain('Images:');
    expect(result.formattedResults).not.toContain('https://img/a.jpg');
    expect(result.formattedResults).not.toContain('b4m_cards');
    vi.unstubAllGlobals();
  });

  it('still attaches thumbnails to the citables so the sources panel can use them later', async () => {
    useSerpApi();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(serpResponse(twoImageHits)));

    const result = await performWebSearch(mockAdapters, { query: 'q' });

    expect(result.citables[0].metadata).toMatchObject({ thumbnail: 'https://img/a.jpg' });
    vi.unstubAllGlobals();
  });

  it('adds image lines and the card instructions when include_images is set', async () => {
    useSerpApi();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(serpResponse(twoImageHits)));

    const result = await performWebSearch(mockAdapters, { query: 'q', include_images: true });

    expect(result.formattedResults).toContain('Images: https://img/a.jpg');
    expect(result.formattedResults).toContain('b4m_cards');
    vi.unstubAllGlobals();
  });

  it('withholds images when include_images is set but the provider returned almost none', async () => {
    useSerpApi();
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(serpResponse([twoImageHits[0], { title: 'B', link: 'https://b.com', snippet: 'about b' }]))
    );

    const result = await performWebSearch(mockAdapters, { query: 'q', include_images: true });

    expect(result.formattedResults).not.toContain('Images:');
    expect(result.formattedResults).not.toContain('b4m_cards');
    vi.unstubAllGlobals();
  });
});
