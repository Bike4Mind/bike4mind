import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSafeFetch } = vi.hoisted(() => ({ mockSafeFetch: vi.fn() }));
vi.mock('@server/utils/ssrfProtection', () => ({ safeFetch: mockSafeFetch }));

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
