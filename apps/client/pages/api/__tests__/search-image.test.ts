import { describe, it, expect, vi, beforeEach } from 'vitest';
import { signImageUrl } from '@bike4mind/common';

/**
 * /api/search-image serves arbitrary third-party bytes back from the APP origin, so its guards -
 * signature verification, SSRF, content-type, size cap, and the no-persistence/no-shared-cache
 * promise - are the whole point of the route. Captures the raw GET handler past the
 * baseApi/asyncHandler plumbing and drives the real request path. The SSRF classifier itself is
 * covered by ssrfProtection.test.ts.
 */

const TEST_SIGNING_SECRET = vi.hoisted(() => 'test-search-image-signing-secret');
/** Every non-signature test below drives a URL that would actually reach this route in
 *  production - i.e. one websearch/index.ts signed with the configured secret. */
const signed = (url: string) => signImageUrl(url, TEST_SIGNING_SECRET);

const mockRefs = vi.hoisted(() => ({
  handler: null as null | ((req: any, res: any) => unknown),
  baseApiOptions: null as null | Record<string, unknown>,
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (options: any) => {
    mockRefs.baseApiOptions = options;
    const chain: any = {
      use: () => chain,
      get: (fn: any) => {
        mockRefs.handler = fn;
        return chain;
      },
    };
    return chain;
  },
}));

vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: any) => fn }));

vi.mock('@server/utils/config', () => ({ Config: { SECRET_ENCRYPTION_KEY: TEST_SIGNING_SECRET } }));

const tryIncrement = vi.hoisted(() => vi.fn(async () => ({ success: true, expiresAt: new Date() })));
vi.mock('@bike4mind/database', () => ({
  cacheRepository: { tryIncrementWithinLimitFixedWindow: tryIncrement },
}));

vi.mock('dns', () => {
  const resolve4 = (host: string, cb: (e: Error | null, a?: string[]) => void) =>
    cb(null, /(^|\.)nip\.io$/.test(host) ? ['127.0.0.1'] : ['93.184.216.34']);
  const resolve6 = (_host: string, cb: (e: Error | null, a?: string[]) => void) => cb(null, []);
  return { default: { resolve4, resolve6 }, resolve4, resolve6 };
});

import '../search-image';

function request(url: string | undefined) {
  const logger = { warn: vi.fn(), info: vi.fn() };
  const res: any = {
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    statusCode: 0,
    setHeader(name: string, value: string) {
      this.headers[name] = value;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    send(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  const req: any = { query: url === undefined ? {} : { url }, logger, user: { id: 'user-1' } };
  return { req, res, logger };
}

/** A Response whose body streams `chunks` once, as the real fetch body does. */
function imageResponse(contentType: string, chunks: Uint8Array[], status = 200): Response {
  let i = 0;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? contentType : null) },
    body: {
      getReader: () => ({
        read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined }),
        cancel: async () => undefined,
        releaseLock: () => undefined,
      }),
    },
  } as unknown as Response;
}

