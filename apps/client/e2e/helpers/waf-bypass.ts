import type { APIRequest, APIRequestContext, APIResponse, BrowserContext, Route } from '@playwright/test';

const WAF_BYPASS_HEADER = 'x-e2e-waf-bypass';
const SCOPED_METHODS = new Set(['fetch', 'get', 'post', 'put', 'patch', 'delete', 'head']);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
// Playwright's own default for APIRequestContext calls.
const DEFAULT_MAX_REDIRECTS = 20;

type FetchOptions = NonNullable<Parameters<APIRequestContext['fetch']>[1]>;

/** CDP Network.emulateNetworkConditions units: latency in ms, throughput in bytes per second. */
export type SlowLink = { latency: number; downloadThroughput: number };

function apiOrigin(): string {
  return new URL(process.env.API_URL || 'http://localhost:3000').origin;
}

/** Header the edge allows past the hosting-network checks. Empty when unset. */
export function wafBypassHeaders(): Record<string, string> {
  const token = process.env.E2E_WAF_BYPASS_TOKEN;
  return token ? { [WAF_BYPASS_HEADER]: token } : {};
}

/**
 * Adds the header to every browser request on the API origin (pages, static assets, API calls)
 * and nowhere else. A context-wide extraHTTPHeaders would also reach third-party origins and
 * break their CORS preflights. Traces record it, so e2e-run.yml scrubs the token from test
 * output before upload. It is a context route, so page routes (turnstile.ts) run first and must
 * route.fallback() to reach it. Chromium's CDP throttle skips fulfilled responses, so a throttled
 * page passes `slowLink` and each hop is held back here instead.
 */
export async function installWafBypass(context: BrowserContext, options: { slowLink?: SlowLink } = {}): Promise<void> {
  const headers = wafBypassHeaders();
  if (!headers[WAF_BYPASS_HEADER]) return;
  const origin = apiOrigin();
  const pace = options.slowLink ? linkPacer(options.slowLink) : undefined;
  await context.route(
    url => url.origin === origin,
    route => continueWithBypass(route, origin, headers, pace)
  );
}

/**
 * route.fetch() with the header for a request on the API origin, following no redirect: headers
 * given to route.fetch or route.continue also ride every redirect the request takes, whatever
 * its origin.
 */
export async function fetchWithWafBypass(route: Route): Promise<APIResponse> {
  const bypass = wafBypassHeaders();
  const onOrigin = new URL(route.request().url()).origin === apiOrigin();
  return route.fetch({ headers: { ...route.request().headers(), ...(onOrigin ? bypass : {}) }, maxRedirects: 0 });
}

function redirectMethod(status: number, method: string): { method: string; dropBody: boolean } {
  const toGet =
    ((status === 301 || status === 302) && method === 'POST') || (status === 303 && !['GET', 'HEAD'].includes(method));
  return toGet ? { method: 'GET', dropBody: true } : { method, dropBody: false };
}

const BODY_HEADERS = ['content-type', 'content-length', 'content-encoding'];

/**
 * Sends a browser request through route.fetch with the header and follows same-origin redirects
 * itself, so no off-origin hop sees the token. A navigation gets its redirect back to follow (the
 * address bar must show the real URL; its next hop goes without the header). A subresource's
 * off-origin hop is fetched here without the header, since Chromium fails both a fulfilled
 * redirect and a cross-origin route.continue url on one. timeout 0 leaves timing to the browser;
 * route.fetch would otherwise abort anything slower than 30s. Bodies are buffered, so a stream
 * reaches the page only once it ends. The page applies no CORS check to an off-origin hop and
 * sees the original URL, so e2e cannot catch a missing CORS header on a redirect target.
 */
async function continueWithBypass(
  route: Route,
  origin: string,
  bypass: Record<string, string>,
  pace?: Pacer
): Promise<void> {
  const request = route.request();
  let url = request.url();
  let method = request.method();
  let headers: Record<string, string> = { ...request.headers(), ...bypass };
  let postData: Buffer | undefined = request.postDataBuffer() ?? undefined;
  try {
    for (let followed = 0; ; followed++) {
      const response = await paced(route.fetch({ url, method, headers, postData, maxRedirects: 0, timeout: 0 }), pace);
      const status = response.status();
      const location = response.headers()['location'];
      if (
        !REDIRECT_STATUSES.has(status) ||
        !location ||
        request.isNavigationRequest() ||
        followed >= DEFAULT_MAX_REDIRECTS
      ) {
        return await route.fulfill({ response });
      }
      const next = new URL(location, url);
      const hop = redirectMethod(status, method);
      method = hop.method;
      if (hop.dropBody) {
        postData = undefined;
        headers = withoutHeaders(headers, BODY_HEADERS) as Record<string, string>;
      }
      await response.dispose();
      if (next.origin !== origin) {
        // A browser drops authorization on a cross-origin redirect too.
        const offOrigin = withoutHeaders(headers, [WAF_BYPASS_HEADER, 'authorization', 'cookie']) as Record<
          string,
          string
        >;
        return await route.fulfill({
          response: await paced(
            route.fetch({ url: next.href, method, postData, headers: offOrigin, timeout: 0 }),
            pace
          ),
        });
      }
      url = next.href;
    }
  } catch {
    // The page closed or the network failed mid-request; fail the request, never send it bare.
    await route.abort().catch(() => {});
  }
}

