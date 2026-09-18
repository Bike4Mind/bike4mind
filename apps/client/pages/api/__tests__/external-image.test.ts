import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * external-image.ts is the one route where the SSRF guard stands between an admin and an
 * arbitrary-URL fetch of up to 10MB, so it wants a route-level regression test (the classifier is
 * exercised in isolation by ssrfProtection.test.ts). Captures the raw GET handler past the
 * baseApi/asyncHandler plumbing, then drives the real request path: admin gate, assertUrlAllowed,
 * and the safeFetch redirect re-check.
 */

const mockRefs = vi.hoisted(() => ({ handler: null as null | ((req: any, res: any) => unknown) }));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
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

// asyncHandler just awaits and rethrows; identity keeps the captured handler directly awaitable.
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: any) => fn }));

// Only override createS3Client - the same package also provides the SSRF classifier the route's
// guard relies on, so keep the rest of @bike4mind/fab-pipeline real.
const sendMock = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/fab-pipeline', async importActual => {
  const actual = await importActual<Record<string, unknown>>();
  return { ...actual, createS3Client: () => ({ send: sendMock }) };
});

vi.mock('sst', () => ({ Resource: { appFilesBucket: { name: 'test-bucket' } } }));

// The SSRF gate resolves DNS; stub it so public names resolve public and *.nip.io resolves loopback.
vi.mock('dns', () => {
  const resolve4 = (host: string, cb: (e: Error | null, a?: string[]) => void) =>
    cb(null, /(^|\.)nip\.io$/.test(host) ? ['127.0.0.1'] : ['93.184.216.34']);
  const resolve6 = (_host: string, cb: (e: Error | null, a?: string[]) => void) => cb(null, []);
  return { default: { resolve4, resolve6 }, resolve4, resolve6 };
});

import '../external-image';

function request(url: string | undefined, isAdmin = true) {
  const logger = { warn: vi.fn(), info: vi.fn() };
  const req: any = { user: { isAdmin }, query: url === undefined ? {} : { url }, logger };
  const res: any = { redirect: vi.fn(), json: vi.fn() };
  return { req, res, logger };
}

describe('GET /api/external-image - SSRF guarding', () => {
  const originalFetch = global.fetch;
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = originalFetch;
    process.env.NEXT_PUBLIC_CDN_URL = 'https://cdn.test';
  });

  it('rejects a non-admin caller before touching the URL', async () => {
    const { req, res } = request('https://example.com/a.png', false);
    await expect(mockRefs.handler!(req, res)).rejects.toThrow(/admin/i);
  });

  it('rejects a non-https url', async () => {
    const { req, res } = request('http://example.com/a.png');
    await expect(mockRefs.handler!(req, res)).rejects.toThrow(/https/i);
    expect(global.fetch === originalFetch).toBe(true);
  });

  it('rejects an internal/metadata host and logs the block', async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as never;
    const { req, res, logger } = request('https://169.254.169.254/a.png');
    await expect(mockRefs.handler!(req, res)).rejects.toThrow(/private or internal/i);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      'Blocked SSRF attempt on /api/external-image',
      expect.objectContaining({ reason: expect.stringMatching(/private or internal/i) })
    );
  });

  it('rejects a public NAME that resolves to a private IP (127.0.0.1.nip.io)', async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as never;
    const { req, res } = request('https://127.0.0.1.nip.io/a.png');
    await expect(mockRefs.handler!(req, res)).rejects.toThrow(/private ip/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('blocks a public host that redirects to an internal one (no follow of the redirect)', async () => {
    // Cache miss so the download path runs; the public host 302s to cloud metadata and safeFetch
    // re-checks the Location and refuses to follow it.
    sendMock.mockRejectedValueOnce(Object.assign(new Error('nf'), { name: 'NotFound' })); // HeadObject
    global.fetch = vi.fn().mockResolvedValueOnce({
      status: 302,
      headers: { get: (k: string) => (k.toLowerCase() === 'location' ? 'https://169.254.169.254/' : null) },
    }) as never;

    const { req, res } = request('https://cdn.example.com/a.png');
    await expect(mockRefs.handler!(req, res)).rejects.toThrow(/blocked redirect/i);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('allows a normal public URL through the guard (serves the cached copy)', async () => {
    sendMock.mockResolvedValueOnce({}); // HeadObject hit -> redirect to the CDN, no outbound fetch
    const fetchMock = vi.fn();
    global.fetch = fetchMock as never;

    const { req, res } = request('https://cdn.example.com/a.png');
    await mockRefs.handler!(req, res);

    expect(res.redirect).toHaveBeenCalledWith(302, expect.stringContaining('https://cdn.test/'));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