describe('GET /api/search-image', () => {
  const originalFetch = global.fetch;
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = originalFetch;
    tryIncrement.mockResolvedValue({ success: true, expiresAt: new Date() });
  });

  it('is JWT-only: an <img> tag can never carry an API key, so the key chain must not run', () => {
    expect(mockRefs.baseApiOptions).toMatchObject({ auth: 'jwtOnly' });
  });

  it('rejects a URL with no signature - the shape a scripted probe would send', async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as never;
    const { req, res } = request('https://cdn.example.com/a.png');

    await expect(mockRefs.handler!(req, res)).rejects.toThrow('Image URL is not allowed');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // This is the actual exploit the signature closes: a model-authored URL that was never in a
  // search result (e.g. one a hostile page's snippet text steered the model into writing) must
  // fail here before this route ever fetches it server-side.
  it('rejects a URL signed with the wrong secret', async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as never;
    const { req, res } = request(signImageUrl('https://attacker.example.com/beacon?data=leak', 'wrong-secret'));

    await expect(mockRefs.handler!(req, res)).rejects.toThrow('Image URL is not allowed');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a validly-signed URL whose query string was tampered with after signing', async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as never;
    const tampered = signed('https://cdn.example.com/a.png').replace('a.png', 'attacker-payload.png');
    const { req, res } = request(tampered);

    await expect(mockRefs.handler!(req, res)).rejects.toThrow('Image URL is not allowed');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a non-https url', async () => {
    const { req, res } = request(signed('http://example.com/a.png'));
    await expect(mockRefs.handler!(req, res)).rejects.toThrow('Image URL is not allowed');
  });

  // Every signed-in user can reach this route, so the SSRF reason - which names the host and the
  // private address it resolved to - must stay in the log and out of the response, or the route
  // becomes an internal-DNS oracle.
  it('rejects an internal/metadata host, logging the reason but not returning it', async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as never;
    const { req, res, logger } = request(signed('https://169.254.169.254/a.png'));

    await expect(mockRefs.handler!(req, res)).rejects.toThrow('Image URL is not allowed');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      'Blocked SSRF attempt on /api/search-image',
      expect.objectContaining({ reason: expect.stringMatching(/private or internal/i) })
    );
  });

  it('rejects a public NAME that resolves to a private IP, without naming the address', async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as never;
    const { req, res, logger } = request(signed('https://127.0.0.1.nip.io/a.png'));

    const error = await mockRefs.handler!(req, res).catch((e: Error) => e);
    expect((error as Error).message).toBe('Image URL is not allowed');
    expect((error as Error).message).not.toMatch(/127\.0\.0\.1/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      'Blocked SSRF attempt on /api/search-image',
      expect.objectContaining({ reason: expect.stringMatching(/private IP/i) })
    );
  });

  it('refuses a caller over the per-user minute cap before fetching anything', async () => {
    tryIncrement.mockResolvedValue({ success: false, expiresAt: new Date(Date.now() + 30_000) });
    const fetchMock = vi.fn();
    global.fetch = fetchMock as never;
    const { req, res } = request(signed('https://cdn.example.com/a.png'));

    await expect(mockRefs.handler!(req, res)).rejects.toThrow(/too many/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects image/svg+xml - it would run as a scriptable document on the app origin', async () => {
    global.fetch = vi.fn().mockResolvedValue(imageResponse('image/svg+xml', [])) as never;
    const { req, res } = request(signed('https://cdn.example.com/a.svg'));

    await expect(mockRefs.handler!(req, res)).rejects.toThrow(/not an image/i);
  });

  it('rejects a non-image content-type', async () => {
    global.fetch = vi.fn().mockResolvedValue(imageResponse('text/html', [])) as never;
    const { req, res } = request(signed('https://cdn.example.com/a.png'));

    await expect(mockRefs.handler!(req, res)).rejects.toThrow(/not an image/i);
  });

  it('aborts an oversized body rather than buffering it', async () => {
    const sixMb = [new Uint8Array(6 * 1024 * 1024)];
    global.fetch = vi.fn().mockResolvedValue(imageResponse('image/png', sixMb)) as never;
    const { req, res } = request(signed('https://cdn.example.com/huge.png'));

    await expect(mockRefs.handler!(req, res)).rejects.toThrow(/too large/i);
  });

  it('streams a valid image back inline, cached privately and never persisted', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const fetchMock = vi.fn().mockResolvedValue(imageResponse('image/webp; charset=binary', [bytes]));
    global.fetch = fetchMock as never;
    const { req, res } = request(signed('https://cdn.example.com/a.webp'));

    await mockRefs.handler!(req, res);

    expect(res.statusCode).toBe(200);
    expect(Buffer.from(res.body as Buffer)).toEqual(Buffer.from(bytes));
    // The charset parameter must be stripped, or the executable-type check compares the wrong string.
    expect(res.headers['Content-Type']).toBe('image/webp');
    expect(res.headers['X-Content-Type-Options']).toBe('nosniff');
    // `private`, not `public`: one user's search thumbnails must not land in a shared cache.
    expect(res.headers['Cache-Control']).toMatch(/^private, max-age=\d+$/);
    // stripImageUrlSignature must run before the upstream fetch: the app's own b4mExp/b4mSig
    // params are never the app's business to send to a third-party host.
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://cdn.example.com/a.webp');
  });

  it('maps an abort during the body read to the timeout error, not a bare AbortError', async () => {
    // The 8s timer is armed across the body read too (a slow-drip upstream would otherwise stay
    // under the size cap forever), so an abort can fire from the reader, not just from safeFetch.
    // A bare AbortError would map to a 500 in errorHandler.ts and page on-call.
    const response: Response = {
      ok: true,
      status: 200,
      headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? 'image/png' : null) },
      body: {
        getReader: () => ({
          read: async () => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            throw err;
          },
          cancel: async () => undefined,
          releaseLock: () => undefined,
        }),
      },
    } as unknown as Response;
    global.fetch = vi.fn().mockResolvedValue(response) as never;
    const { req, res } = request(signed('https://cdn.example.com/slow.png'));

    await expect(mockRefs.handler!(req, res)).rejects.toThrow(/timed out/i);
  });

  it('surfaces an upstream failure instead of serving an empty body', async () => {
    global.fetch = vi.fn().mockResolvedValue(imageResponse('image/png', [], 404)) as never;
    const { req, res } = request(signed('https://cdn.example.com/missing.png'));

    await expect(mockRefs.handler!(req, res)).rejects.toThrow(/404/);
  });
});
