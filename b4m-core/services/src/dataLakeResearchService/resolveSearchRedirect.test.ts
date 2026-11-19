import { describe, expect, it, vi } from 'vitest';
import { resolveSearchRedirect } from './resolveSearchRedirect';

const GOTO = 'https://www.google.com/goto?url=opaque-token';

const redirect = (status: number, location?: string) =>
  new Response(null, { status, headers: location === undefined ? {} : { location } });
const page = (body: string) => new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });

describe('resolveSearchRedirect', () => {
  it.each([
    'https://en.wikipedia.org/wiki/Qubit',
    'https://www.google.com/search?q=x',
    'https://google.com/maps',
    'https://notgoogle.com/goto?url=x',
    'https://www.google.com.evil.example/goto?url=x',
    'not a url',
  ])('leaves %s untouched without a request', async url => {
    const fetchImpl = vi.fn();
    expect(await resolveSearchRedirect(url, { fetchImpl })).toEqual({ url, resolved: 'not_redirect' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('decodes /url?q= without a request', async () => {
    const fetchImpl = vi.fn();
    const result = await resolveSearchRedirect(
      'https://www.google.com/url?q=https%3A%2F%2Farxiv.org%2Fabs%2F1234&sa=U',
      { fetchImpl }
    );
    expect(result).toEqual({ url: 'https://arxiv.org/abs/1234', resolved: 'decoded' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('follows a /goto 302 to a real site, once, with manual redirect', async () => {
    const fetchImpl = vi.fn(async () => redirect(302, 'https://en.wikipedia.org/wiki/Qubit'));
    expect(await resolveSearchRedirect(GOTO, { fetchImpl })).toEqual({
      url: 'https://en.wikipedia.org/wiki/Qubit',
      resolved: 'followed',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(GOTO, expect.objectContaining({ redirect: 'manual', credentials: 'omit' }));
  });

  it('falls back to a request for /url without a usable param', async () => {
    const fetchImpl = vi.fn(async () => redirect(302, 'https://example.org/a'));
    const result = await resolveSearchRedirect('https://www.google.com/url?q=javascript:alert(1)', { fetchImpl });
    expect(result.resolved).toBe('followed');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['another google redirect', 'https://www.google.com/url?q=https://example.org'],
    ['a relative location', '/somewhere'],
    ['a non-http location', 'ftp://example.org/file'],
    ['a missing location', undefined],
  ])('is unresolved when the 302 points at %s', async (_label, location) => {
    const fetchImpl = vi.fn(async () => redirect(302, location));
    expect(await resolveSearchRedirect(GOTO, { fetchImpl })).toEqual({ url: GOTO, resolved: 'unresolved' });
  });

  it('follows a 200 meta refresh to a non-Google site', async () => {
    const fetchImpl = vi.fn(async () =>
      page('<html><head><META http-equiv="refresh" content="0;url=https://arxiv.org/abs/1?a=1&amp;b=2"></head></html>')
    );
    expect(await resolveSearchRedirect(GOTO, { fetchImpl })).toEqual({
      url: 'https://arxiv.org/abs/1?a=1&b=2',
      resolved: 'followed',
    });
  });

  it('is unresolved for a 200 meta refresh back to Google', async () => {
    const fetchImpl = vi.fn(async () => page('<meta http-equiv="refresh" content="0;url=https://www.google.com/x">'));
    expect((await resolveSearchRedirect(GOTO, { fetchImpl })).resolved).toBe('unresolved');
  });

  it('is unresolved for a 200 without a meta refresh', async () => {
    const fetchImpl = vi.fn(async () => page('<html>hello</html>'));
    expect(await resolveSearchRedirect(GOTO, { fetchImpl })).toEqual({ url: GOTO, resolved: 'unresolved' });
  });

  it('ignores a meta refresh past the 64 KB read cap', async () => {
    const body = `${'x'.repeat(70 * 1024)}<meta http-equiv="refresh" content="0;url=https://arxiv.org/">`;
    const fetchImpl = vi.fn(async () => page(body));
    expect((await resolveSearchRedirect(GOTO, { fetchImpl })).resolved).toBe('unresolved');
  });

  it('never throws when fetch fails', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNRESET');
    });
    expect(await resolveSearchRedirect(GOTO, { fetchImpl })).toEqual({ url: GOTO, resolved: 'unresolved' });
  });

  it('is unresolved when the request outlives the timeout', async () => {
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        })
    );
    const result = await resolveSearchRedirect(GOTO, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 10,
    });
    expect(result).toEqual({ url: GOTO, resolved: 'unresolved' });
  });
});
