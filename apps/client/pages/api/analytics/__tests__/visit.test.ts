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

vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({ rateLimit: () => () => undefined }));

vi.mock('@bike4mind/server-utils/utils/config', () => ({
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
import { VISIT_COOKIE, VISIT_PENDING_COOKIE, readVisitId } from '@server/analytics/visitSession';

const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36';

function call({
  cookie,
  userAgent = BROWSER_UA,
  referer,
  body,
}: { cookie?: string; userAgent?: string; referer?: string; body?: unknown } = {}) {
  const { req, res } = createMocks({ method: 'POST', ...(body !== undefined && { body: body as never }) });
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

function setCookies(res: { getHeader: (name: string) => unknown }): string[] {
  const value = res.getHeader('Set-Cookie');
  return Array.isArray(value) ? (value as string[]) : typeof value === 'string' ? [value] : [];
}

/** The visit cookie this response sets, if any. */
function setCookieHeader(res: { getHeader: (name: string) => unknown }): string | undefined {
  return setCookies(res).find(c => c.startsWith(`${VISIT_COOKIE}=`));
}

/** The pending mark this response sets or expires, if it touches it. */
function pendingCookieHeader(res: { getHeader: (name: string) => unknown }): string | undefined {
  return setCookies(res).find(c => c.startsWith(`${VISIT_PENDING_COOKIE}=`));
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

  it('records where the visit came from and where it landed, from the body, reduced to origin and path', async () => {
    const { run } = call({
      body: {
        referrer: 'https://news.example.com/story?secret=abc',
        landingPath: '/share/0f8fad5b-d9cb-469f-a165-70867728950e?x=1',
      },
    });
    await run();

    expect(mockEmitVisitEvent).toHaveBeenCalledWith(
      expect.objectContaining({ referrer: 'https://news.example.com', landingPath: '/share/:token' })
    );
  });

  it('never takes the source from the Referer header, which names the app page that sent the beacon', async () => {
    const { run } = call({ referer: 'https://app.example.com/notebooks/65f1c0ffee0ddba11ad5eed1' });
    await run();

    expect(mockEmitVisitEvent).toHaveBeenCalledTimes(1);
    expect(mockEmitVisitEvent.mock.calls[0][0]).toMatchObject({ referrer: undefined, landingPath: undefined });
  });

  it('attributes the visit to the campaign cookie captured on landing', async () => {
    const utm = encodeURIComponent(JSON.stringify({ source: 'email', campaign: 'launch' }));
    const { run } = call({ cookie: `b4m_utm=${utm}` });
    await run();

    expect(mockEmitVisitEvent).toHaveBeenCalledWith(
      expect.objectContaining({ utm: { source: 'email', campaign: 'launch' } })
    );
  });

  it('sets no pending mark on a visit that is recorded at once', async () => {
    const { res, run } = call();
    await run();

    expect(pendingCookieHeader(res as never)).toBeUndefined();
  });

  // The first visit from search or a shared link usually lands on the consent banner, and its
  // source can only go in the visit's one event. So that event waits for the answer.
  describe('a visit that starts while the visitor is asked for consent', () => {
    async function startHeld() {
      const first = call({ body: { awaitingConsent: true } });
      await first.run();
      const minted = readVisitId(setCookieHeader(first.res as never)!.split(';')[0])!;
      return { first, minted, cookie: `${VISIT_COOKIE}=${minted}; ${VISIT_PENDING_COOKIE}=1` };
    }

    it('starts the visit and marks it pending, emitting nothing yet', async () => {
      const { first, minted } = await startHeld();

      expect(minted).toMatch(/^[0-9a-f]{32}$/);
      expect(mockEmitVisitEvent).not.toHaveBeenCalled();
      const mark = pendingCookieHeader(first.res as never);
      expect(mark).toContain(`${VISIT_PENDING_COOKIE}=1`);
      expect(mark).toContain('Max-Age=1800');
      expect(mark).toContain('HttpOnly');
    });

    it('emits the held visit once the answer arrives, with the source and campaign a grant allows', async () => {
      const { minted, cookie } = await startHeld();
      const utm = encodeURIComponent(JSON.stringify({ source: 'newsletter' }));

      const release = call({
        cookie: `${cookie}; b4m_utm=${utm}`,
        body: { referrer: 'https://www.google.com/search?q=x', landingPath: '/pricing' },
      });
      await release.run();

      expect(mockEmitVisitEvent).toHaveBeenCalledTimes(1);
      expect(mockEmitVisitEvent).toHaveBeenCalledWith({
        sessionId: minted,
        referrer: 'https://www.google.com',
        utm: { source: 'newsletter' },
        landingPath: '/pricing',
      });
      // Recorded now, so the mark goes: a later beacon in this visit emits nothing.
      expect(pendingCookieHeader(release.res as never)).toContain('Max-Age=0');
      expect(setCookieHeader(release.res as never)).toContain(`${VISIT_COOKIE}=${minted}`);
    });

    it('emits the held visit with no source when the answer is a decline, or none', async () => {
      const { minted, cookie } = await startHeld();

      await call({ cookie, body: {} }).run();

      expect(mockEmitVisitEvent).toHaveBeenCalledTimes(1);
      expect(mockEmitVisitEvent.mock.calls[0][0]).toMatchObject({
        sessionId: minted,
        referrer: undefined,
        landingPath: undefined,
      });
    });

    it('keeps holding through a reload that is still awaiting consent', async () => {
      const { minted, cookie } = await startHeld();

      const reload = call({ cookie, body: { awaitingConsent: true } });
      await reload.run();

      expect(mockEmitVisitEvent).not.toHaveBeenCalled();
      expect(setCookieHeader(reload.res as never)).toContain(`${VISIT_COOKIE}=${minted}`);
      expect(pendingCookieHeader(reload.res as never)).toContain(`${VISIT_PENDING_COOKIE}=1`);
    });

    it('takes no source for a visit already recorded, so a late answer cannot add a second event', async () => {
      const { minted } = await startHeld();

      const late = call({
        cookie: `${VISIT_COOKIE}=${minted}`,
        body: { referrer: 'https://www.google.com', landingPath: '/pricing' },
      });
      await late.run();

      expect(mockEmitVisitEvent).not.toHaveBeenCalled();
      expect(pendingCookieHeader(late.res as never)).toBeUndefined();
    });

    it('does not hold a visit already recorded when a later page load awaits consent', async () => {
      const first = call();
      await first.run();
      const minted = readVisitId(setCookieHeader(first.res as never)!.split(';')[0])!;
      vi.clearAllMocks();

      const later = call({ cookie: `${VISIT_COOKIE}=${minted}`, body: { awaitingConsent: true } });
      await later.run();

      expect(mockEmitVisitEvent).not.toHaveBeenCalled();
      expect(pendingCookieHeader(later.res as never)).toBeUndefined();
    });
  });
});
