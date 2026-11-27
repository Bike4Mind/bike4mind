import { describe, it, expect, vi, afterEach } from 'vitest';
import { inlineBlessedScripts } from './inlineBlessedScripts';

const CHART = '/static/lib/chart.js@4.x.js';
const REACT = '/static/lib/react@18.x.js';

const okResponse = (body: string) => ({ ok: true, status: 200, text: async () => body }) as Response;

const stubFetch = (impl: (url: string, init?: RequestInit) => Promise<Response>) => {
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

    expect(fetchMock).toHaveBeenCalledWith(`${window.location.origin}${CHART}`, expect.anything());
    expect(out).toBe('<html><head><script>window.Chart = function () {};</script></head></html>');
    expect(out).not.toContain('src=');
  });

  it('keeps the other attributes of the tag', async () => {
    stubFetch(async () => okResponse('var a = 1;'));
    const out = await inlineBlessedScripts(
      `<script data-x="1" src='${CHART}' type="module" data-y='a b'></script><script nonce="n" src="${REACT}"></script>`
    );

    expect(out).toContain(`<script data-x="1" type="module" data-y='a b'>var a = 1;</script>`);
    expect(out).toContain('<script nonce="n">var a = 1;</script>');
    expect(out).not.toContain('src=');
  });

  it('escapes </script and <!-- in library text', async () => {
    stubFetch(async () => okResponse('var s = "</script>" + "</SCRIPT >"; var c = "<!-- x";'));
    const out = await inlineBlessedScripts(`<script src="${CHART}"></script>`);

    expect(out).toBe('<script>var s = "<\\/script>" + "<\\/SCRIPT >"; var c = "<\\!-- x";</script>');
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

  it('leaves a commented-out blessed tag unchanged and does not fetch for it', async () => {
    const fetchMock = stubFetch(async () => okResponse('x'));
    const html = `<!-- <script src="${CHART}"></script> --><p>hi</p>`;

    expect(await inlineBlessedScripts(html)).toBe(html);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rewrites a live blessed tag next to a commented-out one', async () => {
    const fetchMock = stubFetch(async () => okResponse('var lib;'));
    const out = await inlineBlessedScripts(`<!-- <script src="${REACT}"></script> --><script src="${CHART}"></script>`);

    expect(out).toBe(`<!-- <script src="${REACT}"></script> --><script>var lib;</script>`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('leaves a blessed tag inside an inline script string unchanged', async () => {
    const fetchMock = stubFetch(async () => okResponse('x'));
    const html = `<script>document.write('<script src="${CHART}"><\\/script>');</script><p>hi</p>`;

    expect(await inlineBlessedScripts(html)).toBe(html);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not treat a src that sits inside another attribute value as the tag src', async () => {
    const fetchMock = stubFetch(async () => okResponse('x'));
    const html = `<script data-x=' src="${CHART}"'>inline()</script>`;

    expect(await inlineBlessedScripts(html)).toBe(html);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['onload', `onload="init()"`],
    ['async', 'async'],
    ['defer', 'defer'],
  ])('keeps the absolute src and the attributes for a tag with %s', async (_name, attr) => {
    const fetchMock = stubFetch(async () => okResponse('var lib;'));
    const out = await inlineBlessedScripts(`<script ${attr} src="${CHART}" data-x="1"></script>`);

    expect(out).toBe(`<script ${attr} src="${window.location.origin}${CHART}" data-x="1"></script>`);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('inlines a plain tag but keeps the absolute src for an async one in the same document', async () => {
    const fetchMock = stubFetch(async () => okResponse('var lib;'));
    const out = await inlineBlessedScripts(`<script src="${CHART}"></script><script async src="${REACT}"></script>`);

    expect(out).toBe(`<script>var lib;</script><script async src="${window.location.origin}${REACT}"></script>`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('separates a following attribute from the tag name when whitespace is missing', async () => {
    stubFetch(async () => okResponse('var lib;'));
    const deferred = await inlineBlessedScripts(`<script src="${CHART}"defer></script>`);
    const typed = await inlineBlessedScripts(`<script src="${CHART}"type="module"></script>`);

    expect(deferred).toBe(`<script src="${window.location.origin}${CHART}" defer></script>`);
    expect(typed).toBe('<script type="module">var lib;</script>');
  });

  it('falls back to the absolute src when the fetch outlives the timeout', async () => {
    const fetchMock = stubFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        })
    );
    const out = await inlineBlessedScripts(`<script src="${CHART}"></script>`, { timeoutMs: 20 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out).toBe(`<script src="${window.location.origin}${CHART}"></script>`);
  });

  it('defaults the fetch timeout to 8 seconds', async () => {
    vi.useFakeTimers();
    try {
      let aborted = false;
      stubFetch(
        (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              aborted = true;
              reject(new DOMException('aborted', 'AbortError'));
            });
          })
      );
      const pending = inlineBlessedScripts(`<script src="${CHART}"></script>`);

      await vi.advanceTimersByTimeAsync(7999);
      expect(aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(aborted).toBe(true);
      expect(await pending).toBe(`<script src="${window.location.origin}${CHART}"></script>`);
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves the case of </SCRIPT> when escaping library text', async () => {
    stubFetch(async () => okResponse('var a = "</SCRIPT>" + "</Script>";'));
    const out = await inlineBlessedScripts(`<script src="${CHART}"></script>`);

    expect(out).toBe('<script>var a = "<\\/SCRIPT>" + "<\\/Script>";</script>');
  });

  it('clears the timeout timer once the fetch settles', async () => {
    vi.useFakeTimers();
    try {
      stubFetch(async url => (url.endsWith(CHART) ? okResponse('var lib;') : ({ ok: false } as Response)));
      await inlineBlessedScripts(`<script src="${CHART}"></script><script src="${REACT}"></script>`);

      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the timeout timer when the fetch rejects', async () => {
    vi.useFakeTimers();
    try {
      stubFetch(async () => {
        throw new Error('offline');
      });
      await inlineBlessedScripts(`<script src="${CHART}"></script>`);

      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('inlines a tag whose unquoted attribute value holds an apostrophe, without leaking the library as page text', async () => {
    stubFetch(async () => okResponse('var lib;'));
    const out = await inlineBlessedScripts(`<script data-who=Bob's src="${CHART}"></script><p>It's live</p>`);

    expect(out).toBe(`<script data-who=Bob's>var lib;</script><p>It's live</p>`);
  });

  it('still rewrites a tag that carries a stray quote after the src value', async () => {
    stubFetch(async () => okResponse('var lib;'));
    const out = await inlineBlessedScripts(`<script src="${CHART}""></script><p>hi</p>`);

    expect(out).toBe('<script ">var lib;</script><p>hi</p>');
    expect(out).not.toContain('src=');
  });

  it('leaves a tag whose attribute name merely ends in src unchanged, since a leading quote belongs to the name', async () => {
    const fetchMock = stubFetch(async () => okResponse('x'));
    const html = `<script "src="${CHART}">BODY()</script>`;

    expect(await inlineBlessedScripts(html)).toBe(html);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('leaves a tag with more than one src unchanged', async () => {
    const fetchMock = stubFetch(async () => okResponse('x'));
    const html = [
      `<script src="${CHART}" src="${REACT}"></script>`,
      `<script src="https://cdn.example.com/lib.js" src="${CHART}"></script>`,
    ].join('');

    expect(await inlineBlessedScripts(html)).toBe(html);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([['<!-->'], ['<!--->']])('does not let the abrupt comment %s hide a live blessed tag', async comment => {
    stubFetch(async () => okResponse('var lib;'));
    const out = await inlineBlessedScripts(`${comment}<script src="${CHART}"></script>`);

    expect(out).toBe(`${comment}<script>var lib;</script>`);
  });

  it('treats --!> as the end of a comment', async () => {
    stubFetch(async () => okResponse('var lib;'));
    const out = await inlineBlessedScripts(
      `<!-- <script src="${REACT}"></script> --!><script src="${CHART}"></script>`
    );

    expect(out).toBe(`<!-- <script src="${REACT}"></script> --!><script>var lib;</script>`);
  });

  it('treats an unterminated comment as running to the end of the document', async () => {
    const fetchMock = stubFetch(async () => okResponse('x'));
    const html = `<p>hi</p><!-- <script src="${CHART}"></script>`;

    expect(await inlineBlessedScripts(html)).toBe(html);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns promptly on an unterminated open tag with many quoted attributes', async () => {
    const fetchMock = stubFetch(async () => okResponse('x'));
    const html = `<script ${Array.from({ length: 40 }, (_, i) => `a${i} = "v${i}"`).join(' ')}`;

    expect(await inlineBlessedScripts(html)).toBe(html);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
