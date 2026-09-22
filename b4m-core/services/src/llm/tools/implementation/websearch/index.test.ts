import { describe, it, expect, vi } from 'vitest';
import { verifyImageUrlSignature } from '@bike4mind/common';
import {
  safeHostname,
  serpApiSearch,
  performWebSearch,
  shouldIncludeImages,
  formatImageResults,
  WEB_SEARCH_NOT_CONFIGURED_MSG,
} from './index';

const TEST_SECRET = 'websearch-index-test-secret';

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

  // A plain web search frequently carries NO usable images, so the dedicated image search is where
  // nearly every picture comes from - ignoring it here would gate the cards off on exactly the
  // visual queries the feature exists for.
  it('counts the dedicated image search, so pictures still show when no hit carries a thumbnail', () => {
    const image = (url: string) => ({ url, pageUrl: 'https://p.com/a', title: 't', source: 'p.com' });

    expect(shouldIncludeImages([hit(), hit()], true, [image('https://i/1.jpg')])).toBe(false);
    expect(shouldIncludeImages([hit(), hit()], true, [image('https://i/1.jpg'), image('https://i/2.jpg')])).toBe(true);
    expect(shouldIncludeImages([hit(), hit()], false, [image('https://i/1.jpg'), image('https://i/2.jpg')])).toBe(
      false
    );
  });
});

describe('formatImageResults', () => {
  it('gives each picture its own page and publisher, so a card can attribute it correctly', () => {
    const output = formatImageResults(
      [{ url: 'https://cdn.a.com/x.jpg', pageUrl: 'https://a.com/post', title: 'A Watch', source: 'Alpha' }],
      TEST_SECRET
    );

    expect(output).toContain('image: https://cdn.a.com/x.jpg');
    expect(output).toContain('source: Alpha');
    expect(output).toContain('page: https://a.com/post');
  });

  // A substring check against the unsigned prefix would still pass if `signImageUrl` were dropped
  // from this function entirely - the real proxy would then reject every image at runtime. Assert
  // the URL actually verifies, and against the RIGHT secret specifically.
  it('signs the image URL with the secret it was given, not left unsigned or signed with anything else', () => {
    const output = formatImageResults(
      [{ url: 'https://cdn.a.com/x.jpg', pageUrl: 'https://a.com/post', title: 'A Watch', source: 'Alpha' }],
      TEST_SECRET
    );
    const signedUrl = /image: (\S+)/.exec(output)?.[1];

    expect(signedUrl).toBeDefined();
    expect(signedUrl).not.toBe('https://cdn.a.com/x.jpg');
    expect(verifyImageUrlSignature(signedUrl!, TEST_SECRET)).toBe(true);
    expect(verifyImageUrlSignature(signedUrl!, 'a-different-secret')).toBe(false);
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

  // Deleting the `imageUrlSigningSecret` threading anywhere in this chain (the tool's toolFn, the
  // config passed to `generateTools`, or the signing call itself) would leave the substring checks
  // above green while every card tile fails verification at the real proxy - this is the assertion
  // that actually exercises the thing the proxy checks.
  it('signs every URL on the Images: line with the secret it was given', async () => {
    useSerpApi();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(serpResponse(twoImageHits)));

    const result = await performWebSearch(mockAdapters, { query: 'q', include_images: true }, TEST_SECRET);

    // One "Images:" line per organic result (twoImageHits carries one thumbnail each).
    const imageLines = result.formattedResults.split('\n').filter(line => line.startsWith('Images: '));
    expect(imageLines).toHaveLength(2);
    const signedUrls = imageLines.map(line => line.replace('Images: ', ''));
    for (const url of signedUrls) {
      expect(verifyImageUrlSignature(url, TEST_SECRET)).toBe(true);
      expect(verifyImageUrlSignature(url, 'a-different-secret')).toBe(false);
    }
    vi.unstubAllGlobals();
  });

  // A visual query with a real image cluster but zero organic hits - the dedicated image search
  // runs independently of the organic search, so this combination is real, not hypothetical.
  // formattedOutput used to be gated as a whole on the organic-hits string being non-empty, which
  // threw away a genuine image cluster (and the cards prompt telling the model how to use it) any
  // time organic search came back empty.
  it('still surfaces images and the cards prompt when organic search returns zero results', async () => {
    useSerpApi();
    const imagesResponse = {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        images_results: [
          { original: 'https://img/only.jpg', link: 'https://only.com/post', title: 'Only', source: 'only.com' },
          { original: 'https://img/other.jpg', link: 'https://other.com/post', title: 'Other', source: 'other.com' },
        ],
      }),
      text: async () => '',
    } as unknown as Response;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => (url.includes('engine=google_images') ? imagesResponse : serpResponse([])))
    );

    const result = await performWebSearch(mockAdapters, { query: 'q', include_images: true }, TEST_SECRET);

    expect(result.formattedResults).not.toBe('No results found from web search.');
    expect(result.formattedResults).toContain('image: ');
    expect(result.formattedResults).toContain('b4m_cards');
    const imageUrl = /image: (\S+)/.exec(result.formattedResults)?.[1];
    expect(verifyImageUrlSignature(imageUrl!, TEST_SECRET)).toBe(true);
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
