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

// The SSRF gate resolves DNS; stub it so blog.example.com is public and *.nip.io is loopback.
vi.mock('dns', () => {
  const resolve4 = (host: string, cb: (e: Error | null, a?: string[]) => void) =>
    cb(null, /(^|\.)nip\.io$/.test(host) ? ['127.0.0.1'] : ['93.184.216.34']);
  const resolve6 = (_host: string, cb: (e: Error | null, a?: string[]) => void) => cb(null, []);
  return { default: { resolve4, resolve6 }, resolve4, resolve6 };
});

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

  it('blocks a public baseUrl that redirects to an internal host (no follow of the redirect)', async () => {
    // A public host passes the up-front guard, then 302s to cloud metadata. safeFetch re-checks
    // the Location and refuses to follow it, so the blog key never reaches the internal host.
    const fetchMock = vi.fn().mockResolvedValueOnce({
      status: 302,
      headers: { get: (k: string) => (k.toLowerCase() === 'location' ? 'https://169.254.169.254/' : null) },
    });
    global.fetch = fetchMock as never;

    const { req, res } = request({ apiKey: 'enc', baseUrl: 'https://blog.example.com' });
    await mockRefs.handler!(req, res);
    expect(res._getStatusCode()).toBe(422);
    expect(res._getJSONData().message).toMatch(/not allowed/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects a public baseUrl that resolves to a private IP (127.0.0.1.nip.io)', async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as never;
    const { req, res } = request({ apiKey: 'enc', baseUrl: 'https://127.0.0.1.nip.io' });
    await mockRefs.handler!(req, res);
    expect(res._getStatusCode()).toBe(422);
    expect(res._getJSONData().message).toMatch(/not allowed/i);
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

  it('does not relay the full upstream error body (bounds the SSRF read half)', async () => {
    // A non-ok upstream response must not have its whole body echoed back to the caller - that is
    // the read half of the rebind chain. Non-JSON bodies are capped; JSON keeps only message/error.
    const secret = 'INTERNAL-SECRET-'.repeat(60); // ~960 chars, non-JSON
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: () => Promise.resolve(secret),
    }) as never;

    const { req, res } = request({ apiKey: 'enc', baseUrl: 'https://blog.example.com' });
    await mockRefs.handler!(req, res);

    const message = res._getJSONData().message as string;
    expect(message).not.toContain(secret);
    expect(message.length).toBeLessThan(260);
  });
});
