import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSafeFetch } = vi.hoisted(() => ({ mockSafeFetch: vi.fn() }));
vi.mock('@bike4mind/server-utils/utils/ssrfProtection', () => ({ safeFetch: mockSafeFetch }));

import { clearUpstreamFeedCache, fetchUpstreamFeed, getWhatsNewFeedUrl } from './upstreamFeed';

const FEED = 'https://upstream.example.com/api/v1/whats-new';
const logger = { warn: vi.fn() };
const NOTE = {
  id: 'rn1',
  release_tag: 'v1.0.0',
  headline: 'Release',
  summary: 'Summary',
  published_at: '2026-01-01T00:00:00.000Z',
  items: [{ category: 'new', text: 'Thing', importance: 1 }],
};
const PAGE = { data: [NOTE], next_cursor: 'abc' };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const OVERSIZE_PAGE = () => json({ data: [], next_cursor: null, pad: 'x'.repeat(1024 * 1024) });
const fetchOnce = (query: { limit: number; cursor?: string } = { limit: 5 }) => fetchUpstreamFeed(query, logger);

beforeEach(() => {
  vi.clearAllMocks();
  clearUpstreamFeedCache();
  vi.stubEnv('WHATS_NEW_FEED_URL', FEED);
  vi.stubEnv('SERVER_DOMAIN', 'self.example.com');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('getWhatsNewFeedUrl', () => {
  it('treats unset and blank as unset, and trims', () => {
    vi.stubEnv('WHATS_NEW_FEED_URL', '   ');
    expect(getWhatsNewFeedUrl()).toBeUndefined();
    vi.stubEnv('WHATS_NEW_FEED_URL', ` ${FEED} `);
    expect(getWhatsNewFeedUrl()).toBe(FEED);
  });
});

describe('fetchUpstreamFeed video vetting', () => {
  const pageWith = (video: unknown) => json({ data: [{ ...NOTE, video }], next_cursor: null });

  it('keeps a video whose URLs are all on allowed hosts', async () => {
    const video = { landscape_url: 'https://d111.cloudfront.net/wide.mp4', portrait_url: null };
    mockSafeFetch.mockResolvedValue(pageWith(video));
    expect((await fetchOnce())?.data[0].video).toEqual(video);
  });

  it('drops a video with any URL outside the allowlist', async () => {
    mockSafeFetch.mockResolvedValue(
      pageWith({
        landscape_url: 'https://d111.cloudfront.net/wide.mp4',
        portrait_url: 'https://evil.example.com/t.mp4',
      })
    );
    expect((await fetchOnce())?.data[0].video).toBeNull();
  });

  it("keeps a video served from the upstream's own media route", async () => {
    const video = {
      landscape_url: 'https://upstream.example.com/api/v1/whats-new/media/rn1/landscape',
      landscape_poster_url: 'https://upstream.example.com/api/v1/whats-new/media/rn1/landscape-poster',
    };
    mockSafeFetch.mockResolvedValue(pageWith(video));
    expect((await fetchOnce())?.data[0].video).toEqual(video);
  });

  it('drops a video that uses any other path on the upstream origin', async () => {
    mockSafeFetch.mockResolvedValue(pageWith({ landscape_url: 'https://upstream.example.com/files/wide.mp4' }));
    expect((await fetchOnce())?.data[0].video).toBeNull();
  });
});

describe('fetchUpstreamFeed image vetting', () => {
  const pageWith = (note: Record<string, unknown>) => json({ data: [{ ...NOTE, ...note }], next_cursor: null });

  it("keeps an image served from the upstream's own media route", async () => {
    const image = {
      landscape_url: 'https://upstream.example.com/api/v1/whats-new/media/rn1/image-landscape',
      portrait_url: 'https://upstream.example.com/api/v1/whats-new/media/rn1/image-portrait',
    };
    mockSafeFetch.mockResolvedValue(pageWith({ image }));
    expect((await fetchOnce())?.data[0].image).toEqual(image);
  });

  it('drops an image with any URL outside the allowlist and keeps the video', async () => {
    const video = { landscape_url: 'https://d111.cloudfront.net/wide.mp4', portrait_url: null };
    const image = {
      landscape_url: 'https://d111.cloudfront.net/wide.png',
      portrait_url: 'https://evil.example.com/t.png',
    };
    mockSafeFetch.mockResolvedValue(pageWith({ video, image }));
    const note = (await fetchOnce())?.data[0];
    expect(note?.image).toBeNull();
    expect(note?.video).toEqual(video);
  });
});

describe('fetchUpstreamFeed', () => {
  it('returns null without fetching when unset', async () => {
    vi.stubEnv('WHATS_NEW_FEED_URL', '');
    expect(await fetchOnce()).toBeNull();
    expect(mockSafeFetch).not.toHaveBeenCalled();
  });

  it('rejects a non-https URL', async () => {
    vi.stubEnv('WHATS_NEW_FEED_URL', 'http://upstream.example.com/api/v1/whats-new');
    expect(await fetchOnce()).toBeNull();
    expect(mockSafeFetch).not.toHaveBeenCalled();
  });

  it.each([
    ['the bare SERVER_DOMAIN', 'self.example.com', 'self.example.com', ''],
    ['the app host the deployment is actually served on', 'APP.self.example.com', 'self.example.com', ''],
    ['a trailing-dot spelling of the app host', 'app.self.example.com.', 'self.example.com', ''],
    ['the app host with several trailing dots', 'app.self.example.com..', 'self.example.com.', ''],
    [
      'the APP_URL host on a preview with an empty SERVER_DOMAIN',
      'pr-12.preview.example.com',
      '',
      'https://pr-12.preview.example.com',
    ],
  ])('rejects a URL pointing at %s', async (_label, host, serverDomain, appUrl) => {
    vi.stubEnv('SERVER_DOMAIN', serverDomain);
    vi.stubEnv('APP_URL', appUrl);
    vi.stubEnv('WHATS_NEW_FEED_URL', `https://${host}/api/v1/whats-new`);
    expect(await fetchOnce()).toBeNull();
    expect(mockSafeFetch).not.toHaveBeenCalled();
  });

  it.each(['/api/v1/whats-new/', '/api/v1/whats-new//'])('still rejects the own API route spelled %s', async path => {
    vi.stubEnv('WHATS_NEW_FEED_URL', `https://self.example.com${path}`);
    expect(await fetchOnce()).toBeNull();
    expect(mockSafeFetch).not.toHaveBeenCalled();
  });

  it('returns a valid page and forwards limit and cursor', async () => {
    mockSafeFetch.mockResolvedValue(json(PAGE));
    expect(await fetchOnce({ limit: 3, cursor: 'c1' })).toEqual(PAGE);
    const url = new URL(mockSafeFetch.mock.calls[0][0]);
    expect(url.searchParams.get('limit')).toBe('3');
    expect(url.searchParams.get('cursor')).toBe('c1');
  });

  it('accepts an empty page', async () => {
    mockSafeFetch.mockResolvedValue(json({ data: [], next_cursor: null }));
    expect(await fetchOnce()).toEqual({ data: [], next_cursor: null });
  });

  it.each([
    ['an off-schema body', () => json({ data: [{ id: 1 }] })],
    ['a non-JSON body', () => new Response('<html>', { status: 200 })],
    ['a non-200 status', () => json(PAGE, 503)],
    ['an empty body', () => new Response('', { status: 200 })],
  ])('returns null and warns on %s', async (_label, make) => {
    mockSafeFetch.mockResolvedValue(make());
    expect(await fetchOnce()).toBeNull();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('returns null and warns of the size cap on an oversize body', async () => {
    mockSafeFetch.mockResolvedValue(OVERSIZE_PAGE());
    expect(await fetchOnce()).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('exceeded the size cap'), expect.anything());
  });

  it('returns null when the SSRF guard blocks the target', async () => {
    mockSafeFetch.mockRejectedValue(new Error('blocked: private address'));
    expect(await fetchOnce()).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('fetch failed'), expect.anything());
  });

  it('aborts after the timeout', async () => {
    vi.useFakeTimers();
    mockSafeFetch.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))))
    );
    const pending = fetchOnce();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await pending).toBeNull();
  });

  it('times out even when safeFetch hangs before it reaches fetch (DNS)', async () => {
    vi.useFakeTimers();
    mockSafeFetch.mockImplementation(() => new Promise(() => {}));
    const pending = fetchOnce();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await pending).toBeNull();
  });

  it('caches a first page, then refetches after it expires', async () => {
    vi.useFakeTimers();
    mockSafeFetch.mockImplementation(async () => json(PAGE));
    await fetchOnce();
    await fetchOnce();
    expect(mockSafeFetch).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_001);
    await fetchOnce();
    expect(mockSafeFetch).toHaveBeenCalledTimes(2);
  });

  it('keeps the cached first page however many distinct cursors are requested', async () => {
    mockSafeFetch.mockImplementation(async () => json(PAGE));
    await fetchOnce();
    for (let i = 0; i < 60; i++) await fetchOnce({ limit: 5, cursor: `c${i}` });
    expect(mockSafeFetch).toHaveBeenCalledTimes(61);
    await fetchOnce();
    expect(mockSafeFetch).toHaveBeenCalledTimes(61);
  });

  it('skips the upstream for every query, any cursor included, during an outage window', async () => {
    vi.useFakeTimers();
    mockSafeFetch.mockImplementation(async () => json({}, 500));
    await fetchOnce();
    expect(await fetchOnce({ limit: 5, cursor: 'fresh-1' })).toBeNull();
    expect(await fetchOnce({ limit: 7 })).toBeNull();
    expect(mockSafeFetch).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(30_001);
    await fetchOnce();
    expect(mockSafeFetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['an oversize body', OVERSIZE_PAGE],
    ['an empty body', () => new Response('', { status: 200 })],
    ['an off-schema body', () => json({ data: [{ id: 1 }] })],
  ])('does not open an outage window on %s for one query', async (_label, make) => {
    mockSafeFetch.mockResolvedValueOnce(make()).mockResolvedValue(json(PAGE));
    expect(await fetchOnce({ limit: 100 })).toBeNull();
    expect(await fetchOnce()).toEqual(PAGE);
    expect(mockSafeFetch).toHaveBeenCalledTimes(2);
  });

  it('keeps serving a cached first page during an outage window', async () => {
    mockSafeFetch.mockResolvedValueOnce(json(PAGE)).mockResolvedValue(json({}, 503));
    await fetchOnce();
    expect(await fetchOnce({ limit: 7 })).toBeNull();
    expect(await fetchOnce()).toEqual(PAGE);
    expect(mockSafeFetch).toHaveBeenCalledTimes(2);
  });

  it.each([401, 403, 404])('opens an outage window on a %d for the first page', async status => {
    mockSafeFetch.mockResolvedValueOnce(json({}, status)).mockResolvedValue(json(PAGE));
    expect(await fetchOnce()).toBeNull();
    expect(await fetchOnce({ limit: 7 })).toBeNull();
    expect(mockSafeFetch).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403, 404])('does not open an outage window on a %d for a cursor page', async status => {
    // A rejected cursor ends only that list; treating it as a misconfigured feed would black out every caller.
    mockSafeFetch.mockResolvedValueOnce(json({}, status)).mockResolvedValue(json(PAGE));
    expect(await fetchOnce({ limit: 5, cursor: 'c' })).toBeNull();
    expect(await fetchOnce()).toEqual(PAGE);
    expect(mockSafeFetch).toHaveBeenCalledTimes(2);
  });

  it('does not open an outage window on a 4xx caused by the request', async () => {
    mockSafeFetch.mockResolvedValueOnce(json({}, 422)).mockResolvedValue(json(PAGE));
    expect(await fetchOnce({ limit: 5, cursor: 'bad' })).toBeNull();
    expect(await fetchOnce()).toEqual(PAGE);
    expect(mockSafeFetch).toHaveBeenCalledTimes(2);
  });

  it('does not open an outage window on a first-page 422 for an out-of-range limit', async () => {
    mockSafeFetch.mockResolvedValueOnce(json({}, 422)).mockResolvedValue(json(PAGE));
    expect(await fetchOnce({ limit: 100 })).toBeNull();
    expect(await fetchOnce()).toEqual(PAGE);
    expect(mockSafeFetch).toHaveBeenCalledTimes(2);
  });
});

