import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { verifyImageUrlSignature } from '@bike4mind/common';
import type { ToolContext } from '../../base/types';
import {
  safeHostname,
  serpApiSearch,
  performWebSearch,
  webSearchTool,
  createWebSearchBudget,
  MAX_WEB_SEARCHES_PER_TURN,
  WEB_SEARCH_NOT_CONFIGURED_MSG,
  shouldIncludeImages,
  formatImageResults,
} from './index';
import type { ICompletionOptionTools } from '@bike4mind/llm-adapters';

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

describe('webSearchTool - search budget', () => {
  const buildTool = () => {
    const context = {
      db: {},
      logger: { log: vi.fn() },
      statusUpdate: vi.fn(),
      onStart: vi.fn(),
    } as unknown as ToolContext;
    return webSearchTool.implementation(context) as ICompletionOptionTools;
  };
  const capped = (tool: ICompletionOptionTools, budget = createWebSearchBudget(MAX_WEB_SEARCHES_PER_TURN)) =>
    budget.apply([tool])[0].toolFn;

  beforeEach(() => {
    mockGetProvider.mockReset().mockResolvedValue('searxng');
    mockGetSearxngUrl.mockReset().mockResolvedValue('http://searxng.local');
    mockGetSerperKey.mockReset().mockResolvedValue(null);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ results: [{ url: 'https://example.com', title: 'Example', content: 'snippet' }] }),
      }))
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('runs up to the budget, then tells the model to answer without searching', async () => {
    const toolFn = capped(buildTool());

    const results = await Promise.all(
      Array.from({ length: MAX_WEB_SEARCHES_PER_TURN + 2 }, (_, i) => toolFn({ query: `q${i}` }))
    );

    expect(fetch).toHaveBeenCalledTimes(MAX_WEB_SEARCHES_PER_TURN);
    expect(results.slice(0, MAX_WEB_SEARCHES_PER_TURN).every(r => String(r).includes('example.com'))).toBe(true);
    expect(results.slice(MAX_WEB_SEARCHES_PER_TURN).every(r => String(r).startsWith('Search limit reached'))).toBe(
      true
    );
  });

  it('leaves the unwrapped tool uncapped, as subagents and agent runs use it', async () => {
    const tool = buildTool();
    const toolFn = capped(tool);
    for (let i = 0; i < MAX_WEB_SEARCHES_PER_TURN; i++) await toolFn({ query: `q${i}` });

    for (let i = 0; i < MAX_WEB_SEARCHES_PER_TURN + 3; i++) {
      await expect(tool.toolFn({ query: `sub${i}` })).resolves.toContain('example.com');
    }
  });

  it('restores the full budget on reset, so a retried conversation can search again', async () => {
    const budget = createWebSearchBudget(MAX_WEB_SEARCHES_PER_TURN);
    const toolFn = capped(buildTool(), budget);
    for (let i = 0; i < MAX_WEB_SEARCHES_PER_TURN; i++) await toolFn({ query: `q${i}` });
    await expect(toolFn({ query: 'over' })).resolves.toMatch(/^Search limit reached/);

    budget.reset();

    await expect(toolFn({ query: 'retry' })).resolves.toContain('example.com');
  });

  it('leaves other tools untouched', () => {
    const other = { ...buildTool(), toolSchema: { ...buildTool().toolSchema, name: 'web_fetch' } };
    expect(createWebSearchBudget(1).apply([other])[0]).toBe(other);
  });

  it('resolves the provider once per tool build rather than once per search', async () => {
    const toolFn = buildTool().toolFn;

    await toolFn({ query: 'a' });
    await toolFn({ query: 'b' });
    await toolFn({ query: 'c' });

    expect(mockGetProvider).toHaveBeenCalledTimes(1);
  });

  it('re-resolves the provider after a failed resolution instead of caching the rejection', async () => {
    mockGetProvider.mockRejectedValueOnce(new Error('db down'));
    const toolFn = buildTool().toolFn;

    await expect(toolFn({ query: 'a' })).rejects.toThrow('db down');
    await expect(toolFn({ query: 'b' })).resolves.toContain('example.com');
  });
});

