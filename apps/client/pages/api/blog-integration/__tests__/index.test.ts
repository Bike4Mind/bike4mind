import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * POST /api/blog-integration saves a user-supplied blog `baseUrl` and test-fetches it
 * server-side with the user's key, so an internal/metadata baseUrl would be an SSRF vector.
 * These pin the shared host guard on that save path (mirrors blog/publish + presign).
 */

const mockRefs = vi.hoisted(() => ({
  post: null as null | ((req: any, res: any) => unknown),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain: any = {
      use: () => chain,
      get: () => chain,
      post: (fn: any) => {
        mockRefs.post = fn;
        return chain;
      },
      delete: () => chain,
    };
    return chain;
  },
}));

const update = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/database', () => ({ userRepository: { findById: vi.fn(), update } }));
vi.mock('@server/security/tokenEncryption', () => ({
  encryptToken: (v: string) => `enc:${v}`,
  decryptToken: (v: string) => `dec:${v}`,
}));

import '../index';

function request(body: unknown) {
  const { req, res } = createMocks({ method: 'POST', body });
  (req as any).user = { id: 'u1' };
  return { req, res };
}

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
