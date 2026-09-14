import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * publish.ts fetches a user-configured blog baseUrl server-side with the user's key, so an
 * internal/metadata baseUrl would be an SSRF vector. These pin the shared host guard on that
 * outbound POST (mirrors presign-image-upload.ts).
 */

const mockRefs = vi.hoisted(() => ({
  handler: null as null | ((req: any, res: any) => unknown),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain: any = {
      use: () => chain,
      post: (fn: any) => {
        mockRefs.handler = fn;
        return chain;
      },
    };
    return chain;
  },
}));

vi.mock('@server/security/tokenEncryption', () => ({ decryptToken: vi.fn((v: string) => `decrypted:${v}`) }));

import '../publish';

function request(blogIntegration: unknown) {
  const { req, res } = createMocks({ method: 'POST', body: { title: 'T', content: 'C' } });
  (req as any).user = { name: 'Author', blogIntegration };
  return { req, res };
}

describe('POST /api/blog/publish', () => {
  const originalFetch = global.fetch;
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = originalFetch;
  });

  it('rejects an internal/private or non-https baseUrl before reaching the blog', async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as never;
    for (const baseUrl of [
      'https://169.254.169.254',
      'https://localhost',
      'https://10.1.2.3',
      'http://blog.example.com',
    ]) {
      const { req, res } = request({ apiKey: 'enc', baseUrl });
      await mockRefs.handler!(req, res);
      expect(res._getStatusCode()).toBe(422);
      expect(res._getJSONData().message).toMatch(/not allowed/i);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a malformed baseUrl before reaching the blog', async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as never;
    const { req, res } = request({ apiKey: 'enc', baseUrl: 'not a url' });
    await mockRefs.handler!(req, res);
    expect(res._getStatusCode()).toBe(422);
    expect(res._getJSONData().message).toMatch(/not a valid URL/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reaches the blog for a valid public https baseUrl', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({ post: { postId: 'p1', title: 'T', status: 'published', createdAt: 0, updatedAt: 0 } }),
    }) as never;

    const { req, res } = request({ apiKey: 'enc', baseUrl: 'https://blog.example.com' });
    await mockRefs.handler!(req, res);

    expect(global.fetch).toHaveBeenCalledWith(
      'https://blog.example.com/api/posts',
      expect.objectContaining({ method: 'POST' })
    );
    expect(res._getJSONData().success).toBe(true);
  });
});
