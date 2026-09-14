import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * The blog API key lives in user.blogIntegration and must never reach the browser, so the
 * presign request - the one step that carries the key - runs server-side here. These
 * assert the key is decrypted and forwarded, and that a misconfigured or invalid request
 * is rejected before any call to the blog.
 */

const mockRefs = vi.hoisted(() => ({
  handler: null as null | ((req: any, res: any) => unknown),
}));

vi.mock('@client/server/middlewares/baseApi', () => ({
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

const decryptToken = vi.hoisted(() => vi.fn((v: string) => `decrypted:${v}`));
vi.mock('@server/security/tokenEncryption', () => ({ decryptToken }));

// The SSRF gate resolves DNS; stub it so blog.example.com is public and *.nip.io is loopback.
vi.mock('dns', () => {
  const resolve4 = (host: string, cb: (e: Error | null, a?: string[]) => void) =>
    cb(null, /(^|\.)nip\.io$/.test(host) ? ['127.0.0.1'] : ['93.184.216.34']);
  const resolve6 = (_host: string, cb: (e: Error | null, a?: string[]) => void) => cb(null, []);
  return { default: { resolve4, resolve6 }, resolve4, resolve6 };
});

import '../presign-image-upload';

function request(body: unknown, blogIntegration: unknown) {
  const { req, res } = createMocks({ method: 'POST', body });
  (req as any).user = { id: 'u1', blogIntegration };
  (req as any).logger = { error: vi.fn(), info: vi.fn() };
  return { req, res };
}

const validBody = { fileName: 'a.jpg', fileSize: 10, mimeType: 'image/jpeg', postId: 'p1' };
const configured = { apiKey: 'enc-key', baseUrl: 'https://blog.example.com/' };

describe('POST /api/blog/presign-image-upload', () => {
  const originalFetch = global.fetch;
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = originalFetch;
  });

  it('rejects when blog integration is not configured', async () => {
    const { req, res } = request(validBody, null);
    await expect(mockRefs.handler!(req, res)).rejects.toThrow(/not configured/i);
  });

  it('rejects an unsupported mime type before reaching the blog', async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as never;
    const { req, res } = request({ ...validBody, mimeType: 'application/pdf' }, configured);
    await expect(mockRefs.handler!(req, res)).rejects.toThrow(/invalid file type/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a baseUrl pointed at an internal/private host or non-https before reaching the blog', async () => {
    // The presign runs server-side with the user's blog key, so an internal/metadata baseUrl
    // would turn it into an SSRF vector.
    const fetchMock = vi.fn();
    global.fetch = fetchMock as never;
    for (const baseUrl of [
      'https://169.254.169.254/', // cloud metadata
      'https://localhost/',
      'https://10.0.0.5/',
      'http://blog.example.com/', // non-https
    ]) {
      const { req, res } = request(validBody, { apiKey: 'enc-key', baseUrl });
      await expect(mockRefs.handler!(req, res)).rejects.toThrow(/not allowed/i);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a public baseUrl that resolves to a private IP (127.0.0.1.nip.io)', async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as never;
    const { req, res } = request(validBody, { apiKey: 'enc-key', baseUrl: 'https://127.0.0.1.nip.io' });
    await expect(mockRefs.handler!(req, res)).rejects.toThrow(/not allowed/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a malformed baseUrl before reaching the blog', async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as never;
    const { req, res } = request(validBody, { apiKey: 'enc-key', baseUrl: 'not a url' });
    await expect(mockRefs.handler!(req, res)).rejects.toThrow(/not a valid URL/i);
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

    const { req, res } = request(validBody, configured);
    await expect(mockRefs.handler!(req, res)).rejects.toThrow(/not allowed/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('forwards the decrypted key to the blog and returns the presigned URLs', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ uploadUrl: 'https://s3/u', imageUrl: 'https://blog/i.jpg', key: 'k' }),
    });
    global.fetch = fetchMock as never;

    const { req, res } = request(validBody, configured);
    await mockRefs.handler!(req, res);

    // Trailing slash stripped; key decrypted (never the raw stored value) in the header.
    // redirect:'manual' is added by safeFetch so a redirect to an internal host is re-checked.
    expect(fetchMock).toHaveBeenCalledWith('https://blog.example.com/api/posts/images/presigned-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': 'decrypted:enc-key' },
      body: JSON.stringify({ fileName: 'a.jpg', fileSize: 10, mimeType: 'image/jpeg', postId: 'p1' }),
      signal: expect.any(AbortSignal),
      redirect: 'manual',
    });
    expect(res._getJSONData()).toEqual({ uploadUrl: 'https://s3/u', imageUrl: 'https://blog/i.jpg', key: 'k' });
  });

  it('forwards the normalized mime type, not the raw client string', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ uploadUrl: 'https://s3/u', imageUrl: 'https://blog/i.jpg' }),
    });
    global.fetch = fetchMock as never;

    const { req, res } = request({ ...validBody, mimeType: '  IMAGE/JPEG  ' }, configured);
    await mockRefs.handler!(req, res);

    const sent = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(sent.mimeType).toBe('image/jpeg');
  });

  it('maps the blog alternative field names (presignedUrl / publicUrl)', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ presignedUrl: 'https://s3/u', publicUrl: 'https://blog/i.jpg' }),
    }) as never;

    const { req, res } = request(validBody, configured);
    await mockRefs.handler!(req, res);

    const body = res._getJSONData();
    expect(body.uploadUrl).toBe('https://s3/u');
    expect(body.imageUrl).toBe('https://blog/i.jpg');
  });

  it('surfaces a timeout when the blog request aborts', async () => {
    // A hung blog host must not pin the handler to the platform timeout (matches publish.ts).
    global.fetch = vi.fn().mockRejectedValueOnce(Object.assign(new Error('aborted'), { name: 'AbortError' })) as never;
    const { req, res } = request(validBody, configured);
    await expect(mockRefs.handler!(req, res)).rejects.toThrow(/timed out/i);
  });

  it('surfaces a blog error response', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: () => Promise.resolve(JSON.stringify({ message: 'Unauthorized' })),
    }) as never;

    const { req, res } = request(validBody, configured);
    await expect(mockRefs.handler!(req, res)).rejects.toThrow(/unauthorized/i);
  });
});
