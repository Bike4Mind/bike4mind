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

  it('maps img_src / thumbnail_src into thumbnail + images', async () => {
    fetchMock.mockResolvedValue(
      jsonRes({
        results: [
          {
            url: 'https://a.com',
            title: 'A',
            content: 'about a',
            img_src: 'https://img/a.jpg',
            thumbnail_src: 'https://img/a-small.jpg',
          },
          { url: 'https://b.com', title: 'B', content: 'about b' },
        ],
      })
    );

    const results = await createSearxngProvider('http://searxng:8080').search('cats', 5);

    expect(results[0]).toMatchObject({
      thumbnail: 'https://img/a.jpg',
      images: ['https://img/a.jpg', 'https://img/a-small.jpg'],
    });
    expect(results[1].thumbnail).toBeUndefined();
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

  it('carries organic thumbnails through as thumbnail + images', async () => {
    mockGetSerperKey.mockResolvedValue('serp-key');
    fetchMock.mockResolvedValue(
      jsonRes({
        organic_results: [{ title: 'T', link: 'https://x.com', snippet: 'snip', thumbnail: 'https://img/x.jpg' }],
      })
    );

    const results = await createSerpApiProvider(adapters).search('q', 3);

    expect(results[0]).toMatchObject({ thumbnail: 'https://img/x.jpg', images: ['https://img/x.jpg'] });
  });

  // `inline_images` names the owning page `source`, NOT `link` - reading `link` here matched
  // nothing against a live SerpAPI response, so every inline image was silently discarded.
  it('attaches inline_images by their `source` page and shopping_results by their `link`', async () => {
    mockGetSerperKey.mockResolvedValue('serp-key');
    fetchMock.mockResolvedValue(
      jsonRes({
        organic_results: [
          { title: 'A', link: 'https://a.com/p', snippet: '' },
          { title: 'B', link: 'https://b.com/p', snippet: '' },
        ],
        inline_images: [{ source: 'https://a.com/p', original: 'https://img/a1.jpg', thumbnail: 'https://tbn/a1.jpg' }],
        shopping_results: [
          { link: 'https://a.com/p', original: 'https://img/a2.jpg' },
          // Same host, different path: must NOT be borrowed by https://b.com/p.
          { link: 'https://b.com/other', thumbnail: 'https://img/wrong.jpg' },
        ],
      })
    );

    const results = await createSerpApiProvider(adapters).search('q', 3);

    expect(results[0].images).toEqual(['https://img/a1.jpg', 'https://img/a2.jpg']);
    expect(results[1].images).toBeUndefined();
    expect(results[1].thumbnail).toBeUndefined();
  });

  // The organic thumbnail is a ~92px preview and becomes the card's HERO tile (the one scaled up
  // the most) if it sorts first, which is exactly backwards.
  it('orders the full-size images ahead of the low-resolution organic thumbnail', async () => {
    mockGetSerperKey.mockResolvedValue('serp-key');
    fetchMock.mockResolvedValue(
      jsonRes({
        organic_results: [{ title: 'A', link: 'https://a.com/p', snippet: '', thumbnail: 'https://tbn/tiny.jpg' }],
        inline_images: [{ source: 'https://a.com/p', original: 'https://img/full.jpg' }],
      })
    );

    const results = await createSerpApiProvider(adapters).search('q', 3);

    expect(results[0].images).toEqual(['https://img/full.jpg', 'https://tbn/tiny.jpg']);
    expect(results[0].thumbnail).toBe('https://img/full.jpg');
  });

  // The gstatic `thumbnail` is ~100px and visibly pixelates once a card tile scales it up.
  it('prefers the full-size `original` over the low-resolution `thumbnail`', async () => {
    mockGetSerperKey.mockResolvedValue('serp-key');
    fetchMock.mockResolvedValue(
      jsonRes({
        organic_results: [{ title: 'A', link: 'https://a.com/p', snippet: '' }],
        inline_images: [
          { source: 'https://a.com/p', original: 'https://img/full.jpg', thumbnail: 'https://tbn/small.jpg' },
          // No usable `original`: the low-res thumbnail is better than dropping the picture.
          { source: 'https://a.com/p', original: 'http://insecure/full.jpg', thumbnail: 'https://tbn/only.jpg' },
        ],
      })
    );

    const results = await createSerpApiProvider(adapters).search('q', 3);

    expect(results[0].images).toEqual(['https://img/full.jpg', 'https://tbn/only.jpg']);
  });

  describe('searchImages (the google_images engine)', () => {
    it('maps each picture to its own page and publisher, preferring the full-size original', async () => {
      mockGetSerperKey.mockResolvedValue('serp-key');
      fetchMock.mockResolvedValue(
        jsonRes({
          images_results: [
            {
              title: 'A Watch',
              link: 'https://a.com/post',
              source: 'Alpha',
              original: 'https://cdn.a.com/full.jpg',
              thumbnail: 'https://tbn/small.jpg',
            },
            // No page: it cannot be linked or attributed, which is the point of a card.
            { title: 'Orphan', source: 'Beta', original: 'https://cdn.b.com/x.jpg' },
            // Duplicate file already taken from the first entry.
            { title: 'Dupe', link: 'https://c.com/p', source: 'Gamma', original: 'https://cdn.a.com/full.jpg' },
          ],
        })
      );

      const images = await createSerpApiProvider(adapters).searchImages!('q');

      expect(images).toEqual([
        { url: 'https://cdn.a.com/full.jpg', pageUrl: 'https://a.com/post', title: 'A Watch', source: 'Alpha' },
      ]);
      expect(fetchMock.mock.calls[0][0]).toContain('engine=google_images');
    });

    it('falls back to the page host when the provider names no publisher', async () => {
      mockGetSerperKey.mockResolvedValue('serp-key');
      fetchMock.mockResolvedValue(
        jsonRes({ images_results: [{ link: 'https://shop.example.com/p', original: 'https://cdn/x.jpg' }] })
      );

      const images = await createSerpApiProvider(adapters).searchImages!('q');

      expect(images[0].source).toBe('shop.example.com');
    });

    // Missing pictures degrade the reply to prose; they must never fail the search itself.
    it('resolves to no images when the provider errors, rather than throwing', async () => {
      mockGetSerperKey.mockResolvedValue('serp-key');
      fetchMock.mockRejectedValue(new Error('network down'));

      await expect(createSerpApiProvider(adapters).searchImages!('q')).resolves.toEqual([]);
    });

    it('returns nothing when no key is configured', async () => {
      mockGetSerperKey.mockResolvedValue(null);

      await expect(createSerpApiProvider(adapters).searchImages!('q')).resolves.toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  it('drops non-https image URLs rather than emitting an unrenderable thumbnail', async () => {
    mockGetSerperKey.mockResolvedValue('serp-key');
    fetchMock.mockResolvedValue(
      jsonRes({
        organic_results: [
          { title: 'A', link: 'https://a.com', snippet: '', thumbnail: 'http://img/a.jpg' },
          { title: 'B', link: 'https://b.com', snippet: '', thumbnail: 'data:image/png;base64,AAAA' },
        ],
      })
    );

    const results = await createSerpApiProvider(adapters).search('q', 3);

    expect(results.every(r => r.thumbnail === undefined)).toBe(true);
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
