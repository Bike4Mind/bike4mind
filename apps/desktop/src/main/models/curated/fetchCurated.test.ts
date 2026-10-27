import { describe, expect, it, vi } from 'vitest';
import { curatedSibling, fetchCurated, resolveCuratedUrl } from './fetchCurated';

const LIST = 'https://catalog.example.com/model-hub/curated-v2/latest.json';

function fakeFetch(routes: Record<string, () => Response>) {
  return vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
    const route = routes[String(url)];
    return route ? route() : new Response('missing', { status: 404 });
  });
}

const redirect = (location: string) => () => new Response(null, { status: 302, headers: { location } });

describe('resolveCuratedUrl', () => {
  it('takes https, and loopback http only when the build allows it', () => {
    expect(resolveCuratedUrl(LIST, false)).toBe(LIST);
    expect(resolveCuratedUrl('http://127.0.0.1:4321/latest.json', true)).toBe('http://127.0.0.1:4321/latest.json');
    expect(resolveCuratedUrl('http://127.0.0.1:4321/latest.json', false)).toBeNull();
    expect(resolveCuratedUrl('http://catalog.example.com/latest.json', true)).toBeNull();
  });

  it('refuses empty, non-json, query, fragment and credential URLs', () => {
    for (const raw of [
      '',
      undefined,
      'ftp://catalog.example.com/latest.json',
      'https://catalog.example.com/latest',
      `${LIST}?v=1`,
      `${LIST}#x`,
      'https://user:pass@catalog.example.com/latest.json',
    ])
      expect(resolveCuratedUrl(raw, true)).toBeNull();
  });

  it('resolves the immutable pair relative to the list URL', () => {
    expect(curatedSibling(LIST, '17.json')).toBe('https://catalog.example.com/model-hub/curated-v2/17.json');
  });
});

describe('fetchCurated', () => {
  it('sends only the fixed headers to the exact URL, with redirects handled by hand', async () => {
    const fetch = fakeFetch({ [LIST]: () => new Response('{}') });
    expect(await fetchCurated(LIST, 100, { fetch, allowLoopbackHttp: false })).toEqual({
      ok: true,
      bytes: new TextEncoder().encode('{}'),
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(LIST);
    expect(init?.headers).toEqual({ accept: 'application/json', 'user-agent': 'Bike4Mind-Desktop' });
    expect(init?.redirect).toBe('manual');
  });

  it('follows three https redirects and refuses a fourth', async () => {
    const hop = (n: number) => `https://cdn${n}.example.com/latest.json`;
    const routes = {
      [LIST]: redirect(hop(1)),
      [hop(1)]: redirect(hop(2)),
      [hop(2)]: redirect(hop(3)),
      [hop(3)]: () => new Response('ok'),
    };
    expect(await fetchCurated(LIST, 100, { fetch: fakeFetch(routes), allowLoopbackHttp: false })).toMatchObject({
      ok: true,
    });
    const four = { ...routes, [hop(3)]: redirect(hop(4)), [hop(4)]: () => new Response('ok') };
    expect(await fetchCurated(LIST, 100, { fetch: fakeFetch(four), allowLoopbackHttp: false })).toMatchObject({
      ok: false,
      failure: 'redirect',
    });
  });

  it('refuses a redirect to http, and allows loopback http only from loopback in a dev build', async () => {
    const toHttp = { [LIST]: redirect('http://catalog.example.com/latest.json') };
    expect(await fetchCurated(LIST, 100, { fetch: fakeFetch(toHttp), allowLoopbackHttp: true })).toMatchObject({
      ok: false,
      failure: 'redirect',
    });
    const local = 'http://127.0.0.1:4321/a.json';
    const loop = { [local]: redirect('/b.json'), 'http://127.0.0.1:4321/b.json': () => new Response('ok') };
    expect(await fetchCurated(local, 100, { fetch: fakeFetch(loop), allowLoopbackHttp: true })).toMatchObject({
      ok: true,
    });
    expect(await fetchCurated(local, 100, { fetch: fakeFetch(loop), allowLoopbackHttp: false })).toMatchObject({
      ok: false,
      failure: 'redirect',
    });
  });

  it.each([403, 404, 500])('reports HTTP %i as a failed check', async status => {
    const fetch = fakeFetch({ [LIST]: () => new Response('<html>', { status }) });
    expect(await fetchCurated(LIST, 100, { fetch, allowLoopbackHttp: false })).toMatchObject({
      ok: false,
      failure: 'http',
    });
  });

  it('caps the body, by declared length and by bytes read', async () => {
    const declared = fakeFetch({ [LIST]: () => new Response('x', { headers: { 'content-length': '101' } }) });
    expect(await fetchCurated(LIST, 100, { fetch: declared, allowLoopbackHttp: false })).toMatchObject({
      ok: false,
      failure: 'oversize',
    });
    const streamed = fakeFetch({ [LIST]: () => new Response('x'.repeat(101)) });
    expect(await fetchCurated(LIST, 100, { fetch: streamed, allowLoopbackHttp: false })).toMatchObject({
      ok: false,
      failure: 'oversize',
    });
  });

  it('times out a request that never answers, and reports a network error', async () => {
    const hanging = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) =>
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
        )
    );
    expect(await fetchCurated(LIST, 100, { fetch: hanging, timeoutMs: 20, allowLoopbackHttp: false })).toMatchObject({
      ok: false,
      failure: 'timeout',
    });
    const down = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    expect(await fetchCurated(LIST, 100, { fetch: down, allowLoopbackHttp: false })).toMatchObject({
      ok: false,
      failure: 'network',
    });
  });
});