type Pacer = (bytes: number) => Promise<void>;

/** Concurrent responses share one link's bandwidth, as under the CDP throttle; latency overlaps. */
function linkPacer(link: SlowLink): Pacer {
  let busyUntil = 0;
  return bytes => {
    const now = Date.now();
    busyUntil = Math.max(now, busyUntil) + (bytes / link.downloadThroughput) * 1000;
    return new Promise(resolve => setTimeout(resolve, busyUntil - now + link.latency));
  };
}

async function paced(pending: Promise<APIResponse>, pace?: Pacer): Promise<APIResponse> {
  const response = await pending;
  if (pace) await pace((await response.body()).length);
  return response;
}

function withoutHeaders(headers: FetchOptions['headers'], names: string[]): FetchOptions['headers'] {
  if (!headers) return headers;
  return Object.fromEntries(Object.entries(headers).filter(([key]) => !names.includes(key.toLowerCase())));
}

/**
 * Sends one call with the header and follows redirects itself: Playwright keeps custom headers
 * across a cross-origin redirect, so an off-origin Location is returned unfollowed instead.
 */
async function sendWithBypass(
  ctx: APIRequestContext,
  origin: string,
  bypass: Record<string, string>,
  initialMethod: string,
  url: string,
  options: FetchOptions = {},
  defaultMaxRedirects = DEFAULT_MAX_REDIRECTS
): Promise<APIResponse> {
  const maxRedirects = options.maxRedirects ?? defaultMaxRedirects;
  let method = initialMethod;
  let current: FetchOptions = { ...options };
  let target = url;
  for (let followed = 0; ; followed++) {
    const response = await ctx.fetch(target, {
      ...current,
      method,
      headers: { ...bypass, ...current.headers },
      maxRedirects: 0,
    });
    const location = response.headers()['location'];
    if (!REDIRECT_STATUSES.has(response.status()) || !location || maxRedirects === 0) return response;
    if (followed >= maxRedirects) throw new Error('Max redirect count exceeded');
    const next = new URL(location, new URL(response.url()));
    if (next.origin !== origin) return response;

    const hop = redirectMethod(response.status(), method);
    let headers = withoutHeaders(current.headers, ['cookie']);
    current = { ...current, params: undefined };
    method = hop.method;
    if (hop.dropBody) {
      current = { ...current, data: undefined, form: undefined, multipart: undefined };
      headers = withoutHeaders(headers, BODY_HEADERS);
    }
    current.headers = headers;
    await response.dispose();
    target = next.href;
  }
}

/**
 * Wraps an APIRequestContext so calls to a string URL on the API origin carry the header;
 * Request objects and other origins pass through untouched, and caller headers win. Returns
 * `ctx` itself when the token is unset. `defaultMaxRedirects` mirrors the context's own
 * maxRedirects, which Playwright applies to calls that set none.
 */
export function scopeWafBypass(ctx: APIRequestContext, defaultMaxRedirects = DEFAULT_MAX_REDIRECTS): APIRequestContext {
  const bypass = wafBypassHeaders();
  if (!bypass[WAF_BYPASS_HEADER]) return ctx;
  const origin = apiOrigin();
  return new Proxy(ctx, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      if (typeof prop !== 'string' || !SCOPED_METHODS.has(prop)) return value.bind(target);
      return (urlOrRequest: unknown, options?: FetchOptions) => {
        if (typeof urlOrRequest !== 'string' || new URL(urlOrRequest, origin).origin !== origin) {
          return value.call(target, urlOrRequest, options);
        }
        const method = prop === 'fetch' ? (options?.method ?? 'GET').toUpperCase() : prop.toUpperCase();
        return sendWithBypass(target, origin, bypass, method, urlOrRequest, options, defaultMaxRedirects);
      };
    },
  });
}

export async function newWafRequestContext(
  factory: APIRequest,
  options?: Parameters<APIRequest['newContext']>[0]
): Promise<APIRequestContext> {
  return scopeWafBypass(await factory.newContext(options), options?.maxRedirects ?? DEFAULT_MAX_REDIRECTS);
}