describe('shouldIncludeImages', () => {
  // Mirrors what the real providers set (providers.ts): `images` alongside `thumbnail` as
  // `images[0]`, never one without the other.
  const hit = (...urls: string[]) => ({
    title: 't',
    url: 'https://x.com',
    snippet: 's',
    thumbnail: urls[0],
    images: urls.length ? urls : undefined,
  });

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

  // A provider (e.g. SearXNG) that has no dedicated image-search pool can still carry several
  // images on a single organic hit - counting hits-that-have-at-least-one-image would undercount
  // that as one picture and drop a real card-worthy cluster.
  it('sums every image on a single hit, not just whether the hit has any', () => {
    expect(shouldIncludeImages([hit('https://i/1.jpg', 'https://i/2.jpg'), hit()], true)).toBe(true);
    expect(shouldIncludeImages([hit('https://i/1.jpg'), hit()], true)).toBe(false);
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

  it('attaches thumbnails to the citables when images were actually requested and found', async () => {
    useSerpApi();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(serpResponse(twoImageHits)));

    const result = await performWebSearch(mockAdapters, { query: 'q', include_images: true }, TEST_SECRET);

    expect(result.citables[0].metadata).toMatchObject({ thumbnail: 'https://img/a.jpg' });
    vi.unstubAllGlobals();
  });

  // Keeps the "byte-identical text output when include_images is unset" contract honest for the
  // stored citable too, not just the formatted text: a citable carrying thumbnail/images data the
  // model never asked for and the reply never showed would be a silent behavior change.
  it('never attaches thumbnails to the citables when include_images is unset', async () => {
    useSerpApi();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(serpResponse(twoImageHits)));

    const result = await performWebSearch(mockAdapters, { query: 'q' });

    expect(result.citables[0].metadata).not.toHaveProperty('thumbnail');
    expect(result.citables[0].metadata).not.toHaveProperty('images');
    vi.unstubAllGlobals();
  });

  it('adds image lines and the card instructions when include_images is set', async () => {
    useSerpApi();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(serpResponse(twoImageHits)));

    const result = await performWebSearch(mockAdapters, { query: 'q', include_images: true }, TEST_SECRET);

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

  // Degrades to plain prose (no paid image search, no cards prompt) rather than doing the paid
  // provider call and emitting a card row that fails verification at the real proxy 100% of the
  // time - see /api/search-image, which rejects every unconfigured/placeholder secret.
  it('treats a placeholder signing secret as no images requested at all', async () => {
    useSerpApi();
    const fetchMock = vi.fn().mockResolvedValue(serpResponse(twoImageHits));
    vi.stubGlobal('fetch', fetchMock);

    const result = await performWebSearch(mockAdapters, { query: 'q', include_images: true }, '');

    expect(result.formattedResults).not.toContain('Images:');
    expect(result.formattedResults).not.toContain('b4m_cards');
    // Never paid for the dedicated image-search call either.
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('engine=google_images'))).toBe(false);
    vi.unstubAllGlobals();
  });
});

