import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * POST /api/blog-integration saves a user-supplied blog `baseUrl` and test-fetches it
 * server-side with the user's key, so an internal/metadata baseUrl would be an SSRF vector.
 * These pin the shared host guard on that save path (mirrors blog/publish + presign).
 */

type Handler = (req: unknown, res: unknown) => unknown;
const mockRefs = vi.hoisted(() => ({
  get: null as null | Handler,
  post: null as null | Handler,
}));

// The pinned client forwards to global fetch so these cases can stub the upstream.
vi.mock('@bike4mind/fab-pipeline/ssrf', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/fab-pipeline/ssrf')>()),
  createPinnedFetch: () =>
    Object.assign((input: string | URL, init?: RequestInit) => globalThis.fetch(input, init), {
      close: async () => undefined,
    }),
}));
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain = {
      use: () => chain,
      get: (fn: Handler) => {
        mockRefs.get = fn;
        return chain;
      },
      post: (fn: Handler) => {
        mockRefs.post = fn;
        return chain;
      },
      delete: () => chain,
    };
    return chain;
  },
}));

const { update, findById } = vi.hoisted(() => ({ update: vi.fn(), findById: vi.fn() }));
vi.mock('@bike4mind/database', () => ({ userRepository: { findById, update } }));
vi.mock('@bike4mind/server-utils/security/tokenEncryption', () => ({
  encryptToken: (v: string) => `enc:${v}`,
  decryptToken: (v: string) => v.replace(/^enc:/, ''),
}));

// The SSRF gate resolves DNS; stub it so blog.example.com is public and *.nip.io is loopback.
vi.mock('dns', () => {
  const resolve4 = (host: string, cb: (e: Error | null, a?: string[]) => void) =>
    cb(null, /(^|\.)nip\.io$/.test(host) ? ['127.0.0.1'] : ['93.184.216.34']);
  const resolve6 = (_host: string, cb: (e: Error | null, a?: string[]) => void) => cb(null, []);
  return { default: { resolve4, resolve6 }, resolve4, resolve6 };
});

import '../index';

function request(body: unknown) {
  const { req, res } = createMocks({ method: 'POST', body });
  Object.assign(req, { user: { id: 'u1' } });
  return { req, res };
}

describe('GET /api/blog-integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  it('returns only the last four characters of the decrypted key', async () => {
    findById.mockResolvedValue({
      blogIntegration: { apiKey: 'enc:prefix-1234abcd', baseUrl: 'https://blog.example.com' },
    });
    const { req, res } = createMocks({ method: 'GET' });
    Object.assign(req, { user: { id: 'u1' } });

    await mockRefs.get!(req, res);

    expect(res._getStatusCode()).toBe(200);
    const body = res._getJSONData();
    expect(body.settings.apiKeyPreview).toBe('...abcd');
    expect(JSON.stringify(body)).not.toContain('prefix');
  });

  it.each(['', 'a', 'abc', 'abcd'])('fully masks the short key %j', async apiKey => {
    findById.mockResolvedValue({ blogIntegration: { apiKey: `enc:${apiKey}` } });
    const { req, res } = createMocks({ method: 'GET' });
    Object.assign(req, { user: { id: 'u1' } });

    await mockRefs.get!(req, res);

    expect(res._getJSONData().settings.apiKeyPreview).toBe('****');
  });
});

describe('POST /api/blog-integration', () => {
  const originalFetch = global.fetch;
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = originalFetch;
  });

  it('rejects an internal/private or non-https baseUrl before testing or saving it', async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as never;
    for (const baseUrl of [
      'https://169.254.169.254',
      'https://localhost',
      'https://10.0.0.5',
      'http://blog.example.com',
    ]) {
      const { req, res } = request({ apiKey: 'k', baseUrl });
      await mockRefs.post!(req, res);
      expect(res._getStatusCode()).toBe(400);
      expect(res._getJSONData().message).toMatch(/not allowed/i);
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('blocks a public baseUrl that redirects to an internal host (no follow, no save)', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      status: 302,
      headers: { get: (k: string) => (k.toLowerCase() === 'location' ? 'https://169.254.169.254/' : null) },
    });
    global.fetch = fetchMock as never;

    const { req, res } = request({ apiKey: 'k', baseUrl: 'https://blog.example.com' });
    await mockRefs.post!(req, res);

    expect(res._getStatusCode()).toBe(400);
    expect(res._getJSONData().message).toMatch(/not allowed/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
  });

  it('rejects a public baseUrl that resolves to a private IP (127.0.0.1.nip.io), without saving', async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as never;
    const { req, res } = request({ apiKey: 'k', baseUrl: 'https://127.0.0.1.nip.io' });
    await mockRefs.post!(req, res);
    expect(res._getStatusCode()).toBe(400);
    expect(res._getJSONData().message).toMatch(/not allowed/i);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('tests and saves a valid public https baseUrl', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({ status: 200 }) as never;

    const { req, res } = request({ apiKey: 'k', baseUrl: 'https://blog.example.com' });
    await mockRefs.post!(req, res);

    expect(global.fetch).toHaveBeenCalledWith(
      'https://blog.example.com/api/posts',
      expect.objectContaining({ method: 'GET', redirect: 'manual' })
    );
    expect(update).toHaveBeenCalledTimes(1);
    expect(res._getJSONData().success).toBe(true);
  });
});
