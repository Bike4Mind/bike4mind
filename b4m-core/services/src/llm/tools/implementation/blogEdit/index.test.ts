import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IUserDocument } from '@bike4mind/common';

// The SSRF guard resolves DNS; default every host to a public IP. Individual tests override.
const dnsLookup = vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]);
vi.mock('node:dns/promises', () => ({ lookup: (...args: unknown[]) => dnsLookup(...args) }));

import { blogEditTool } from './index';

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
    json: async () => ({ post: { status: 'published' } }),
    text: async () => '',
  }) as unknown as Response;

function user(baseUrl: string): IUserDocument {
  return { name: 'Tester', blogIntegration: { apiKey: 'k', baseUrl } } as unknown as IUserDocument;
}

function edit(baseUrl: string) {
  return blogEditTool
    .implementation({ user: user(baseUrl) } as never, undefined)
    .toolFn({ postId: 'p1', title: 'New' });
}

beforeEach(() => {
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