describe('webSearchTool.implementation(...).toolFn - signature threading through the tool boundary', () => {
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

  function createFakeContext(): ToolContext {
    return {
      userId: 'u1',
      user: {} as ToolContext['user'],
      logger: {
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        info: vi.fn(),
        log: vi.fn(),
      } as unknown as ToolContext['logger'],
      db: {} as ToolContext['db'],
      onStart: vi.fn().mockResolvedValue(undefined),
      statusUpdate: vi.fn().mockResolvedValue(undefined),
    } as unknown as ToolContext;
  }

  // Calling performWebSearch directly (as every other test above does) bypasses the tool's own
  // toolFn, so deleting `toolConfig?.imageUrlSigningSecret` from webSearchTool.implementation
  // itself would leave every other test in this file green. This is the one that actually
  // exercises the tool boundary the real config threading (buildSubagentToolConfig,
  // ChatCompletionProcess, embedRoute, ...) all feed into.
  it('signs the emitted image URL with the secret from toolConfig, verifiable against that secret', async () => {
    mockGetSerperKey.mockResolvedValue('serp-key');
    mockGetSearxngUrl.mockResolvedValue(null);
    mockGetProvider.mockResolvedValue('serpapi');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(serpResponse(twoImageHits)));

    const context = createFakeContext();
    const output = (await webSearchTool
      .implementation(context, { imageUrlSigningSecret: TEST_SECRET })
      .toolFn({ query: 'q', include_images: true })) as string;

    const imageLine = output.split('\n').find(line => line.startsWith('Images: '));
    expect(imageLine).toBeDefined();
    const signedUrl = imageLine!.replace('Images: ', '');
    expect(verifyImageUrlSignature(signedUrl, TEST_SECRET)).toBe(true);
    expect(verifyImageUrlSignature(signedUrl, 'a-different-secret')).toBe(false);
    vi.unstubAllGlobals();
  });
});

