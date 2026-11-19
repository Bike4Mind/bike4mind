import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const dataOrigins = vi.hoisted(() => ({ current: [] as string[] }));
vi.mock('@server/utils/pythonArtifactDataOrigins', () => ({
  loadPythonArtifactDataOrigins: vi.fn(async () => dataOrigins.current),
}));

import handler from '../pyodide-sandbox';
import htmlSandboxHandler from '../artifact-sandbox';
import reactSandboxHandler from '../react-artifact-sandbox';

/**
 * The sandbox route is a security boundary expressed almost entirely in response headers, so
 * the headers are the thing worth pinning. Guest Python executes in whatever this returns.
 */

type Handler = (req: NextApiRequest, res: NextApiResponse) => unknown;

async function invokeHandler(target: Handler, method = 'GET') {
  const headers: Record<string, string> = {};
  const res = {
    setHeader: vi.fn((key: string, value: string) => {
      headers[key] = value;
    }),
    status: vi.fn(() => res),
    send: vi.fn((body: string) => body),
    end: vi.fn((body?: string) => body),
  } as unknown as NextApiResponse & { send: ReturnType<typeof vi.fn>; status: ReturnType<typeof vi.fn> };

  const body = await target(
    { method, query: {}, headers: { host: 'app.example.com' } } as unknown as NextApiRequest,
    res
  );
  return { headers, res, body: typeof body === 'string' ? body : String(res.send.mock.calls[0]?.[0] ?? '') };
}

const invoke = (method = 'GET') => invokeHandler(handler, method);

const directives = (csp: string): Record<string, string> =>
  Object.fromEntries(
    csp.split(';').map(part => {
      const [name, ...rest] = part.trim().split(/\s+/);
      return [name, rest.join(' ')];
    })
  );

