import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// SSRF guard resolves DNS; default every host to a public IP. Individual tests override.
const dnsLookup = vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]);
vi.mock('node:dns/promises', () => ({ lookup: (...args: unknown[]) => dnsLookup(...args) }));

import { guardedFetch } from './guardedFetch';

const fetchMock = vi.fn();
const realFetch = globalThis.fetch;
vi.stubGlobal('fetch', fetchMock);
afterAll(() => {
  vi.stubGlobal('fetch', realFetch);
});

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, status: 200 } as Response);
  dnsLookup.mockReset();
  dnsLookup.mockImplementation(async () => [{ address: '93.184.216.34', family: 4 }]);
});

describe('guardedFetch', () => {
  it('rejects a literal loopback host without fetching', async () => {
    await expect(guardedFetch('http://localhost/api/posts', { method: 'POST' })).rejects.toThrow(/Refusing to fetch/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(dnsLookup).not.toHaveBeenCalled(); // literal check short-circuits before DNS
  });

  it('rejects a non-http(s) protocol without fetching', async () => {
    await expect(guardedFetch('file:///etc/passwd')).rejects.toThrow(/Refusing to fetch/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a malformed URL with a clean error, not a raw throw', async () => {
    await expect(guardedFetch('not a url')).rejects.toThrow(/Refusing to fetch.*invalid URL/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a host that resolves to a private address', async () => {
    dnsLookup.mockImplementation(async () => [{ address: '10.1.2.3', family: 4 }]);
    await expect(guardedFetch('https://internal.example.com/')).rejects.toThrow(/Refusing to fetch/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends redirect:error and passes method/headers/body through for https', async () => {
    await guardedFetch('https://example.com/api/posts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': 'secret' },
      body: '{"a":1}',
    });
    const [calledUrl, init] = fetchMock.mock.calls[0];
    expect(String(calledUrl)).toBe('https://example.com/api/posts');
    expect(init.redirect).toBe('error');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"a":1}');
    expect(init.headers['X-API-Key']).toBe('secret');
    expect(init.headers.Host).toBeUndefined(); // no IP pin for https (TLS/SNI preserved)
  });

  it('pins the vetted IP and sets the original Host header for http', async () => {
    await guardedFetch('http://example.com/api/posts', { method: 'POST', headers: { 'X-API-Key': 'secret' } });
    const [calledUrl, init] = fetchMock.mock.calls[0];
    expect(String(calledUrl)).toContain('93.184.216.34');
    expect(String(calledUrl)).not.toContain('example.com');
    expect(init.headers.Host).toBe('example.com');
    expect(init.headers['X-API-Key']).toBe('secret');
    expect(init.redirect).toBe('error');
  });
});