describe('performWebSearch - place handling', () => {
  const organic = [{ title: 'Guide', link: 'https://guide.com', snippet: 'best dinners' }];
  const mapsPlace = (id: string, name: string) => ({
    title: name,
    place_id: id,
    gps_coordinates: { latitude: 55.68, longitude: 12.59 },
    rating: 4.5,
    reviews: 100,
    type: 'Restaurant',
    thumbnail: `https://lh5.googleusercontent.com/${id}.jpg`,
  });

  // Routes each SerpAPI engine to its own canned body, so the organic, place, and anchor lookups
  // can be told apart the way the real provider sees them.
  const stubSerpApi = (places: unknown[], anchor?: unknown) => {
    const fetchStub = vi.fn(async (input: string) => {
      const url = new URL(input);
      const body =
        url.searchParams.get('engine') !== 'google_maps'
          ? { organic_results: organic }
          : anchor && url.searchParams.get('q') === 'citizenM Copenhagen'
            ? { place_results: anchor }
            : { local_results: places };
      return { ok: true, status: 200, statusText: 'OK', json: async () => body, text: async () => '' } as Response;
    });
    vi.stubGlobal('fetch', fetchStub);
    return fetchStub;
  };

  const useSerpApi = () => {
    mockGetSerperKey.mockResolvedValue('serp-key');
    mockGetSearxngUrl.mockResolvedValue(null);
    mockGetProvider.mockResolvedValue('serpapi');
  };

  it('makes no place call and leaves the output untouched when include_places is unset', async () => {
    useSerpApi();
    const fetchStub = stubSerpApi([mapsPlace('ChIJa', 'A'), mapsPlace('ChIJb', 'B')]);

    const result = await performWebSearch(mockAdapters, { query: 'dinner', anchor_location: 'citizenM Copenhagen' });

    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(result.formattedResults).not.toContain('b4m_map');
    expect(result.formattedResults).not.toContain('Places found');
    expect(result.citables.every(c => !c.metadata?.place)).toBe(true);
    vi.unstubAllGlobals();
  });

  it('sends the model query unchanged to the organic search, without US geo-targeting', async () => {
    useSerpApi();
    const fetchStub = stubSerpApi([mapsPlace('ChIJa', 'A'), mapsPlace('ChIJb', 'B')]);
    const query = 'best coffee shops near Shibuya Crossing Tokyo';

    await performWebSearch(mockAdapters, {
      query,
      include_places: true,
      anchor_location: 'Shibuya Crossing, Tokyo',
    });

    const organicUrl = fetchStub.mock.calls
      .map(([input]) => new URL(input))
      .find(url => url.searchParams.get('engine') === 'google');
    expect(organicUrl?.searchParams.get('q')).toBe(query);
    expect(organicUrl?.searchParams.has('location')).toBe(false);
    expect(organicUrl?.searchParams.has('gl')).toBe(false);
    vi.unstubAllGlobals();
  });

  it('drops the US geo-targeting from the image search on a place query too', async () => {
    useSerpApi();
    const fetchStub = stubSerpApi([mapsPlace('ChIJa', 'A'), mapsPlace('ChIJb', 'B')]);

    await performWebSearch(
      mockAdapters,
      { query: 'coffee near Shibuya Crossing', include_places: true, include_images: true },
      TEST_SECRET
    );

    const imagesUrl = fetchStub.mock.calls
      .map(([input]) => new URL(input))
      .find(url => url.searchParams.get('engine') === 'google_images');
    expect(imagesUrl?.searchParams.get('q')).toBe('coffee near Shibuya Crossing');
    expect(imagesUrl?.searchParams.has('location')).toBe(false);
    expect(imagesUrl?.searchParams.has('gl')).toBe(false);
    vi.unstubAllGlobals();
  });

  it('keeps the US geo-targeting on an ordinary search', async () => {
    useSerpApi();
    const fetchStub = stubSerpApi([]);

    await performWebSearch(mockAdapters, { query: 'dinner' });

    const organicUrl = new URL(fetchStub.mock.calls[0][0]);
    expect(organicUrl.searchParams.get('location')).toBe('United States');
    expect(organicUrl.searchParams.get('gl')).toBe('us');
    vi.unstubAllGlobals();
  });

  it('lists places by id with the map prompt, and stores the coordinates only on the citables', async () => {
    useSerpApi();
    stubSerpApi([mapsPlace('ChIJa', 'Barr'), mapsPlace('ChIJb', 'Kadeau')]);

    const result = await performWebSearch(mockAdapters, { query: 'dinner', include_places: true }, TEST_SECRET);

    expect(result.formattedResults).toContain('1. Barr - 4.5 (100 reviews) - Restaurant\n   id: ChIJa');
    expect(result.formattedResults).toContain('```b4m_map');
    expect(result.formattedResults).not.toContain('55.68');
    const place = result.citables.find(c => c.id === 'place:ChIJa')?.metadata?.place;
    expect(place).toMatchObject({ id: 'ChIJa', name: 'Barr', lat: 55.68, lng: 12.59 });
    expect(verifyImageUrlSignature(place!.thumbnail!, TEST_SECRET)).toBe(true);
    vi.unstubAllGlobals();
  });

  it('locates the anchor separately and lists it apart from the results', async () => {
    useSerpApi();
    stubSerpApi(
      [mapsPlace('ChIJcm', 'citizenM'), mapsPlace('ChIJa', 'Barr'), mapsPlace('ChIJb', 'Kadeau')],
      mapsPlace('ChIJcm', 'citizenM')
    );

    const result = await performWebSearch(mockAdapters, {
      query: 'dinner',
      include_places: true,
      anchor_location: 'citizenM Copenhagen',
    });

    expect(result.formattedResults).toContain('Anchor location (the place the user named):\ncitizenM');
    // The anchor is not also listed as a numbered result.
    expect(result.formattedResults).not.toMatch(/\d\. citizenM/);
    expect(result.citables.filter(c => c.id === 'place:ChIJcm')).toHaveLength(1);
    vi.unstubAllGlobals();
  });

  it('drops place thumbnails when the deploy cannot sign image URLs', async () => {
    useSerpApi();
    stubSerpApi([mapsPlace('ChIJa', 'A'), mapsPlace('ChIJb', 'B')]);

    const result = await performWebSearch(mockAdapters, { query: 'q', include_places: true });

    expect(result.citables.find(c => c.id === 'place:ChIJa')?.metadata?.place?.thumbnail).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it('withholds the map when fewer than two places came back', async () => {
    useSerpApi();
    stubSerpApi([mapsPlace('ChIJa', 'A')]);

    const result = await performWebSearch(mockAdapters, { query: 'q', include_places: true });

    expect(result.formattedResults).not.toContain('b4m_map');
    expect(result.citables.every(c => !c.metadata?.place)).toBe(true);
    vi.unstubAllGlobals();
  });
});
