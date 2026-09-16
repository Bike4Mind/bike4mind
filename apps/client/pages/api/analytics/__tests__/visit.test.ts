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

vi.mock('@server/middlewares/rateLimit', () => ({ rateLimit: () => () => undefined }));

vi.mock('@server/utils/config', () => ({
  Config: {},
  isDevelopment: () => false,
}));

const mockEmitVisitEvent = vi.fn().mockResolvedValue(undefined);
const mockIsConfigured = vi.fn(() => true);
vi.mock('@server/analytics/emitActiveEvent', async importOriginal => {
  const original = await importOriginal<typeof import('@server/analytics/emitActiveEvent')>();
  return {
    ...original,
    isAnalyticsConfigured: () => mockIsConfigured(),
    emitVisitEvent: (...args: unknown[]) => mockEmitVisitEvent(...args),
  };
});

import handler from '../visit';
import { VISIT_COOKIE, readVisitId } from '@server/analytics/visitSession';

const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36';

function call({
  cookie,
  userAgent = BROWSER_UA,
  referer,
}: { cookie?: string; userAgent?: string; referer?: string } = {}) {
  const { req, res } = createMocks({ method: 'POST' });
  req.headers = {
    ...(cookie !== undefined && { cookie }),
    ...(userAgent !== undefined && { 'user-agent': userAgent }),
    ...(referer !== undefined && { referer }),
  } as never;
  return {
    req: req as never,
    res: res as never,
    run: () => (handler as (r: unknown, s: unknown) => unknown)(req, res),
  };
}

function setCookieHeader(res: { getHeader: (name: string) => unknown }): string | undefined {
  const value = res.getHeader('Set-Cookie');
  return typeof value === 'string' ? value : undefined;
}

describe('POST /api/analytics/visit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsConfigured.mockReturnValue(true);
  });

  it('mints a visit, hands back the cookie, and emits exactly one event', async () => {
    const { res, run } = call();
    await run();

    expect((res as unknown as { _getStatusCode: () => number })._getStatusCode()).toBe(204);
    const cookie = setCookieHeader(res as never);
    expect(cookie).toBeDefined();
    const minted = readVisitId(cookie!.split(';')[0]);
    expect(minted).toMatch(/^[0-9a-f]{32}$/);
    expect(mockEmitVisitEvent).toHaveBeenCalledTimes(1);
    // The emitted session id is the one handed to the browser, so the next request is
    // recognisable as the same visit.
    expect(mockEmitVisitEvent).toHaveBeenCalledWith(expect.objectContaining({ sessionId: minted }));
  });

  it('counts a returning request as the same visit: cookie refreshed, nothing emitted', async () => {
    const first = call();
    await first.run();
    const minted = readVisitId(setCookieHeader(first.res as never)!.split(';')[0])!;
    vi.clearAllMocks();

    const second = call({ cookie: `${VISIT_COOKIE}=${minted}` });
    await second.run();

    expect(mockEmitVisitEvent).not.toHaveBeenCalled();
    // Still re-sent: this is what slides the inactivity window, so an active browser stays
    // one visit rather than starting a new one every 30 minutes.
    expect(setCookieHeader(second.res as never)).toContain(`${VISIT_COOKIE}=${minted}`);
  });

  // A cookie is client input. A visitor who writes their own value must not get it stored
  // as a session id - not one shared constant that collapses every visit into one, and not
  // a long string of their choosing.
  it('ignores a visit id this server never minted and starts a fresh visit', async () => {
    const { res, run } = call({ cookie: `${VISIT_COOKIE}=everyone-uses-this-one` });
    await run();

    expect(mockEmitVisitEvent).toHaveBeenCalledTimes(1);
    const emitted = mockEmitVisitEvent.mock.calls[0][0] as { sessionId: string };
    expect(emitted.sessionId).toMatch(/^[0-9a-f]{32}$/);
    expect(emitted.sessionId).not.toBe('everyone-uses-this-one');
    expect(setCookieHeader(res as never)).toContain(emitted.sessionId);
  });

  it('filters a non-human agent without emitting or handing out a cookie', async () => {
    const { res, run } = call({ userAgent: 'Googlebot/2.1 (+http://www.google.com/bot.html)' });
    await run();

    expect(mockEmitVisitEvent).not.toHaveBeenCalled();
    // No cookie either: one would make this agent's next request look like a returning
    // visit rather than a filtered one.
    expect(setCookieHeader(res as never)).toBeUndefined();
    expect((res as unknown as { _getStatusCode: () => number })._getStatusCode()).toBe(204);
  });

  it('does nothing when analytics is not configured', async () => {
    mockIsConfigured.mockReturnValue(false);
    const { res, run } = call();
    await run();

    expect(mockEmitVisitEvent).not.toHaveBeenCalled();
    expect(setCookieHeader(res as never)).toBeUndefined();
  });

  it('never lets a cache keep the response, which carries a Set-Cookie', async () => {
    const { res, run } = call();
    await run();
    // A cached 204 would hand one visit id to every visitor behind that cache, collapsing
    // all of their visits into a single session.
    expect((res as unknown as { getHeader: (n: string) => unknown }).getHeader('Cache-Control')).toBe('no-store');
  });

  it('records where the visit came from, with the referrer query string stripped', async () => {
    const { run } = call({ referer: 'https://news.example.com/story?utm_source=email&secret=abc' });
    await run();

    expect(mockEmitVisitEvent).toHaveBeenCalledWith(
      expect.objectContaining({ referrer: 'https://news.example.com/story' })
    );
  });

  it('attributes the visit to the campaign cookie captured on landing', async () => {
    const utm = encodeURIComponent(JSON.stringify({ source: 'email', campaign: 'launch' }));
    const { run } = call({ cookie: `b4m_utm=${utm}` });
    await run();

    expect(mockEmitVisitEvent).toHaveBeenCalledWith(
      expect.objectContaining({ utm: { source: 'email', campaign: 'launch' } })
    );
  });
});
