// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

// baseApi's chain, reduced to what the route uses: .use() for the rate limit, .post() for
// the handler. Returning the handler itself is what lets the cases below call it directly.
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const api = {
      use: () => api,
      post: (fn: (req: unknown, res: unknown) => unknown) => fn,
    };
    return api;
  },
}));

// Hoisted: the route calls rateLimit() while it is being imported.
const { mockRateLimit } = vi.hoisted(() => ({ mockRateLimit: vi.fn((_opts: unknown) => () => undefined) }));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({ rateLimit: mockRateLimit }));

vi.mock('@bike4mind/server-utils/utils/config', () => ({
  Config: {},
  isDevelopment: () => false,
}));

const mockEmitPageViewEvent = vi.fn().mockResolvedValue(undefined);
const mockEmitVisitEvent = vi.fn().mockResolvedValue(undefined);
const mockIsConfigured = vi.fn(() => true);
vi.mock('@bike4mind/server-utils/analytics/emitActiveEvent', async importOriginal => {
  const original = await importOriginal<typeof import('@bike4mind/server-utils/analytics/emitActiveEvent')>();
  return {
    ...original,
    isAnalyticsConfigured: () => mockIsConfigured(),
    emitPageViewEvent: (...args: unknown[]) => mockEmitPageViewEvent(...args),
    emitVisitEvent: (...args: unknown[]) => mockEmitVisitEvent(...args),
  };
});

import handler from '../page';
import { VISIT_COOKIE, VISIT_PENDING_COOKIE } from '@server/analytics/visitSession';

const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36';
const VISIT_ID = '0123456789abcdef0123456789abcdef';
const RECORDED = `${VISIT_COOKIE}=${VISIT_ID}`;

type MockRes = { _getStatusCode: () => number; getHeader: (name: string) => unknown };

async function post({
  cookie,
  userAgent = BROWSER_UA,
  body,
}: { cookie?: string; userAgent?: string; body?: unknown } = {}): Promise<MockRes> {
  const { req, res } = createMocks({ method: 'POST', ...(body !== undefined && { body: body as never }) });
  req.headers = {
    ...(cookie !== undefined && { cookie }),
    ...(userAgent !== undefined && { 'user-agent': userAgent }),
  } as never;
  await (handler as (r: unknown, s: unknown) => unknown)(req, res);
  return res as unknown as MockRes;
}

describe('POST /api/analytics/page', () => {
  beforeEach(() => {
    mockEmitPageViewEvent.mockClear();
    mockEmitVisitEvent.mockClear();
    mockIsConfigured.mockReturnValue(true);
  });

  it('records the page on the visit the cookie names, anonymously, with only the path', async () => {
    const res = await post({ cookie: RECORDED, body: { path: '/pricing' } });

    expect(res._getStatusCode()).toBe(204);
    expect(mockEmitPageViewEvent).toHaveBeenCalledTimes(1);
    // Exactly these two fields: no user, no referrer, no campaign.
    expect(mockEmitPageViewEvent).toHaveBeenCalledWith({ sessionId: VISIT_ID, path: '/pricing' });
  });

  it('cleans the path again, since anyone can post here', async () => {
    await post({ cookie: RECORDED, body: { path: '/share/0f8fad5b-d9cb-469f-a165-70867728950e?x=1#y' } });
    await post({ cookie: RECORDED, body: { path: '/invite/aB3dE5fG7hJ9kL1mN3pQ' } });

    expect(mockEmitPageViewEvent.mock.calls.map(([opts]) => (opts as { path: string }).path)).toEqual([
      '/share/:token',
      '/invite/:token',
    ]);
  });

  it.each([
    ['an address in the path', { path: '/users/someone@example.com' }],
    ['an encoded address', { path: '/users/someone%40example.com' }],
    ['something not a path', { path: 'https://evil.example/x' }],
    ['a path that is not a string', { path: ['/pricing'] }],
    ['no path', {}],
    ['no body', undefined],
  ])('records nothing for %s', async (_label, body) => {
    const res = await post({ cookie: RECORDED, body });

    expect(res._getStatusCode()).toBe(204);
    expect(mockEmitPageViewEvent).not.toHaveBeenCalled();
  });

  // The page beacon only ever adds to a visit the visit beacon recorded. It never starts one:
  // a page with no visit to belong to would be a session with no visit event.
  describe('records nothing without a recorded visit', () => {
    it.each([
      ['no visit cookie', undefined],
      ['a visit still held for the consent answer', `${RECORDED}; ${VISIT_PENDING_COOKIE}=1`],
      ['a visit id this server never minted', `${VISIT_COOKIE}=everyone-uses-this-one`],
    ])('%s', async (_label, cookie) => {
      const res = await post({ cookie, body: { path: '/pricing' } });

      expect(res._getStatusCode()).toBe(204);
      expect(mockEmitPageViewEvent).not.toHaveBeenCalled();
      expect(mockEmitVisitEvent).not.toHaveBeenCalled();
    });
  });

  it('filters a non-human agent, and a request with no user-agent', async () => {
    await post({
      cookie: RECORDED,
      userAgent: 'Googlebot/2.1 (+http://www.google.com/bot.html)',
      body: { path: '/a' },
    });
    await post({ cookie: RECORDED, userAgent: 'HeadlessChrome/124', body: { path: '/a' } });
    await post({ cookie: RECORDED, userAgent: '', body: { path: '/a' } });

    expect(mockEmitPageViewEvent).not.toHaveBeenCalled();
  });

  it('does nothing when analytics is not configured', async () => {
    mockIsConfigured.mockReturnValue(false);
    const res = await post({ cookie: RECORDED, body: { path: '/pricing' } });

    expect(res._getStatusCode()).toBe(204);
    expect(mockEmitPageViewEvent).not.toHaveBeenCalled();
  });

  // A visit lasts 30 minutes from its last page load. Setting or refreshing a cookie here would
  // stretch it to 30 minutes from the last page change, or start one, in every case below.
  it('never sets a cookie, whatever the request, and never lets a cache answer for it', async () => {
    const responses = [
      await post({ cookie: RECORDED, body: { path: '/pricing' } }),
      await post({ body: { path: '/pricing' } }),
      await post({ cookie: `${RECORDED}; ${VISIT_PENDING_COOKIE}=1`, body: { path: '/pricing' } }),
      await post({ cookie: RECORDED, body: { path: '/a@b.c' } }),
      await post({ cookie: RECORDED, userAgent: 'curl/8.0', body: { path: '/pricing' } }),
    ];

    expect(mockEmitPageViewEvent).toHaveBeenCalledTimes(1);
    for (const res of responses) {
      expect(res.getHeader('Set-Cookie')).toBeUndefined();
      expect(res.getHeader('Cache-Control')).toBe('no-store');
    }
  });

  it('counts against its own per-IP bucket, never the one visits are counted with', () => {
    expect(mockRateLimit).toHaveBeenCalledWith({ limit: 120, windowMs: 60_000, bucket: 'analytics-page' });
  });
});
