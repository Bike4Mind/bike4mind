import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// SSRF guard resolves DNS; default every host to a public IP. Individual tests override.
const dnsLookup = vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]);
vi.mock('node:dns/promises', () => ({ lookup: (...args: unknown[]) => dnsLookup(...args) }));

import { plainFetchScrape } from './plainFetch';

function htmlRes(html: string, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Not Found',
    text: async () => html,
  } as unknown as Response;
}

const fetchMock = vi.fn();
const realFetch = globalThis.fetch;
vi.stubGlobal('fetch', fetchMock);
afterAll(() => {
  vi.stubGlobal('fetch', realFetch);
});

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(htmlRes('<html><head><title>Doc</title></head><body><p>hi</p></body></html>'));
  dnsLookup.mockReset();
  dnsLookup.mockImplementation(async () => [{ address: '93.184.216.34', family: 4 }]);
});

describe('plainFetchScrape', () => {
  it('converts fetched HTML to markdown and extracts the title', async () => {
    fetchMock.mockResolvedValueOnce(
      htmlRes('<html><head><title>My Title</title></head><body><h1>Hello</h1><p>World</p></body></html>')
    );

    const res = await plainFetchScrape('https://example.com/page');

    expect(res.title).toBe('My Title');
    expect(res.markdown).toContain('Hello');
    expect(res.markdown).toContain('World');
    expect(fetchMock).toHaveBeenCalledWith('https://example.com/page', expect.objectContaining({ redirect: 'error' }));
  });

  it('returns the full (uncapped) markdown so callers can window/cap it', async () => {
    const big = 'a'.repeat(120_000);
    fetchMock.mockResolvedValueOnce(htmlRes(`<html><body><p>${big}</p></body></html>`));

    const res = await plainFetchScrape('https://example.com/big');

    expect(res.markdown.length).toBeGreaterThan(100_000);
  });

  it('rejects a literal loopback host without fetching (SSRF guard)', async () => {
    await expect(plainFetchScrape('http://localhost/admin')).rejects.toThrow(/Refusing to fetch/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(dnsLookup).not.toHaveBeenCalled(); // literal check short-circuits before DNS
  });

  it('rejects a host that resolves to a private address (SSRF guard)', async () => {
    dnsLookup.mockImplementation(async () => [{ address: '10.1.2.3', family: 4 }]);
    await expect(plainFetchScrape('https://internal.example.com/')).rejects.toThrow(/Refusing to fetch/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns a clear message for a PDF URL without fetching', async () => {
    const res = await plainFetchScrape('https://example.com/report.pdf');
    expect(res.markdown).toContain('PDF');
    expect(res.markdown.toLowerCase()).toContain('cannot');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws on a non-OK response', async () => {
    fetchMock.mockResolvedValueOnce(htmlRes('nope', false, 404));
    await expect(plainFetchScrape('https://example.com/missing')).rejects.toThrow(/Failed to fetch content/);
  });
});
