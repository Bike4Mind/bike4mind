import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

vi.mock('next/server', () => {
  class MockNextResponse {
    public status: number;
    public headers: Headers;
    public forwardedRequestHeaders?: Headers;

    constructor(_body?: string, init?: { status?: number }) {
      this.status = init?.status ?? 200;
      this.headers = new Headers();
    }

    static next(init?: { request?: { headers?: Headers } }) {
      const response = new MockNextResponse();
      response.forwardedRequestHeaders = init?.request?.headers;
      return response;
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

  it('allow-lists every host the ad pixels need, in each directive that governs them', () => {
    const response = proxy(makeRequest('https://app.bike4mind.com/dashboard'));
    const csp = response.headers.get('Content-Security-Policy') ?? '';
    const sources = (name: string) => (csp.match(new RegExp(`${name} ([^;]*)`))?.[1] ?? '').split(/\s+/);

    // A pixel blocked by CSP fails silently - no event, no error anyone sees -
    // so the hosts are asserted rather than left to a live smoke test.
    expect(sources('script-src')).toContain('https://www.redditstatic.com');
    expect(sources('img-src')).toContain('https://alb.reddit.com');
    expect(sources('connect-src')).toEqual(
      expect.arrayContaining(['https://pixel-config.reddit.com', 'https://alb.reddit.com'])
    );

    // fbevents.js chooses an image or sendBeacon transport at runtime, so
    // www.facebook.com has to be on both img-src and connect-src.
    expect(sources('script-src')).toContain('https://connect.facebook.net');
    expect(sources('img-src')).toContain('https://www.facebook.com');
    expect(sources('connect-src')).toContain('https://www.facebook.com');
  });

  // connect-src too: the service worker's image cache re-fetches tiles, and a worker fetch is
  // checked against connect-src, so img-src alone leaves the map blank once the SW is active.
  it.each(['img-src', 'connect-src'])('%s allows the OpenStreetMap tiles the inline location map loads', directive => {
    const response = proxy(makeRequest('https://app.bike4mind.com/dashboard'));
    const csp = response.headers.get('Content-Security-Policy') ?? '';
    const values = (csp.match(new RegExp(`${directive} ([^;]*)`))?.[1] ?? '').split(/\s+/);
    expect(values).toContain('https://tile.openstreetmap.org');
  });

  it('frame-src allows only the -nocookie YouTube host', () => {
    const response = proxy(makeRequest('https://app.bike4mind.com/dashboard'));
    const csp = response.headers.get('Content-Security-Policy') ?? '';
    const frameSrc = csp.match(/frame-src ([^;]*)/)?.[1] ?? '';
    // Help demo embeds hardcode the -nocookie host, so www.youtube.com is never
    // framed. Compare whole tokens: 'https://www.youtube' prefixes both hosts,
    // so a substring check would never fail.
    expect(frameSrc.split(/\s+/)).toContain('https://www.youtube-nocookie.com');
    expect(frameSrc.split(/\s+/)).not.toContain('https://www.youtube.com');
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

  it('does NOT set CSP on /a/ share-link routes (handler sets its own sandbox CSP)', () => {
    const response = proxy(makeRequest('https://app.bike4mind.com/a/lHDIsomeToken'));
    expect(response.headers.get('Content-Security-Policy')).toBeNull();
  });

  it('does NOT clobber Referrer-Policy on /a/ routes (handler sets no-referrer)', () => {
    const share = proxy(makeRequest('https://app.bike4mind.com/a/lHDIsomeToken'));
    expect(share.headers.get('Referrer-Policy')).toBeNull();
    // Other routes still get the app default.
    const page = proxy(makeRequest('https://app.bike4mind.com/home'));
    expect(page.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
  });

  it('does NOT set CSP or X-Frame-Options on /embed/ routes (serve handler sets key-scoped frame-ancestors)', () => {
    // The global CSP would clobber the per-key frame-ancestors and X-Frame-Options:
    // SAMEORIGIN would block the external framing the embed widget exists for.
    const response = proxy(makeRequest('https://app.bike4mind.com/embed/chat?k=b4m_live_x'));
    expect(response.headers.get('Content-Security-Policy')).toBeNull();
    expect(response.headers.get('X-Frame-Options')).toBeNull();
  });

  it('does NOT clobber Referrer-Policy on /embed/ routes (the URL carries the ?k= key)', () => {
    const embed = proxy(makeRequest('https://app.bike4mind.com/embed/chat?k=b4m_live_x'));
    expect(embed.headers.get('Referrer-Policy')).toBeNull();
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

  describe('logged source address', () => {
    function blockTraversal(headers: Record<string, string>): string {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      proxy({
        nextUrl: { pathname: '/../etc/passwd', hostname: 'app.bike4mind.com' },
        url: 'https://app.bike4mind.com/../etc/passwd',
        method: 'GET',
        headers: new Headers(headers),
      } as unknown as NextRequest);
      return String(warn.mock.calls.at(-1)?.[0]);
    }

    afterEach(() => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    });

    it('logs the CloudFront viewer address, not the client-supplied x-forwarded-for', () => {
      const line = blockTraversal({
        'cloudfront-viewer-address': '198.51.100.7:51234',
        'x-forwarded-for': '203.0.113.66',
      });
      expect(line).toContain('from 198.51.100.7');
      expect(line).not.toContain('203.0.113.66');
    });

    it('logs unknown when only x-forwarded-for is present', () => {
      expect(blockTraversal({ 'x-forwarded-for': '203.0.113.66' })).toContain('from unknown');
    });

    it('applies the same rule to the malformed-encoding line', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      proxy({
        nextUrl: { pathname: '/%25zz', hostname: 'app.bike4mind.com' },
        url: 'https://app.bike4mind.com/%25zz',
        method: 'GET',
        headers: new Headers({ 'x-forwarded-for': '203.0.113.66' }),
      } as unknown as NextRequest);
      const line = String(warn.mock.calls.at(-1)?.[0]);
      expect(line).toContain('malformed URL encoding');
      expect(line).toContain('from unknown');
    });

    it('logs the trusted x-forwarded-for hop on self-host', () => {
      vi.stubEnv('B4M_SELF_HOST', 'true');
      vi.stubEnv('TRUSTED_PROXY_HOPS', '1');
      const line = blockTraversal({ 'x-forwarded-for': '203.0.113.66, 198.51.100.7' });
      expect(line).toContain('from 198.51.100.7');
      expect(line).not.toContain('203.0.113.66');
    });
  });
});

describe('proxy CSP for the pdf.js worker', () => {
  it("allows wasm compilation via 'wasm-unsafe-eval' on the worker script, without JS eval", () => {
    const csp = proxy(makeRequest('https://app.bike4mind.com/pdf.worker-6.3.289.min.mjs')).headers.get(
      'Content-Security-Policy'
    );
    const scriptSrc = (csp ?? '').split(';').find(d => d.trim().startsWith('script-src')) ?? '';
    expect(scriptSrc).toContain("'wasm-unsafe-eval'");
    expect(scriptSrc).not.toContain(" 'unsafe-eval'");
  });

  it("allows 'wasm-unsafe-eval' on the legacy unversioned worker path", () => {
    const csp = proxy(makeRequest('https://app.bike4mind.com/pdf.worker.min.mjs')).headers.get(
      'Content-Security-Policy'
    );
    expect(csp).toContain("'wasm-unsafe-eval'");
  });

  it.each([
    '/foo/pdf.worker-6.3.289.min.mjs',
    '/pdf.worker-6.3.289.min.mjs.map',
    '/pdf.worker-x.mjs',
    '/pdf.worker.min.mjs/x',
    '/pdf.worker-x.min.mjs',
    '/pdf.workerXminXmjs',
    '/pdf.worker-6.3.min.mjs',
    '/pdf.worker-6.3.289.mjs',
  ])("keeps 'wasm-unsafe-eval' off near-miss path %s", path => {
    const csp = proxy(makeRequest(`https://app.bike4mind.com${path}`)).headers.get('Content-Security-Policy');
    expect(csp).not.toContain("'wasm-unsafe-eval'");
  });

  it("adds both 'wasm-unsafe-eval' and dev 'unsafe-eval' on the worker path in development", () => {
    vi.stubEnv('NODE_ENV', 'development');
    try {
      const csp = proxy(makeRequest('https://app.bike4mind.com/pdf.worker-6.3.289.min.mjs')).headers.get(
        'Content-Security-Policy'
      );
      const scriptSrc = (csp ?? '').split(';').find(d => d.trim().startsWith('script-src')) ?? '';
      expect(scriptSrc).toContain("'wasm-unsafe-eval'");
      expect(scriptSrc).toContain("'unsafe-eval'");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("keeps 'wasm-unsafe-eval' off app pages", () => {
    const csp = proxy(makeRequest('https://app.bike4mind.com/dashboard')).headers.get('Content-Security-Policy');
    expect(csp).not.toContain("'wasm-unsafe-eval'");
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

describe('proxy CSP - optional PYODIDE_BASE_URL mirror', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const directive = (csp: string, name: string): string =>
    csp
      .split(';')
      .map(d => d.trim())
      .find(d => d.startsWith(`${name} `)) ?? '';

  it('adds a valid mirror origin (no path) to both script-src and connect-src', () => {
    vi.stubEnv('PYODIDE_BASE_URL', 'http://mirror.local:8080/pyodide/v0.25.1/full/');
    const csp = proxy(makeRequest('https://app.bike4mind.com/dashboard')).headers.get('Content-Security-Policy') ?? '';
    expect(directive(csp, 'script-src')).toContain('http://mirror.local:8080');
    expect(directive(csp, 'connect-src')).toContain('http://mirror.local:8080');
    expect(csp).not.toContain('/pyodide/v0.25.1/full/');
  });

  it('warns and omits an invalid mirror value rather than injecting extra directives', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('PYODIDE_BASE_URL', 'http://evil ; script-src none');
    const csp = proxy(makeRequest('https://app.bike4mind.com/dashboard')).headers.get('Content-Security-Policy') ?? '';
    expect(csp).not.toContain('evil');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('adds nothing when unset, empty, or invalid - byte-identical to the no-var baseline', () => {
    const url = 'https://app.bike4mind.com/dashboard';
    // afterEach clears stubs and PYODIDE_BASE_URL is not in the base env, so this is the no-var baseline.
    const baseline = proxy(makeRequest(url)).headers.get('Content-Security-Policy') ?? '';
    expect(baseline).toContain('https://cdn.jsdelivr.net'); // the default CDN is already allow-listed

    vi.stubEnv('PYODIDE_BASE_URL', '');
    expect(proxy(makeRequest(url)).headers.get('Content-Security-Policy')).toBe(baseline);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('PYODIDE_BASE_URL', 'not a url');
    expect(proxy(makeRequest(url)).headers.get('Content-Security-Policy')).toBe(baseline);
    warn.mockRestore();
  });
});

describe('proxy origin verification', () => {
  const SECRET = 'a'.repeat(48);
  type Forwarded = { status: number; forwardedRequestHeaders?: Headers };

  beforeEach(() => {
    vi.stubEnv('ORIGIN_VERIFY_SECRET', SECRET);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('passes a request carrying the secret and strips the header before handlers see it', () => {
    const response = proxy(
      makeRequest('https://app.bike4mind.com/api/health', { 'x-b4m-origin-verify': SECRET, 'x-other': '1' })
    ) as unknown as Forwarded;
    expect(response.status).toBe(200);
    expect(response.forwardedRequestHeaders?.has('x-b4m-origin-verify')).toBe(false);
    expect(response.forwardedRequestHeaders?.get('x-other')).toBe('1');
  });

  it.each(['/api/health', '/api/v1/chat', '/dashboard'])('403s %s when the header is missing', path => {
    expect(proxy(makeRequest(`https://abc.lambda-url.us-east-2.on.aws${path}`)).status).toBe(403);
  });

  it.each([
    ['wrong', 'b'.repeat(48)],
    ['short', 'a'.repeat(47)],
    ['long', 'a'.repeat(49)],
  ])('403s a %s header value', (_label, value) => {
    const response = proxy(makeRequest('https://app.bike4mind.com/api/health', { 'x-b4m-origin-verify': value }));
    expect(response.status).toBe(403);
  });

  it('never logs the header value', () => {
    proxy(makeRequest('https://app.bike4mind.com/api/health', { 'x-b4m-origin-verify': 'leaked-value' }));
    expect(String(vi.mocked(console.warn).mock.calls)).not.toContain('leaked-value');
  });

  it('does not gate or rewrite request headers when the secret is unset', () => {
    vi.stubEnv('ORIGIN_VERIFY_SECRET', '');
    const response = proxy(makeRequest('https://app.bike4mind.com/api/health')) as unknown as Forwarded;
    expect(response.status).toBe(200);
    expect(response.forwardedRequestHeaders).toBeUndefined();
  });
});

describe('proxy configured object-store origin', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const policy = () => proxy(makeRequest('https://app.example.invalid/home')).headers.get('Content-Security-Policy')!;
  const directives = (csp: string) =>
    Object.fromEntries(
      csp
        .split(';')
        .filter(part => part.trim())
        .map(part => {
          const [name, ...sources] = part.trim().split(/\s+/);
          return [name, sources];
        })
    );

  it.each([
    [' http://127.0.0.1:19000/ ', 'http://127.0.0.1:19000'],
    ['https://objects.example.invalid/prefix?value=1#fragment', 'https://objects.example.invalid'],
    ['https://user:fixture@objects.example.invalid:443/path', 'https://objects.example.invalid'],
  ])('adds only the normalized object-store origin for %s', (configured, origin) => {
    vi.stubEnv('S3_PRESIGN_ENDPOINT', '');
    const baseline = directives(policy());
    vi.stubEnv('S3_PRESIGN_ENDPOINT', configured);
    const actual = directives(policy());
    expect(Object.keys(actual)).toEqual(Object.keys(baseline));
    for (const [name, sources] of Object.entries(baseline)) {
      expect(actual[name]).toEqual(
        ['connect-src', 'img-src', 'media-src'].includes(name) ? [...sources, origin] : sources
      );
    }
  });

  it('keeps the complete default policy unchanged when unset or blank', () => {
    vi.stubEnv('S3_PRESIGN_ENDPOINT', undefined);
    const baseline = policy();
    for (const blank of ['', '   ']) {
      vi.stubEnv('S3_PRESIGN_ENDPOINT', blank);
      expect(policy()).toBe(baseline);
    }
  });

  it.each([
    'not-a-url',
    'ftp://objects.example.invalid',
    'https://objects.example.invalid;extra',
    'https://objects.example.invalid\n.other',
    'https://*.example.invalid',
    'https://objects,example.invalid',
    'https://objects.example.invalid\u0001',
    'https://objects.example.invalid\u007f',
  ])('omits invalid configuration with a value-free diagnostic: %s', configured => {
    vi.stubEnv('S3_PRESIGN_ENDPOINT', '');
    const baseline = policy();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('S3_PRESIGN_ENDPOINT', configured);
    expect(policy()).toBe(baseline);
    expect(warn).toHaveBeenCalledExactlyOnceWith('[csp] ignoring invalid S3_PRESIGN_ENDPOINT');
  });

  it.each(['/api/files', '/p/example', '/embed/chat'])('preserves policy exclusions for %s', path => {
    vi.stubEnv('S3_PRESIGN_ENDPOINT', 'https://objects.example.invalid');
    expect(proxy(makeRequest(`https://app.example.invalid${path}`)).headers.get('Content-Security-Policy')).toBeNull();
  });
});
