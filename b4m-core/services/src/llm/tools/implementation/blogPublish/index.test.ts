import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IUserDocument } from '@bike4mind/common';

// The SSRF guard resolves DNS; default every host to a public IP. Individual tests override.
const dnsLookup = vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]);
vi.mock('node:dns/promises', () => ({ lookup: (...args: unknown[]) => dnsLookup(...args) }));

import { blogPublishTool } from './index';

const fetchMock = vi.fn();
const realFetch = globalThis.fetch;
vi.stubGlobal('fetch', fetchMock);
afterAll(() => {
  vi.stubGlobal('fetch', realFetch);
});

const okResponse = () =>
  ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({ post: { postId: 'abc123', title: 'T', status: 'published', createdAt: 0, updatedAt: 0 } }),
    text: async () => '',
  }) as unknown as Response;

function user(baseUrl: string): IUserDocument {
  return { name: 'Tester', blogIntegration: { apiKey: 'k', baseUrl } } as unknown as IUserDocument;
}

function publish(baseUrl: string) {
  return blogPublishTool
    .implementation({ user: user(baseUrl) } as never, undefined)
    .toolFn({ title: 'Hello', content: 'World' });
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(okResponse());
  dnsLookup.mockReset();
  dnsLookup.mockImplementation(async () => [{ address: '93.184.216.34', family: 4 }]);
});

describe('blog_publish SSRF guard', () => {
  it('rejects a private/loopback baseUrl before any outbound request', async () => {
    await expect(publish('http://localhost')).rejects.toThrow(/Refusing to fetch/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a public host that resolves to a private IP', async () => {
    dnsLookup.mockImplementation(async () => [{ address: '169.254.169.254', family: 4 }]);
    await expect(publish('https://blog.internal.example')).rejects.toThrow(/Refusing to fetch/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not follow a redirect to an internal address (redirect:error surfaces as a fetch error)', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('unexpected redirect'));
    await expect(publish('https://blog.example.com')).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledWith(
      'https://blog.example.com/api/posts',
      expect.objectContaining({ redirect: 'error' })
    );
  });

  it('publishes successfully to a normal https blog', async () => {
    const result = await publish('https://blog.example.com');
    expect(result).toContain('published');
    expect(result).toContain('abc123');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://blog.example.com/api/posts',
      expect.objectContaining({ method: 'POST', redirect: 'error' })
    );
  });
});
