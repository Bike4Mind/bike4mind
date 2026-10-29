import { describe, it, expect } from 'vitest';
import { bypassesServiceWorker, isApiPath } from './swRoutes';

describe('isApiPath', () => {
  it('matches Next.js API routes that must never be SW-cached', () => {
    expect(isApiPath('/api/react-artifact-sandbox')).toBe(true);
    expect(isApiPath('/api/artifact-sandbox')).toBe(true);
    expect(isApiPath('/api/publish/serve')).toBe(true);
    expect(isApiPath('/api/overwatch/v1/events')).toBe(true);
    // bare /api with no trailing segment
    expect(isApiPath('/api')).toBe(true);
  });

  it('does not over-match non-API paths', () => {
    // SPA routes and static assets must keep their normal caching behavior
    expect(isApiPath('/')).toBe(false);
    expect(isApiPath('/s/abc123')).toBe(false);
    expect(isApiPath('/_next/static/chunk.js')).toBe(false);
    // prefix collisions that are NOT under /api/
    expect(isApiPath('/apiary')).toBe(false);
    expect(isApiPath('/api-docs')).toBe(false);
    expect(isApiPath('/foo/api/bar')).toBe(false);
  });
});

describe('bypassesServiceWorker', () => {
  it('lets the Turnstile script and widget frame bypass the worker', () => {
    expect(
      bypassesServiceWorker(new URL('https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'))
    ).toBe(true);
    expect(
      bypassesServiceWorker(
        new URL('https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0/rcv/abc')
      )
    ).toBe(true);
  });

  it('keeps every other request on the normal caching path', () => {
    expect(bypassesServiceWorker(new URL('https://app.bike4mind.com/login'))).toBe(false);
    expect(bypassesServiceWorker(new URL('https://app.bike4mind.com/challenges.cloudflare.com'))).toBe(false);
    expect(bypassesServiceWorker(new URL('https://challenges.cloudflare.com.example.com/x'))).toBe(false);
    expect(bypassesServiceWorker(new URL('https://fonts.gstatic.com/s/inter.woff2'))).toBe(false);
  });
});
