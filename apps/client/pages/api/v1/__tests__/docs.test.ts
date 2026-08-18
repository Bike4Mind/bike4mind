import { describe, it, expect } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import handler from '../docs';

interface Captured {
  res: NextApiResponse;
  headers: Record<string, string>;
  getStatus: () => number;
  getBody: () => string;
}

function makeRes(): Captured {
  const headers: Record<string, string> = {};
  let statusCode = 200;
  let body = '';
  const res = {
    setHeader: (k: string, v: string) => {
      headers[k] = v;
    },
    status(code: number) {
      statusCode = code;
      return res;
    },
    send(payload: string) {
      body = payload ?? '';
      return res;
    },
    end(payload?: string) {
      if (payload !== undefined) body = payload;
      return res;
    },
  } as unknown as NextApiResponse;
  return { res, headers, getStatus: () => statusCode, getBody: () => body };
}

function makeReq(method: 'GET' | 'HEAD' | 'POST'): NextApiRequest {
  return { method, headers: {} } as unknown as NextApiRequest;
}

describe('GET /api/v1/docs', () => {
  it('returns 200 text/html that loads the vendored Scalar bundle and points at the spec', () => {
    const { res, getStatus, getBody, headers } = makeRes();
    handler(makeReq('GET'), res);
    expect(getStatus()).toBe(200);
    expect(headers['Content-Type']).toContain('text/html');
    const html = getBody();
    // Same-origin vendored bundle - never a CDN host.
    expect(html).toContain('/scalar/scalar.standalone.js');
    expect(html).not.toMatch(/https?:\/\/[^"']*scalar/);
    expect(html).toContain('/api/v1/openapi.json');
    // Self-contained: no hosted fonts, and the Agent (which calls api.scalar.com)
    // is disabled, so the page makes zero cross-origin requests.
    expect(html).toContain('"withDefaultFonts":false');
    expect(html).toContain('"agent":{"disabled":true}');
  });

  it('sets a scoped CSP with script-src self (no CDN, no unsafe-eval)', () => {
    const { res, headers } = makeRes();
    handler(makeReq('GET'), res);
    const csp = headers['Content-Security-Policy'];
    expect(csp).toBeTruthy();
    expect(csp).toMatch(/script-src 'self'(;| )/);
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).not.toContain('cdn.jsdelivr.net');
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("object-src 'none'");
  });

  it('sets the standard HTML security headers', () => {
    const { res, headers } = makeRes();
    handler(makeReq('GET'), res);
    expect(headers['X-Frame-Options']).toBe('SAMEORIGIN');
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['Referrer-Policy']).toBeTruthy();
  });

  it('responds to HEAD with headers but no body', () => {
    const { res, getStatus, getBody, headers } = makeRes();
    handler(makeReq('HEAD'), res);
    expect(getStatus()).toBe(200);
    expect(getBody()).toBe('');
    expect(headers['Content-Security-Policy']).toBeTruthy();
  });

  it('rejects non-GET/HEAD methods with 405', () => {
    const { res, getStatus, headers } = makeRes();
    handler(makeReq('POST'), res);
    expect(getStatus()).toBe(405);
    expect(headers['Allow']).toBe('GET, HEAD');
  });

  // Mirror of the artifact-sandbox footgun guard: a stray </script> inside a
  // <script> block would truncate the page.
  it('contains no premature </script> that would truncate an inline script block', () => {
    const { res, getBody } = makeRes();
    handler(makeReq('GET'), res);
    const html = getBody();
    let i = 0;
    let consumed = 0;
    while (true) {
      const open = html.indexOf('<script', i);
      if (open === -1) break;
      const openEnd = html.indexOf('>', open);
      expect(openEnd).toBeGreaterThan(-1);
      const close = html.indexOf('</script>', openEnd);
      expect(close).toBeGreaterThan(-1);
      consumed++;
      i = close + '</script>'.length;
    }
    const totalCloses = (html.match(/<\/script>/gi) || []).length;
    expect(consumed).toBe(totalCloses);
    expect(consumed).toBeGreaterThan(0);
  });
});
