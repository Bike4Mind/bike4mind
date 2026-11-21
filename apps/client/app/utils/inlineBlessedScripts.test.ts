import { describe, it, expect, vi, afterEach } from 'vitest';
import { inlineBlessedScripts } from './inlineBlessedScripts';

const CHART = '/static/lib/chart.js@4.x.js';
const REACT = '/static/lib/react@18.x.js';

const okResponse = (body: string) => ({ ok: true, status: 200, text: async () => body }) as Response;

const stubFetch = (impl: (url: string) => Promise<Response>) => {
  const fetchMock = vi.fn(impl);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('inlineBlessedScripts', () => {
  it('replaces a blessed script tag with an inline script and drops src', async () => {
    const fetchMock = stubFetch(async () => okResponse('window.Chart = function () {};'));
    const out = await inlineBlessedScripts(`<html><head><script src="${CHART}"></script></head></html>`);

    expect(fetchMock).toHaveBeenCalledWith(`${window.location.origin}${CHART}`);
    expect(out).toBe('<html><head><script>window.Chart = function () {};</script></head></html>');
    expect(out).not.toContain('src=');
  });

  it('keeps the other attributes of the tag', async () => {
    stubFetch(async () => okResponse('var a = 1;'));
    const out = await inlineBlessedScripts(
      `<script data-x="1" src='${CHART}' type="module" defer></script><script src="${REACT}" async></script>`
    );

    expect(out).toContain('<script data-x="1" type="module" defer>var a = 1;</script>');
    expect(out).toContain('<script async>var a = 1;</script>');
  });

  it('escapes </script and <!-- in library text', async () => {
    stubFetch(async () => okResponse('var s = "</script>" + "</SCRIPT >"; var c = "<!-- x";'));
    const out = await inlineBlessedScripts(`<script src="${CHART}"></script>`);

    expect(out).toBe('<script>var s = "<\\/script>" + "<\\/script >"; var c = "<\\!-- x";</script>');
    expect(out.match(/<\/script/gi)).toHaveLength(1);
  });

  it('inserts library text literally even when it contains replacement patterns', async () => {
    stubFetch(async () => okResponse('var a = "$&" + "$1" + "$$";'));
    const out = await inlineBlessedScripts(`<script src="${CHART}"></script>`);

    expect(out).toBe('<script>var a = "$&" + "$1" + "$$";</script>');
  });

  it('fetches each distinct path once', async () => {
    const fetchMock = stubFetch(async url => okResponse(`// ${url}`));
    const out = await inlineBlessedScripts(
      `<script src="${CHART}"></script><script src="${REACT}"></script><script src="${CHART}"></script>`
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(out.match(/chart\.js@4\.x\.js/g)).toHaveLength(2);
    expect(out).not.toContain('src=');
  });

  it('falls back to the absolute app-origin URL when the fetch rejects', async () => {
    stubFetch(async () => {
      throw new Error('offline');
    });
    const out = await inlineBlessedScripts(`<script defer src="${CHART}" async></script>`);

    expect(out).toBe(`<script defer src="${window.location.origin}${CHART}" async></script>`);
  });

  it('falls back to the absolute app-origin URL on a non-OK response', async () => {
    stubFetch(async () => ({ ok: false, status: 404, text: async () => 'Not found' }) as Response);
    const out = await inlineBlessedScripts(`<script src="${CHART}"></script>`);

    expect(out).toBe(`<script src="${window.location.origin}${CHART}"></script>`);
  });

  it('falls back when reading the body rejects', async () => {
    stubFetch(
      async () =>
        ({
          ok: true,
          status: 200,
          text: async () => {
            throw new Error('aborted');
          },
        }) as unknown as Response
    );
    const out = await inlineBlessedScripts(`<script src="${CHART}"></script>`);

    expect(out).toBe(`<script src="${window.location.origin}${CHART}"></script>`);
  });

  it('inlines the libraries it can fetch and falls back only for the rest', async () => {
    stubFetch(async url => (url.endsWith(CHART) ? okResponse('var chart;') : ({ ok: false } as Response)));
    const out = await inlineBlessedScripts(`<script src="${CHART}"></script><script src="${REACT}"></script>`);

    expect(out).toBe(`<script>var chart;</script><script src="${window.location.origin}${REACT}"></script>`);
  });

  it('leaves non-blessed and absolute srcs alone', async () => {
    const fetchMock = stubFetch(async () => okResponse('x'));
    const html = [
      '<script src="https://cdn.example.com/lib.js"></script>',
      '<script src="/static/lib/not-blessed.js"></script>',
      `<script src="${window.location.origin}${CHART}"></script>`,
      `<script data-src="${CHART}">inline()</script>`,
    ].join('');

    expect(await inlineBlessedScripts(html)).toBe(html);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns the input unchanged when there are no blessed scripts', async () => {
    const fetchMock = stubFetch(async () => okResponse('x'));
    const html = '<html><body><script>console.log(1)</script><p>hi</p></body></html>';

    expect(await inlineBlessedScripts(html)).toBe(html);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not touch inline script bodies that sit between blessed tags', async () => {
    stubFetch(async () => okResponse('var lib;'));
    const out = await inlineBlessedScripts(`<script src="${CHART}"></script><script>new Chart(ctx, {});</script>`);

    expect(out).toBe('<script>var lib;</script><script>new Chart(ctx, {});</script>');
  });
});
