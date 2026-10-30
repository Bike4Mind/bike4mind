import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Page, Route } from '@playwright/test';
import { bypassTurnstile } from '../../e2e/helpers/turnstile';
import { installWafBypass } from '../../e2e/helpers/waf-bypass';

const resourceSecret = vi.hoisted(() => ({ value: 'resource-secret' as string | undefined }));
vi.mock('sst', () => ({ Resource: { E2E_CLEANUP_SECRET: resourceSecret } }));

type UrlMatcher = Parameters<Page['route']>[0];
type RouteHandler = Parameters<Page['route']>[1];

// Models Playwright's reverse registration order and header overrides on fallback, so both
// helpers run together. continue terminates dispatch, just as it does in the browser.
function createRoutingHarness() {
  const registrations: { matcher: UrlMatcher; handler: RouteHandler }[] = [];
  const page = {
    route: async (matcher: UrlMatcher, handler: RouteHandler) => {
      registrations.push({ matcher, handler });
    },
  } as unknown as Page;

  async function request(url: string) {
    const target = new URL(url);
    let headers: Record<string, string> = { 'x-existing-header': 'preserved' };
    const matching = registrations.filter(({ matcher }) => {
      if (typeof matcher === 'function') return matcher(target);
      if (matcher instanceof RegExp) return matcher.test(url);
      throw new Error('Secret-bearing routes must use an explicit origin/path predicate');
    });
    const dispatch = async (): Promise<void> => {
      const registration = matching.pop();
      if (!registration) return;
      const route = {
        request: () => ({ headers: () => headers }),
        fallback: async (options?: Parameters<Route['fallback']>[0]) => {
          headers = options?.headers ?? headers;
          await dispatch();
        },
        continue: async (options?: Parameters<Route['continue']>[0]) => {
          headers = options?.headers ?? headers;
        },
      } as unknown as Route;
      await registration.handler(route, route.request());
    };
    await dispatch();
    return headers;
  }

  return { page, request };
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
    await installWafBypass(harness.page);
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
    await installWafBypass(harness.page);
    await bypassTurnstile(harness.page);
    expect(await harness.request(url)).not.toHaveProperty('x-e2e-cleanup-secret');
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
    await installWafBypass(harness.page);
    await bypassTurnstile(harness.page);
    expect(await harness.request('https://api.example.com/api/otc/send')).toEqual({
      'x-existing-header': 'preserved',
      'x-e2e-waf-bypass': 'waf-token',
    });
  });
});
