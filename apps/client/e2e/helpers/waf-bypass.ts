import type { APIRequest, APIRequestContext, APIResponse, BrowserContext, Page } from '@playwright/test';

const WAF_BYPASS_HEADER = 'x-e2e-waf-bypass';
const SCOPED_METHODS = new Set(['fetch', 'get', 'post', 'put', 'patch', 'delete', 'head']);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
// Playwright's own default for APIRequestContext calls.
const DEFAULT_MAX_REDIRECTS = 20;

type FetchOptions = NonNullable<Parameters<APIRequestContext['fetch']>[1]>;

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
 * output before upload. Install it before other routes: later handlers run first and must
 * route.fallback() to reach it.
 */
export async function installWafBypass(target: Page | BrowserContext): Promise<void> {
  const headers = wafBypassHeaders();
  if (!headers[WAF_BYPASS_HEADER]) return;
  const origin = apiOrigin();
  await target.route(
    url => url.origin === origin,
    route => route.continue({ headers: { ...route.request().headers(), ...headers } })
  );
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
  options: FetchOptions = {}
): Promise<APIResponse> {
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
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

    const status = response.status();
    let headers = withoutHeaders(current.headers, ['cookie']);
    current = { ...current, params: undefined };
    if (
      ((status === 301 || status === 302) && method === 'POST') ||
      (status === 303 && !['GET', 'HEAD'].includes(method))
    ) {
      method = 'GET';
      current = { ...current, data: undefined, form: undefined, multipart: undefined };
      headers = withoutHeaders(headers, ['content-type', 'content-length', 'content-encoding']);
    }
    current.headers = headers;
    await response.dispose();
    target = next.href;
  }
}

/**
 * Wraps an APIRequestContext so calls to a string URL on the API origin carry the header;
 * Request objects and other origins pass through untouched, and caller headers win. Returns
 * `ctx` itself when the token is unset.
 */
export function scopeWafBypass(ctx: APIRequestContext): APIRequestContext {
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
        return sendWithBypass(target, origin, bypass, method, urlOrRequest, options);
      };
    },
  });
}

export async function newWafRequestContext(
  factory: APIRequest,
  options?: Parameters<APIRequest['newContext']>[0]
): Promise<APIRequestContext> {
  return scopeWafBypass(await factory.newContext(options));
}
