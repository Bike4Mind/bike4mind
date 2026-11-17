import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IUserDocument } from '@bike4mind/common';

// The SSRF guard resolves DNS; default every host to a public IP. Individual tests override.
const dnsLookup = vi.fn<(...args: unknown[]) => Promise<{ address: string; family: number }[]>>(async () => [
  { address: '93.184.216.34', family: 4 },
]);
vi.mock('node:dns/promises', () => ({ lookup: (...args: unknown[]) => dnsLookup(...args) }));

import { configureSecretsAtRest, encryptSecret, generateEncryptionKey } from '@bike4mind/utils/security';
import { blogEditTool } from './index';

const fetchMock = vi.fn();
const realFetch = globalThis.fetch;
vi.stubGlobal('fetch', fetchMock);
afterAll(() => {
  configureSecretsAtRest(undefined);
  vi.stubGlobal('fetch', realFetch);
});

const okResponse = () =>
  ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({ post: { status: 'published' } }),
    text: async () => '',
  }) as unknown as Response;

function user(baseUrl: string, apiKey = 'k'): IUserDocument {
  return { name: 'Tester', blogIntegration: { apiKey, baseUrl } } as unknown as IUserDocument;
}

function edit(baseUrl: string, apiKey?: string) {
  return blogEditTool
    .implementation({ user: user(baseUrl, apiKey) } as never, undefined)
    .toolFn({ postId: 'p1', title: 'New' });
}

const KEY = generateEncryptionKey();

beforeEach(() => {
  configureSecretsAtRest(KEY);
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(okResponse());
  dnsLookup.mockReset();
  dnsLookup.mockImplementation(async () => [{ address: '93.184.216.34', family: 4 }]);
});

describe('blog_edit SSRF guard', () => {
  it('rejects a private/loopback baseUrl before any outbound request', async () => {
    await expect(edit('http://127.0.0.1')).rejects.toThrow(/Refusing to fetch/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a public host that resolves to a private IP', async () => {
    dnsLookup.mockImplementation(async () => [{ address: '10.0.0.5', family: 4 }]);
    await expect(edit('https://blog.internal.example')).rejects.toThrow(/Refusing to fetch/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not follow a redirect to an internal address (redirect:error surfaces as a fetch error)', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('unexpected redirect'));
    await expect(edit('https://blog.example.com')).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledWith(
      'https://blog.example.com/api/posts/p1',
      expect.objectContaining({ redirect: 'error' })
    );
  });

  it('edits successfully against a normal https blog', async () => {
    const result = await edit('https://blog.example.com');
    expect(result).toContain('edited successfully');
    expect(result).toContain('p1');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://blog.example.com/api/posts/p1',
      expect.objectContaining({ method: 'PUT', redirect: 'error' })
    );
  });
});

describe('blog_edit stored API key', () => {
  const sentKey = () => fetchMock.mock.calls[0][1].headers['X-API-Key'];

  it('sends the decrypted key when the stored value is ciphertext', async () => {
    await edit('https://blog.example.com', encryptSecret('blog-key-plain', KEY));
    expect(fetchMock).toHaveBeenCalledWith(
      'https://blog.example.com/api/posts/p1',
      expect.objectContaining({ method: 'PUT' })
    );
    expect(sentKey()).toBe('blog-key-plain');
  });

  it('still sends a legacy plaintext key unchanged', async () => {
    await edit('https://blog.example.com', 'legacy-key');
    expect(sentKey()).toBe('legacy-key');
  });

  it.each([
    ['encrypted under another key', encryptSecret('blog-key-plain', generateEncryptionKey())],
    ['corrupt', encryptSecret('blog-key-plain', KEY).slice(0, -4)],
  ])('fails closed before any request when the stored key is %s', async (_label, stored) => {
    const err = await edit('https://blog.example.com', stored).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/could not be read/);
    expect((err as Error).message).not.toContain(stored);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
