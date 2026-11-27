import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserContext, Page, Route } from '@playwright/test';
import { bypassTurnstile } from '../../e2e/helpers/turnstile';
import { fetchWithWafBypass, installWafBypass } from '../../e2e/helpers/waf-bypass';

const resourceSecret = vi.hoisted(() => ({ value: 'resource-secret' as string | undefined }));
vi.mock('sst', () => ({ Resource: { E2E_CLEANUP_SECRET: resourceSecret } }));

type UrlMatcher = Parameters<Page['route']>[0];
type RouteHandler = Parameters<Page['route']>[1];
type Reply = { status: number; location?: string; bytes?: number };
type Sent = {
  url: string;
  method: string;
  headers: Record<string, string>;
  postData?: unknown;
  maxRedirects?: number;
  timeout?: number;
};

// Models Playwright's dispatch: page routes before context routes, each list newest first, header
// overrides carried by fallback. route.fetch answers from `replies` by URL (200 when unlisted) and
// records what it sent; continue and fulfill end dispatch, as they do in the browser.
function createRoutingHarness(replies: Record<string, Reply> = {}) {
  const pageRoutes: { matcher: UrlMatcher; handler: RouteHandler }[] = [];
  const contextRoutes: { matcher: UrlMatcher; handler: RouteHandler }[] = [];
  const register = (list: typeof pageRoutes) => async (matcher: UrlMatcher, handler: RouteHandler) => {
    list.push({ matcher, handler });
  };
  const page = { route: register(pageRoutes) } as unknown as Page;
  const context = { route: register(contextRoutes) } as unknown as BrowserContext;

  async function request(url: string, { method = 'GET', navigation = false, postData = undefined as unknown } = {}) {
    const target = new URL(url);
    let headers: Record<string, string> = { 'x-existing-header': 'preserved' };
    const sent: Sent[] = [];
    let fulfilled: Reply | undefined;
    let aborted = false;
    const matches = ({ matcher }: { matcher: UrlMatcher }) => {
      if (typeof matcher === 'function') return matcher(target);
      if (matcher instanceof RegExp) return matcher.test(url);
      throw new Error('Secret-bearing routes must use an explicit origin/path predicate');
    };
    const matching = [...contextRoutes.filter(matches), ...pageRoutes.filter(matches)];
    const dispatch = async (): Promise<void> => {
      const registration = matching.pop();
      if (!registration) return;
      const route = {
        request: () => ({
          url: () => url,
          method: () => method,
          headers: () => headers,
          postDataBuffer: () => postData ?? null,
          isNavigationRequest: () => navigation,
        }),
        fallback: async (options?: Parameters<Route['fallback']>[0]) => {
          headers = options?.headers ?? headers;
          await dispatch();
        },
        continue: async (options?: Parameters<Route['continue']>[0]) => {
          headers = options?.headers ?? headers;
        },
        fetch: async (options: Sent) => {
          const sentUrl = options.url ?? url;
          sent.push({ ...options, url: sentUrl });
          const reply = replies[sentUrl] ?? { status: 200 };
          return {
            status: () => reply.status,
            headers: () => (reply.location ? { location: reply.location } : {}),
            dispose: async () => {},
            body: async () => Buffer.alloc(reply.bytes ?? 0),
            reply,
          };
        },
        fulfill: async ({ response }: { response: { reply: Reply } }) => {
          fulfilled = response.reply;
        },
        abort: async () => {
          aborted = true;
        },
      } as unknown as Route;
      await registration.handler(route, route.request());
    };
    await dispatch();
    return { headers: sent[0]?.headers ?? headers, sent, fulfilled, aborted };
  }

  return { page, context, request: async (url: string) => (await request(url)).headers, send: request };
}

