import { describe, it, expect } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import handler from '../artifact-sandbox';

interface Captured {
  res: NextApiResponse;
  headers: Record<string, string>;
  getStatus: () => number;
  getBody: () => string;
}

// Captures setHeader + status + send into plain objects so assertions are
// trivial. getStatus/getBody are functions, not destructured values, because
// the handler mutates them after the helper returns.
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
  return {
    res,
    headers,
    getStatus: () => statusCode,
    getBody: () => body,
  };
}

function makeReq(method: 'GET' | 'HEAD' | 'POST', headers: Record<string, string> = {}): NextApiRequest {
  return { method, headers } as unknown as NextApiRequest;
}

describe('GET /api/artifact-sandbox', () => {
  it('returns 200 with the sandbox HTML body', () => {
    const { res, getStatus, getBody } = makeRes();
    handler(makeReq('GET'), res);
    expect(getStatus()).toBe(200);
    expect(getBody()).toContain('artifact-sandbox-ready');
    expect(getBody()).toContain('artifact-html');
  });

  it('sets text/html content type', () => {
    const { res, headers } = makeRes();
    handler(makeReq('GET'), res);
    expect(headers['Content-Type']).toContain('text/html');
  });

  // These headers were missing on /artifact-sandbox.html when it was a public/
  // file. Verified inline here so the deployment regression cannot recur
  // silently: proxy.test.ts can't catch this gap because the public/ file
  // bypassed middleware entirely in production.
  it('sets Content-Security-Policy with style-src https: scoped to this route', () => {
    const { res, headers } = makeRes();
    handler(makeReq('GET'), res);
    const csp = headers['Content-Security-Policy'];
    expect(csp).toBeTruthy();
    expect(csp).toMatch(/style-src [^;]*\bhttps:/);
  });

  it('pins the blessed app-host libraries in script-src (absolutized to the request origin)', () => {
    const { res, headers } = makeRes();
    handler(makeReq('GET', { host: 'localhost:3000' }), res);
    const csp = headers['Content-Security-Policy'];
    // The blessed chart.js lib, absolutized to the request origin, must be an allowed script src
    // so an opaque-origin sandbox can load the self-hosted lib (mirrors the publish viewer).
    expect(csp).toContain('http://localhost:3000/static/lib/chart.js@4.x.js');
    // Inline scripts (the artifact's own JS) and the public CDNs remain allowed.
    expect(csp).toMatch(/script-src [^;]*'unsafe-inline'/);
    expect(csp).toMatch(/script-src [^;]*https:\/\/cdn\.jsdelivr\.net/);
  });

  it("sets connect-src 'none' so artifact scripts cannot fetch/XHR/WebSocket out", () => {
    const { res, headers } = makeRes();
    handler(makeReq('GET'), res);
    expect(headers['Content-Security-Policy']).toContain("connect-src 'none'");
  });

  it('sets frame-src none so artifact content cannot nest iframes', () => {
    const { res, headers } = makeRes();
    handler(makeReq('GET'), res);
    expect(headers['Content-Security-Policy']).toContain("frame-src 'none'");
  });

  it('sets object-src none', () => {
    const { res, headers } = makeRes();
    handler(makeReq('GET'), res);
    expect(headers['Content-Security-Policy']).toContain("object-src 'none'");
  });

  it('sets X-Frame-Options, X-XSS-Protection, X-Content-Type-Options', () => {
    const { res, headers } = makeRes();
    handler(makeReq('GET'), res);
    expect(headers['X-Frame-Options']).toBe('SAMEORIGIN');
    expect(headers['X-XSS-Protection']).toBe('1; mode=block');
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
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

  // Defense-in-depth mirror of the footgun guard (see react-artifact-sandbox.test.ts):
  // this template-literal-baked shell has one balanced <script> block today, but any future
  // inline <script> with a literal `</script>` in a comment/string would silently truncate it.
  // Once inside <script ...>, the HTML tokenizer exits ONLY on a literal `</script>` (JS
  // comments/strings are invisible to it), so a stray closer ends the block early.
  it('contains no premature </script> that would truncate the inline sandbox script', () => {
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
      expect(close).toBeGreaterThan(-1); // every opened block must close
      consumed++;
      i = close + '</script>'.length;
    }
    // Every </script> must be consumed as a real terminator; a leftover closer (e.g. one
    // buried in a comment) means a block ended early, which is the exact bug.
    const totalCloses = (html.match(/<\/script>/gi) || []).length;
    expect(consumed).toBe(totalCloses);
    expect(consumed).toBeGreaterThan(0);
  });
});