// The header this route sent before data origins existed, pinned verbatim: with no origin listed
// it must not change by a byte.
const CSP_WITH_NO_DATA_ORIGINS = [
  "default-src 'none'",
  "script-src 'unsafe-inline' blob: 'wasm-unsafe-eval' https://cdn.jsdelivr.net",
  'connect-src https://cdn.jsdelivr.net',
  'worker-src blob:',
  "style-src 'none'",
  "img-src 'none'",
  "font-src 'none'",
  "media-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  'child-src blob:',
  "frame-ancestors 'self'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

beforeEach(() => {
  dataOrigins.current = [];
});

afterEach(() => {
  delete process.env.PYODIDE_BASE_URL;
  vi.unstubAllEnvs();
});

describe('/api/pyodide-sandbox CSP', () => {
  it('denies everything by default', async () => {
    const { headers } = await invoke();
    expect(directives(headers['Content-Security-Policy'])['default-src']).toBe("'none'");
  });

  it('limits connect-src to the Pyodide distribution, with no path back to the app', async () => {
    const { headers } = await invoke();
    const connectSrc = directives(headers['Content-Security-Policy'])['connect-src'];

    expect(connectSrc).toBe('https://cdn.jsdelivr.net');
    // 'self' here would hand guest Python the app origin back - the whole defect.
    expect(connectSrc).not.toContain("'self'");
    expect(connectSrc).not.toContain('*');
  });

  it('sends exactly the pre-existing header when no data origin is listed', async () => {
    const { headers } = await invoke();
    expect(headers['Content-Security-Policy']).toBe(CSP_WITH_NO_DATA_ORIGINS);
  });

  it('adds an operator mirror to both script-src and connect-src', async () => {
    vi.stubEnv('PYODIDE_BASE_URL', 'https://mirror.internal.example/pyodide/v0.25.1/full/');
    const parsed = directives((await invoke()).headers['Content-Security-Policy']);

    expect(parsed['connect-src']).toContain('https://mirror.internal.example');
    expect(parsed['script-src']).toContain('https://mirror.internal.example');
    // The pinned CDN stays, so clearing the mirror later cannot strand a deployment.
    expect(parsed['connect-src']).toContain('https://cdn.jsdelivr.net');
  });

  it('refuses a mirror that would inject a second CSP source', async () => {
    vi.stubEnv('PYODIDE_BASE_URL', 'https://evil.example; connect-src *');
    const connectSrc = directives((await invoke()).headers['Content-Security-Policy'])['connect-src'];

    expect(connectSrc).toBe('https://cdn.jsdelivr.net');
    expect(connectSrc).not.toContain('evil.example');
  });

  it('allows only the app to frame it', async () => {
    const { headers } = await invoke();
    expect(directives(headers['Content-Security-Policy'])['frame-ancestors']).toBe("'self'");
    expect(headers['X-Frame-Options']).toBe('SAMEORIGIN');
  });

  it('permits WebAssembly compilation but not string eval', async () => {
    // Pyodide IS WebAssembly, and CSP3 gates wasm compilation on script-src. Omitting this
    // token does not degrade anything - loadPyodide() dies on instantiateStreaming and Python
    // never starts. 'unsafe-eval' stays out: the narrow token allows wasm and still denies
    // js.eval() to guest Python. Both halves measured on a preview.
    const scriptSrc = directives((await invoke()).headers['Content-Security-Policy'])['script-src'];
    expect(scriptSrc).toContain("'wasm-unsafe-eval'");
    expect(scriptSrc).not.toContain("'unsafe-eval' ");
    expect(scriptSrc.split(' ')).not.toContain("'unsafe-eval'");
  });

  it('permits the blob Worker the sandbox depends on', async () => {
    const parsed = directives((await invoke()).headers['Content-Security-Policy']);
    expect(parsed['worker-src']).toBe('blob:');
    expect(parsed['script-src']).toContain('blob:');
  });
});

describe('/api/pyodide-sandbox data origins', () => {
  const LISTED = ['https://data.example.com', 'https://stats.example.net:8443'];

  it('appends listed origins to connect-src after the Pyodide distribution', async () => {
    dataOrigins.current = LISTED;
    const connectSrc = directives((await invoke()).headers['Content-Security-Policy'])['connect-src'];
    expect(connectSrc).toBe(`https://cdn.jsdelivr.net ${LISTED.join(' ')}`);
  });

  it('adds listed origins to no directive other than connect-src', async () => {
    dataOrigins.current = LISTED;
    const csp = (await invoke()).headers['Content-Security-Policy'];
    const withOrigins = directives(csp);
    const without = directives(CSP_WITH_NO_DATA_ORIGINS);

    expect(Object.keys(withOrigins)).toEqual(Object.keys(without));
    for (const [name, value] of Object.entries(withOrigins)) {
      if (name === 'connect-src') continue;
      expect(value, name).toBe(without[name]);
    }
    expect(csp.split('data.example.com')).toHaveLength(2);
  });

  it('does not repeat an origin the distribution already contributes', async () => {
    dataOrigins.current = ['https://cdn.jsdelivr.net', 'https://data.example.com'];
    const connectSrc = directives((await invoke()).headers['Content-Security-Policy'])['connect-src'];
    expect(connectSrc).toBe('https://cdn.jsdelivr.net https://data.example.com');
  });

  it.each([
    ['HTML', htmlSandboxHandler],
    ['React', reactSandboxHandler],
  ])('leaves the %s artifact sandbox with no network', async (_label, sandbox) => {
    const before = (await invokeHandler(sandbox as Handler)).headers['Content-Security-Policy'];
    dataOrigins.current = LISTED;
    const after = (await invokeHandler(sandbox as Handler)).headers['Content-Security-Policy'];

    expect(after).toBe(before);
    expect(directives(after)['connect-src']).toBe("'none'");
    expect(after).not.toContain('data.example.com');
  });
});

describe('/api/pyodide-sandbox document', () => {
  it('serves the shell and announces readiness to its parent', async () => {
    const { body, headers } = await invoke();
    expect(headers['Content-Type']).toBe('text/html; charset=utf-8');
    expect(body).toContain('pyodide-sandbox-ready');
    expect(body).toContain('new Worker(');
  });

  it('accepts only the framing parent as a message source', async () => {
    // Without this any page could drive the sandbox; an opaque origin makes targetOrigin
    // checks impossible, so the source window is the only usable provenance.
    expect((await invoke()).body).toContain('event.source !== window.parent');
  });

  it('never emits a raw closing script tag inside the inline script', async () => {
    // The HTML tokenizer exits script-data state on the first one it sees, which would
    // truncate the shell and dump the worker source into the page as text.
    const body = (await invoke()).body;
    const inlineScript = body.slice(body.indexOf('<script>') + '<script>'.length, body.lastIndexOf('</script>'));
    expect(inlineScript.toLowerCase()).not.toContain('</script');
  });

  it('serves the same document whether or not data origins are listed', async () => {
    const without = (await invoke()).body;
    dataOrigins.current = ['https://data.example.com'];
    expect((await invoke()).body).toBe(without);
  });

  it('rejects non-GET methods', async () => {
    const { res } = await invoke('POST');
    expect(res.status).toHaveBeenCalledWith(405);
  });
});