describe('E2E Turnstile request bypass', () => {
  beforeEach(() => {
    vi.stubEnv('API_URL', 'https://api.example.com/base');
    vi.stubEnv('E2E_CLEANUP_SECRET', 'cleanup-secret');
    vi.stubEnv('E2E_WAF_BYPASS_TOKEN', 'waf-token');
    resourceSecret.value = 'resource-secret';
  });
  afterEach(() => vi.unstubAllEnvs());

  it('preserves existing headers and the WAF bypass on the API send endpoint, including queries', async () => {
    const harness = createRoutingHarness();
    await installWafBypass(harness.context);
    await bypassTurnstile(harness.page);

    for (const suffix of ['', '?source=login']) {
      expect(await harness.request(`https://api.example.com/api/otc/send${suffix}`)).toEqual({
        'x-existing-header': 'preserved',
        'x-e2e-cleanup-secret': 'cleanup-secret',
        'x-e2e-waf-bypass': 'waf-token',
      });
    }
  });

  it.each([
    'https://third-party.example/api/otc/send',
    'https://api.example.com.evil.example/api/otc/send',
    'http://api.example.com/api/otc/send',
    'https://api.example.com:8443/api/otc/send',
    'https://api.example.com/api/otc/verify',
    'https://api.example.com/api/otc/send/extra',
  ])('never attaches the cleanup secret to %s', async url => {
    const harness = createRoutingHarness();
    await installWafBypass(harness.context);
    await bypassTurnstile(harness.page);
    expect(await harness.request(url)).not.toHaveProperty('x-e2e-cleanup-secret');
  });

  it.each([
    'https://api.example.com/',
    'https://api.example.com/_next/static/chunks/app.js',
    'https://api.example.com/_next/image?url=%2Flogo.png&w=64&q=75',
    'https://api.example.com/api/anything?x=1',
  ])('attaches the WAF bypass to every same-origin request: %s', async url => {
    const harness = createRoutingHarness();
    await installWafBypass(harness.context);
    expect(await harness.request(url)).toEqual({
      'x-existing-header': 'preserved',
      'x-e2e-waf-bypass': 'waf-token',
    });
  });

  it.each([
    'https://third-party.example/api/otc/send',
    'https://api.example.com.evil.example/',
    'http://api.example.com/_next/static/chunks/app.js',
    'https://api.example.com:8443/api/anything',
  ])('never attaches the WAF bypass to %s', async url => {
    const harness = createRoutingHarness();
    await installWafBypass(harness.context);
    await bypassTurnstile(harness.page);
    expect(await harness.request(url)).not.toHaveProperty('x-e2e-waf-bypass');
  });

  it.each(['', undefined])('registers no route when the WAF token is %j', async token => {
    vi.stubEnv('E2E_WAF_BYPASS_TOKEN', token);
    const route = vi.fn();
    await installWafBypass({ route } as unknown as BrowserContext);
    expect(route).not.toHaveBeenCalled();
  });

  it('uses the localhost API origin when API_URL is unset', async () => {
    vi.stubEnv('API_URL', undefined);
    const harness = createRoutingHarness();
    await bypassTurnstile(harness.page);
    expect(await harness.request('http://localhost:3000/api/otc/send')).toHaveProperty(
      'x-e2e-cleanup-secret',
      'cleanup-secret'
    );
    expect(await harness.request('http://localhost:4000/api/otc/send')).not.toHaveProperty('x-e2e-cleanup-secret');
  });

  it('uses the linked resource when the environment secret is absent', async () => {
    vi.stubEnv('E2E_CLEANUP_SECRET', undefined);
    const harness = createRoutingHarness();
    await bypassTurnstile(harness.page);
    expect(await harness.request('https://api.example.com/api/otc/send')).toHaveProperty(
      'x-e2e-cleanup-secret',
      'resource-secret'
    );
  });

  it('still invokes the WAF handler when no cleanup secret is configured', async () => {
    vi.stubEnv('E2E_CLEANUP_SECRET', undefined);
    resourceSecret.value = undefined;
    const harness = createRoutingHarness();
    await installWafBypass(harness.context);
    await bypassTurnstile(harness.page);
    expect(await harness.request('https://api.example.com/api/otc/send')).toEqual({
      'x-existing-header': 'preserved',
      'x-e2e-waf-bypass': 'waf-token',
    });
  });

  describe('redirects the browser request takes', () => {
    const A = 'https://api.example.com';
    const OFF = 'https://bucket.storage.example/object?sig=1';

    async function send(
      replies: Record<string, Reply>,
      url: string,
      opts?: Parameters<ReturnType<typeof createRoutingHarness>['send']>[1]
    ) {
      const harness = createRoutingHarness(replies);
      await installWafBypass(harness.context);
      return harness.send(url, opts);
    }

    it('fetches an off-origin hop of a subresource without the header', async () => {
      const result = await send(
        { [`${A}/api/files/1/content`]: { status: 302, location: OFF } },
        `${A}/api/files/1/content`
      );
      expect(result.sent.map(s => [s.url, s.headers['x-e2e-waf-bypass'], s.maxRedirects])).toEqual([
        [`${A}/api/files/1/content`, 'waf-token', 0],
        [OFF, undefined, undefined],
      ]);
      expect(result.sent[1].headers).toHaveProperty('x-existing-header', 'preserved');
      expect(result.fulfilled).toEqual({ status: 200 });
    });

    it('drops authorization and cookie on an off-origin hop, as a browser does', async () => {
      const harness = createRoutingHarness({ [`${A}/api/files/1/content`]: { status: 302, location: OFF } });
      await installWafBypass(harness.context);
      await harness.page.route(
        url => url.origin === A,
        route =>
          route.fallback({
            headers: { ...route.request().headers(), authorization: 'Bearer jwt', cookie: 'session=1' },
          })
      );
      const result = await harness.send(`${A}/api/files/1/content`);
      expect(result.sent[0].headers).toMatchObject({ authorization: 'Bearer jwt', cookie: 'session=1' });
      expect(result.sent[1].headers).not.toHaveProperty('authorization');
      expect(result.sent[1].headers).not.toHaveProperty('cookie');
    });

    it('lifts the route.fetch timeout on every hop it sends', async () => {
      const result = await send(
        { [`${A}/a`]: { status: 307, location: '/b' }, [`${A}/b`]: { status: 302, location: OFF } },
        `${A}/a`
      );
      expect(result.sent.map(s => s.timeout)).toEqual([0, 0, 0]);
    });

    it('holds each hop back by latency plus transfer time when given a slow link', async () => {
      const harness = createRoutingHarness({
        [`${A}/a`]: { status: 307, location: '/b' },
        [`${A}/b`]: { status: 200, bytes: 500 },
      });
      await installWafBypass(harness.context, { slowLink: { latency: 40, downloadThroughput: 10_000 } });
      const started = Date.now();
      const result = await harness.send(`${A}/a`);
      expect(result.fulfilled).toEqual({ status: 200, bytes: 500 });
      expect(Date.now() - started).toBeGreaterThanOrEqual(125);
    });

    it('makes concurrent responses share the slow link bandwidth', async () => {
      const harness = createRoutingHarness({
        [`${A}/x`]: { status: 200, bytes: 500 },
        [`${A}/y`]: { status: 200, bytes: 500 },
      });
      await installWafBypass(harness.context, { slowLink: { latency: 0, downloadThroughput: 10_000 } });
      const started = Date.now();
      await Promise.all([harness.send(`${A}/x`), harness.send(`${A}/y`)]);
      expect(Date.now() - started).toBeGreaterThanOrEqual(95);
    });

    it('keeps the header on a same-origin hop of a subresource', async () => {
      const result = await send({ [`${A}/a`]: { status: 307, location: '/b' } }, `${A}/a`);
      expect(result.sent.map(s => [s.url, s.headers['x-e2e-waf-bypass'], s.maxRedirects])).toEqual([
        [`${A}/a`, 'waf-token', 0],
        [`${A}/b`, 'waf-token', 0],
      ]);
    });

    it('hands a navigation its redirect to follow, sending nothing off-origin itself', async () => {
      const redirect = { status: 302, location: OFF };
      const result = await send({ [`${A}/api/auth/okta`]: redirect }, `${A}/api/auth/okta`, { navigation: true });
      expect(result.sent.map(s => s.url)).toEqual([`${A}/api/auth/okta`]);
      expect(result.fulfilled).toBe(redirect);
    });

    it('turns a POST into a bodiless GET on 303', async () => {
      const result = await send({ [`${A}/form`]: { status: 303, location: '/done' } }, `${A}/form`, {
        method: 'POST',
        postData: 'a=1',
      });
      expect(result.sent.map(s => [s.method, s.postData])).toEqual([
        ['POST', 'a=1'],
        ['GET', undefined],
      ]);
    });

    it.each([
      [`${A}/api/settings/fetch`, 'waf-token'],
      ['https://api.example.com.evil.example/api/settings/fetch', undefined],
    ])('fetchWithWafBypass scopes the header to the API origin and follows no redirect: %s', async (url, expected) => {
      const fetch = vi.fn(async () => ({}));
      const route = {
        request: () => ({ url: () => url, headers: () => ({ accept: '*/*' }) }),
        fetch,
      } as unknown as Route;
      await fetchWithWafBypass(route);
      expect(fetch).toHaveBeenCalledWith({
        headers: expected ? { accept: '*/*', 'x-e2e-waf-bypass': expected } : { accept: '*/*' },
        maxRedirects: 0,
      });
    });

    it('aborts rather than sending the request bare when the fetch fails', async () => {
      const handler = vi.fn();
      const abort = vi.fn(async () => {});
      const route = {
        request: () => ({
          url: () => `${A}/x`,
          method: () => 'GET',
          headers: () => ({}),
          postDataBuffer: () => null,
          isNavigationRequest: () => false,
        }),
        fetch: async () => {
          throw new Error('Target page closed');
        },
        continue: handler,
        fulfill: handler,
        abort,
      } as unknown as Route;
      const registered = vi.fn();
      await installWafBypass({ route: registered } as unknown as BrowserContext);
      await registered.mock.calls[0][1](route);
      expect(abort).toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();
    });
  });
});
