import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// SSRF guard resolves DNS; default every host to a public IP. Individual tests override.
const dnsLookup = vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]);
vi.mock('node:dns/promises', () => ({ lookup: (...args: unknown[]) => dnsLookup(...args) }));

import { plainFetchScrape } from './plainFetch';

const encode = (s: string) => new TextEncoder().encode(s);

// Minimal ReadableStream-like body that yields the given chunks then completes.
function fakeStream(chunks: Uint8Array[]) {
  let i = 0;
  let canceled = false;
  return {
    getReader() {
      return {
        async read() {
          if (canceled || i >= chunks.length) return { done: true, value: undefined };
          return { done: false, value: chunks[i++] };
        },
        async cancel() {
          canceled = true;
        },
        releaseLock() {},
      };
    },
    async cancel() {
      canceled = true;
    },
  };
}

function makeRes(opts: {
  ok?: boolean;
  status?: number;
  contentType?: string;
  contentLength?: string;
  chunks?: Uint8Array[];
  text?: string;
}): Response {
  const { ok = true, status = 200, contentType = 'text/html', contentLength, chunks = [], text = '' } = opts;
  const headers = new Map<string, string>();
  headers.set('content-type', contentType);
  if (contentLength !== undefined) headers.set('content-length', contentLength);
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Not Found',
    headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
    body: fakeStream(chunks),
    text: async () => text,
  } as unknown as Response;
}

function htmlRes(html: string, opts: { ok?: boolean; status?: number; contentType?: string } = {}) {
  return makeRes({ ...opts, chunks: [encode(html)], text: html });
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

  it('returns the full (uncapped by this reader) markdown so callers can window/cap it', async () => {
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
    fetchMock.mockResolvedValueOnce(htmlRes('nope', { ok: false, status: 404 }));
    await expect(plainFetchScrape('https://example.com/missing')).rejects.toThrow(/Failed to fetch content/);
  });

  it('rejects when the declared content-length exceeds the cap', async () => {
    fetchMock.mockResolvedValueOnce(
      makeRes({ contentType: 'text/html', contentLength: String(6 * 1024 * 1024), chunks: [encode('<html/>')] })
    );
    await expect(plainFetchScrape('https://example.com/huge')).rejects.toThrow(/exceeds/);
  });

  it('aborts when the streamed body overruns the cap (no content-length header)', async () => {
    const oneMb = new Uint8Array(1024 * 1024);
    fetchMock.mockResolvedValueOnce(
      makeRes({ contentType: 'text/html', chunks: Array.from({ length: 6 }, () => oneMb) })
    );
    await expect(plainFetchScrape('https://example.com/stream')).rejects.toThrow(/exceeds/);
  });

  it('rejects a binary content-type without reading the body', async () => {
    fetchMock.mockResolvedValueOnce(makeRes({ contentType: 'application/octet-stream', chunks: [encode('BINARY')] }));
    await expect(plainFetchScrape('https://example.com/blob')).rejects.toThrow(/No content could be extracted/);
  });

  it('pins the vetted IP and sends the original Host header for http URLs', async () => {
    fetchMock.mockResolvedValueOnce(htmlRes('<html><body><p>ok</p></body></html>'));

    await plainFetchScrape('http://example.com/page');

    const [calledUrl, calledInit] = fetchMock.mock.calls[0];
    expect(String(calledUrl)).toContain('93.184.216.34');
    expect(String(calledUrl)).not.toContain('example.com');
    expect((calledInit as { headers: Record<string, string> }).headers.Host).toBe('example.com');
    expect((calledInit as { redirect: string }).redirect).toBe('error');
  });

  it('keeps the hostname (no IP pin) for https URLs so TLS/SNI is preserved', async () => {
    await plainFetchScrape('https://example.com/page');
    const [calledUrl, calledInit] = fetchMock.mock.calls[0];
    expect(String(calledUrl)).toBe('https://example.com/page');
    expect((calledInit as { headers: Record<string, string> }).headers.Host).toBeUndefined();
  });
});
