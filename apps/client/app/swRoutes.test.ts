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
  const origin = 'https://app.example.com';
  const request = (url: string, destination: RequestDestination = '') => ({ url, destination });

  it('leaves Turnstile and other third-party requests to the browser', () => {
    expect(
      bypassesServiceWorker(
        request('https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit', 'script'),
        origin
      )
    ).toBe(true);
    expect(
      bypassesServiceWorker(
        request(
          'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0/rcv/abc',
          'iframe'
        ),
        origin
      )
    ).toBe(true);
    expect(bypassesServiceWorker(request('https://js.stripe.com/v3/', 'script'), origin)).toBe(true);
    expect(bypassesServiceWorker(request('https://tile.openstreetmap.org/1/0/0.png', 'image'), origin)).toBe(true);
    // A host that only shares the origin as a prefix is still cross-origin
    expect(bypassesServiceWorker(request('https://app.example.com.evil.test/x.js', 'script'), origin)).toBe(true);
  });

  it('keeps same-origin static assets and Google Fonts on the service worker', () => {
    expect(bypassesServiceWorker(request(`${origin}/_next/static/chunks/main.js`, 'script'), origin)).toBe(false);
    expect(bypassesServiceWorker(request(`${origin}/`, 'document'), origin)).toBe(false);
    expect(bypassesServiceWorker(request(`${origin}/challenges.cloudflare.com`, 'document'), origin)).toBe(false);
    expect(bypassesServiceWorker(request('https://fonts.googleapis.com/css2?family=Inter', 'style'), origin)).toBe(
      false
    );
    expect(bypassesServiceWorker(request('https://fonts.gstatic.com/s/inter/v1/a.woff2', 'font'), origin)).toBe(false);
  });

  it('leaves same-origin worker entrypoints to the browser', () => {
    expect(bypassesServiceWorker(request(`${origin}/_next/static/chunks/w.js#params=x`, 'worker'), origin)).toBe(true);
    expect(bypassesServiceWorker(request(`${origin}/_next/static/chunks/s.js`, 'sharedworker'), origin)).toBe(true);
  });
});