describe('fetchUpstreamFeed with a JSON Feed document', () => {
  const SITE_FEED = 'https://self.example.com/whats-new.json';
  const jsonFeed = (items: unknown[]) => ({ version: 'https://jsonfeed.org/version/1.1', title: 'What is new', items });
  const item = (id: string, date: string | undefined, title = `Title ${id}`) => ({
    id,
    title,
    content_text: `Text ${id}`,
    date_published: date,
    tags: ['Feature', 'App'],
  });

  beforeEach(() => vi.stubEnv('WHATS_NEW_FEED_URL', SITE_FEED));

  it('reads the site feed on the apex domain, which is not the API route of this deployment', async () => {
    mockSafeFetch.mockResolvedValue(json(jsonFeed([item('a', '2026-10-09T00:00:00.000Z')])));
    const page = await fetchOnce();
    expect(mockSafeFetch).toHaveBeenCalledTimes(1);
    expect(page).toEqual({
      data: [
        {
          id: 'a',
          release_tag: 'Feature',
          headline: 'Title a',
          summary: 'Text a',
          published_at: '2026-10-09T00:00:00.000Z',
          items: [],
        },
      ],
      next_cursor: null,
    });
  });

  it('orders newest first, honours the limit and skips undated items', async () => {
    mockSafeFetch.mockImplementation(async () =>
      json(
        jsonFeed([
          item('old', '2026-09-01T00:00:00.000Z'),
          item('undated', undefined),
          item('new', '2026-10-09T00:00:00.000Z'),
          item('mid', '2026-10-01T00:00:00.000Z'),
        ])
      )
    );
    const page = await fetchOnce({ limit: 2 });
    expect(page?.data.map(note => note.id)).toEqual(['new', 'mid']);
    expect(page?.next_cursor).toEqual(expect.any(String));
    const next = await fetchOnce({ limit: 2, cursor: page?.next_cursor ?? undefined });
    expect(next?.data.map(note => note.id)).toEqual(['old']);
    expect(next?.next_cursor).toBeNull();
  });

  it('pages through equal dates without repeating an item when a new one appears', async () => {
    mockSafeFetch.mockResolvedValueOnce(
      json(
        jsonFeed([
          item('c', '2026-10-09T00:00:00.000Z'),
          item('b', '2026-10-09T00:00:00.000Z'),
          item('a', '2026-10-09T00:00:00.000Z'),
        ])
      )
    );
    const first = await fetchOnce({ limit: 2 });
    expect(first?.data.map(note => note.id)).toEqual(['a', 'b']);
    mockSafeFetch.mockResolvedValueOnce(
      json(
        jsonFeed([
          item('c', '2026-10-09T00:00:00.000Z'),
          item('b', '2026-10-09T00:00:00.000Z'),
          item('a', '2026-10-09T00:00:00.000Z'),
          item('new', '2026-10-10T00:00:00.000Z'),
        ])
      )
    );
    const second = await fetchOnce({ limit: 2, cursor: first?.next_cursor ?? undefined });
    expect(second?.data.map(note => note.id)).toEqual(['c']);
    expect(second?.next_cursor).toBeNull();
  });

  it('uses the same case-sensitive id order for sorting and cursor continuation', async () => {
    mockSafeFetch.mockImplementation(async () =>
      json(
        jsonFeed([
          item('a', '2026-10-09T00:00:00.000Z'),
          item('B', '2026-10-09T00:00:00.000Z'),
          item('A', '2026-10-09T00:00:00.000Z'),
        ])
      )
    );
    const first = await fetchOnce({ limit: 2 });
    expect(first?.data.map(note => note.id)).toEqual(['A', 'B']);
    const second = await fetchOnce({ limit: 2, cursor: first?.next_cursor ?? undefined });
    expect(second?.data.map(note => note.id)).toEqual(['a']);
  });

  it('uses summary when content_text is blank', async () => {
    mockSafeFetch.mockResolvedValue(
      json(jsonFeed([{ ...item('a', '2026-10-09T00:00:00.000Z'), content_text: '  ', summary: 'Important details' }]))
    );
    expect((await fetchOnce())?.data[0].summary).toBe('Important details');
  });

  it("rejects a redirect to this deployment's own API route", async () => {
    mockSafeFetch.mockImplementation(
      async (
        _url: string,
        _init: RequestInit,
        options: {
          assertRedirectAllowed: (target: URL) => void;
        }
      ) => {
        options.assertRedirectAllowed(new URL('https://app.self.example.com/api/v1/whats-new'));
        return json(jsonFeed([]));
      }
    );
    expect(await fetchOnce()).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('fetch failed'), expect.anything());
  });

  it('still rejects a body that is neither shape', async () => {
    mockSafeFetch.mockResolvedValue(json({ version: 'rss', items: [] }));
    expect(await fetchOnce()).toBeNull();
  });
});
