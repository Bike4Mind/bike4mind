import { describe, it, expect, vi } from 'vitest';

vi.mock('next/server', () => {
  class MockNextResponse {
    public status: number;
    public headers: Headers;

    constructor(_body?: string, init?: { status?: number }) {
      this.status = init?.status ?? 200;
      this.headers = new Headers();
    }

    static next() {
      return new MockNextResponse();
    }
  }
  return { NextResponse: MockNextResponse };
});

import { proxy } from './proxy';
import type { NextRequest } from 'next/server';

function makeRequest(url: string, headers: Record<string, string> = {}): NextRequest {
  const parsedUrl = new URL(url);
  return {
    nextUrl: parsedUrl,
    url,
    method: 'GET',
    headers: new Headers(headers),
  } as unknown as NextRequest;
}

describe('proxy CSP header', () => {
  it('sets Content-Security-Policy on HTML routes', () => {
    const response = proxy(makeRequest('https://app.bike4mind.com/dashboard'));
    const csp = response.headers.get('Content-Security-Policy') ?? '';
    expect(csp).toBeTruthy();
  });

  it('global style-src does not contain the blanket https: wildcard', () => {
    const response = proxy(makeRequest('https://app.bike4mind.com/dashboard'));
    const csp = response.headers.get('Content-Security-Policy') ?? '';
    // style-src https: was narrowed — HTML artifacts load from /api/artifact-sandbox
    // which sets its own per-response CSP with style-src https:. The global
    // style-src keeps the explicit MailerLite host (the only external stylesheet
    // the app itself loads) but no longer permits arbitrary https: stylesheets.
    expect(csp).toContain("style-src 'self' 'unsafe-inline' https://assets.mailerlite.com");
    // Ensure the blanket `https:` wildcard is not present (only the explicit MailerLite host).
    expect(csp).not.toMatch(/style-src [^;]*\bhttps:(?!\/\/)/);
  });

  it('global style-src includes the MailerLite host so universal.css loads on app pages', () => {
    const response = proxy(makeRequest('https://app.bike4mind.com/new'));
    const csp = response.headers.get('Content-Security-Policy') ?? '';
    expect(csp).toContain('https://assets.mailerlite.com');
  });

  it('CSP header contains only known directives (no leaked source comments)', () => {
    // Guards against accidentally embedding // line comments inside the cspHeader
    // template literal — JS template literals do not strip // comments, so any
    // such line gets concatenated into the runtime header and browsers log
    // "Unrecognized Content-Security-Policy directive" warnings on every page.
    const response = proxy(makeRequest('https://app.bike4mind.com/dashboard'));
    const csp = response.headers.get('Content-Security-Policy') ?? '';
    expect(csp).not.toMatch(/(^|;\s*)\/\//);
    for (const directive of csp
      .split(';')
      .map(d => d.trim())
      .filter(Boolean)) {
      expect(directive).toMatch(/^[a-z-]+(?:\s|$)/);
    }
  });

  it('does NOT set Content-Security-Policy on /api/ routes', () => {
    const response = proxy(makeRequest('https://app.bike4mind.com/api/users'));
    const csp = response.headers.get('Content-Security-Policy');
    expect(csp).toBeNull();
  });

  it('does NOT set Content-Security-Policy on /api/artifact-sandbox (handler sets its own)', () => {
    // The sandbox handler at pages/api/artifact-sandbox.ts sets its own scoped CSP.
    // Middleware must NOT also set the global app CSP or it would conflict.
    const response = proxy(makeRequest('https://app.bike4mind.com/api/artifact-sandbox'));
    const csp = response.headers.get('Content-Security-Policy');
    expect(csp).toBeNull();
  });

  it('does NOT set Content-Security-Policy on /p/ routes', () => {
    const response = proxy(makeRequest('https://app.bike4mind.com/p/some-artifact'));
    const csp = response.headers.get('Content-Security-Policy');
    expect(csp).toBeNull();
  });

  it('does NOT set CSP or X-Frame-Options on /uc/ routes (Approach B isolated origin)', () => {
    // The isolated bundle must be framable by the cross-origin app wrapper; a global
    // X-Frame-Options: SAMEORIGIN here would block that. The handler sets its own CSP.
    const response = proxy(makeRequest('https://pub1.usercontent.app.bike4mind.com/uc/u/u1/my-page'));
    expect(response.headers.get('Content-Security-Policy')).toBeNull();
    expect(response.headers.get('X-Frame-Options')).toBeNull();
  });

  it('sets X-Frame-Options on HTML routes', () => {
    const response = proxy(makeRequest('https://app.bike4mind.com/'));
    expect(response.headers.get('X-Frame-Options')).toBe('SAMEORIGIN');
  });

  it('always sets X-Content-Type-Options nosniff', () => {
    const apiResponse = proxy(makeRequest('https://app.bike4mind.com/api/data'));
    const pageResponse = proxy(makeRequest('https://app.bike4mind.com/home'));
    expect(apiResponse.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(pageResponse.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });
});

describe('proxy security blocking', () => {
  // Plain objects are intentional here — new URL() would normalize these malicious
  // paths before the middleware sees them (e.g. /../etc/passwd → /etc/passwd),
  // defeating the purpose. These tests verify the regex fires on raw unnormalized
  // input, matching what Next.js middleware receives at runtime.
  it('returns 400 for path traversal in pathname', () => {
    const req = {
      nextUrl: { pathname: '/../etc/passwd', hostname: 'app.bike4mind.com' },
      url: 'https://app.bike4mind.com/../etc/passwd',
      method: 'GET',
      headers: new Headers(),
    } as unknown as NextRequest;
    const response = proxy(req);
    expect(response.status).toBe(400);
  });

  it('returns 400 for null byte in URL', () => {
    const req = {
      nextUrl: { pathname: '/page%00', hostname: 'app.bike4mind.com' },
      url: 'https://app.bike4mind.com/page%00',
      method: 'GET',
      headers: new Headers(),
    } as unknown as NextRequest;
    const response = proxy(req);
    expect(response.status).toBe(400);
  });

  it('returns 400 for malformed percent encoding', () => {
    const req = {
      nextUrl: { pathname: '/%25zz', hostname: 'app.bike4mind.com' },
      url: 'https://app.bike4mind.com/%25zz',
      method: 'GET',
      headers: new Headers(),
    } as unknown as NextRequest;
    const response = proxy(req);
    expect(response.status).toBe(400);
  });
});

describe('proxy CSP script-src — dev-only unsafe-eval boundary', () => {
  // #8512 deliberately removed 'unsafe-eval' from the deployed CSP; it is re-added ONLY in
  // development (Turbopack/React dev needs eval()). These cases lock the env boundary so a
  // regression that re-broadens it — or drops the `NODE_ENV === 'development'` guard —
  // fails CI instead of silently re-weakening the production policy.
  const scriptSrc = (url: string): string => {
    const csp = proxy(makeRequest(url)).headers.get('Content-Security-Policy') ?? '';
    return (
      csp
        .split(';')
        .map(d => d.trim())
        .find(d => d.startsWith('script-src')) ?? ''
    );
  };

  it("does NOT include 'unsafe-eval' outside development (vitest defaults NODE_ENV=test)", () => {
    expect(scriptSrc('https://app.bike4mind.com/dashboard')).not.toContain("'unsafe-eval'");
  });

  it("includes 'unsafe-eval' when NODE_ENV === 'development'", () => {
    vi.stubEnv('NODE_ENV', 'development');
    try {
      expect(scriptSrc('https://app.bike4mind.com/dashboard')).toContain("'unsafe-eval'");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
