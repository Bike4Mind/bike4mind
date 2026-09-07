import { describe, it, expect, vi, afterEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import handler from '../pyodide-sandbox';

/**
 * The sandbox route is a security boundary expressed almost entirely in response headers, so
 * the headers are the thing worth pinning. Guest Python executes in whatever this returns.
 */

function invoke(method = 'GET') {
  const headers: Record<string, string> = {};
  const res = {
    setHeader: vi.fn((key: string, value: string) => {
      headers[key] = value;
    }),
    status: vi.fn(() => res),
    send: vi.fn((body: string) => body),
    end: vi.fn((body?: string) => body),
  } as unknown as NextApiResponse & { send: ReturnType<typeof vi.fn>; status: ReturnType<typeof vi.fn> };

  const body = handler({ method } as NextApiRequest, res);
  return { headers, res, body: typeof body === 'string' ? body : String(res.send.mock.calls[0]?.[0] ?? '') };
}

const directives = (csp: string): Record<string, string> =>
  Object.fromEntries(
    csp.split(';').map(part => {
      const [name, ...rest] = part.trim().split(/\s+/);
      return [name, rest.join(' ')];
    })
  );

afterEach(() => {
  delete process.env.PYODIDE_BASE_URL;
  vi.unstubAllEnvs();
});

describe('/api/pyodide-sandbox CSP', () => {
  it('denies everything by default', () => {
    const { headers } = invoke();
    expect(directives(headers['Content-Security-Policy'])['default-src']).toBe("'none'");
  });

  it('limits connect-src to the Pyodide distribution, with no path back to the app', () => {
    const { headers } = invoke();
    const connectSrc = directives(headers['Content-Security-Policy'])['connect-src'];

    expect(connectSrc).toBe('https://cdn.jsdelivr.net');
    // 'self' here would hand guest Python the app origin back - the whole defect.
    expect(connectSrc).not.toContain("'self'");
    expect(connectSrc).not.toContain('*');
  });

  it('adds an operator mirror to both script-src and connect-src', () => {
    vi.stubEnv('PYODIDE_BASE_URL', 'https://mirror.internal.example/pyodide/v0.25.1/full/');
    const parsed = directives(invoke().headers['Content-Security-Policy']);

    expect(parsed['connect-src']).toContain('https://mirror.internal.example');
    expect(parsed['script-src']).toContain('https://mirror.internal.example');
    // The pinned CDN stays, so clearing the mirror later cannot strand a deployment.
    expect(parsed['connect-src']).toContain('https://cdn.jsdelivr.net');
  });

  it('refuses a mirror that would inject a second CSP source', () => {
    vi.stubEnv('PYODIDE_BASE_URL', 'https://evil.example; connect-src *');
    const connectSrc = directives(invoke().headers['Content-Security-Policy'])['connect-src'];

    expect(connectSrc).toBe('https://cdn.jsdelivr.net');
    expect(connectSrc).not.toContain('evil.example');
  });

  it('allows only the app to frame it', () => {
    const { headers } = invoke();
    expect(directives(headers['Content-Security-Policy'])['frame-ancestors']).toBe("'self'");
    expect(headers['X-Frame-Options']).toBe('SAMEORIGIN');
  });

  it('permits the blob Worker the sandbox depends on', () => {
    const parsed = directives(invoke().headers['Content-Security-Policy']);
    expect(parsed['worker-src']).toBe('blob:');
    expect(parsed['script-src']).toContain('blob:');
  });
});

describe('/api/pyodide-sandbox document', () => {
  it('serves the shell and announces readiness to its parent', () => {
    const { body, headers } = invoke();
    expect(headers['Content-Type']).toBe('text/html; charset=utf-8');
    expect(body).toContain('pyodide-sandbox-ready');
    expect(body).toContain('new Worker(');
  });

  it('accepts only the framing parent as a message source', () => {
    // Without this any page could drive the sandbox; an opaque origin makes targetOrigin
    // checks impossible, so the source window is the only usable provenance.
    expect(invoke().body).toContain('event.source !== window.parent');
  });

  it('never emits a raw closing script tag inside the inline script', () => {
    // The HTML tokenizer exits script-data state on the first one it sees, which would
    // truncate the shell and dump the worker source into the page as text.
    const body = invoke().body;
    const inlineScript = body.slice(body.indexOf('<script>') + '<script>'.length, body.lastIndexOf('</script>'));
    expect(inlineScript.toLowerCase()).not.toContain('</script');
  });

  it('rejects non-GET methods', () => {
    const { res } = invoke('POST');
    expect(res.status).toHaveBeenCalledWith(405);
  });
});
