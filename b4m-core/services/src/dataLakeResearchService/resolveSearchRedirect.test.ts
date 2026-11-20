import { describe, expect, it, vi } from 'vitest';
import { isRetryableUnresolved, resolveSearchRedirect, type UnresolvedDetail } from './resolveSearchRedirect';

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
      via: 'location',
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
    expect(await resolveSearchRedirect(GOTO, { fetchImpl })).toMatchObject({ url: GOTO, resolved: 'unresolved' });
  });

  it('follows a 200 meta refresh to a non-Google site', async () => {
    const fetchImpl = vi.fn(async () =>
      page('<html><head><META http-equiv="refresh" content="0;url=https://arxiv.org/abs/1?a=1&amp;b=2"></head></html>')
    );
    expect(await resolveSearchRedirect(GOTO, { fetchImpl })).toEqual({
      url: 'https://arxiv.org/abs/1?a=1&b=2',
      resolved: 'followed',
      via: 'meta_refresh',
    });
  });

  describe('200 page mechanisms', () => {
    const pageWith = (body: string, headers: Record<string, string> = {}) =>
      new Response(body, { status: 200, headers: { 'content-type': 'text/html', ...headers } });
    const run = (response: Response) => resolveSearchRedirect(GOTO, { fetchImpl: vi.fn(async () => response) });

    it('follows a Refresh header', async () => {
      const result = await run(pageWith('<html></html>', { refresh: '0; URL="https://example.com/r?a=1"' }));
      expect(result).toEqual({ url: 'https://example.com/r?a=1', resolved: 'followed', via: 'refresh_header' });
    });

    it('reports via meta_refresh for a meta refresh', async () => {
      const result = await run(pageWith('<meta http-equiv="refresh" content="0;url=https://example.com/m">'));
      expect(result).toMatchObject({ url: 'https://example.com/m', via: 'meta_refresh' });
    });

    it('follows location.replace with escaped literal', async () => {
      const result = await run(
        pageWith(String.raw`<script>location.replace("https:\/\/example.com\/a?b\x3dc\u0026d\u003de");</script>`)
      );
      expect(result).toEqual({ url: 'https://example.com/a?b=c&d=e', resolved: 'followed', via: 'script' });
    });

    it('follows window.location.href assignment', async () => {
      const result = await run(pageWith("<script>window.location.href='https://example.com/h';</script>"));
      expect(result).toEqual({ url: 'https://example.com/h', resolved: 'followed', via: 'script' });
    });

    it('skips a non-validating script literal and uses a later valid one', async () => {
      const result = await run(
        pageWith(
          '<script>top.location = "https://www.google.com/x"; self.location.assign("https://example.com/ok")</script>'
        )
      );
      expect(result).toMatchObject({ url: 'https://example.com/ok', via: 'script' });
    });

    it('follows a lone anchor, decoding entities', async () => {
      const result = await run(
        pageWith('<a href="https://www.google.com/x">back</a><a href="https://example.com/p?a=1&amp;b=2&#39;">go</a>')
      );
      expect(result).toEqual({ url: 'https://example.com/p?a=1&b=2%27', resolved: 'followed', via: 'anchor' });
    });

    it('dedupes repeated anchors to the same url', async () => {
      const result = await run(pageWith('<a href="https://example.com/a">1</a><a href="https://example.com/a">2</a>'));
      expect(result).toMatchObject({ url: 'https://example.com/a', via: 'anchor' });
    });

    it('prefers the Refresh header over a body script', async () => {
      const result = await run(
        pageWith('<script>location.replace("https://example.com/script")</script>', {
          refresh: '0;url=https://example.com/header',
        })
      );
      expect(result).toMatchObject({ url: 'https://example.com/header', via: 'refresh_header' });
    });

    it.each([
      ['a google url', '<script>location.replace("https://www.google.com/x")</script>'],
      ['javascript:', '<script>location.href = "javascript:void(0)"</script>'],
      ['a relative url', '<script>window.location = "/relative"</script>'],
    ])('does not follow a script pointing at %s', async (_label, body) => {
      const result = await run(pageWith(body));
      expect(result.resolved).toBe('unresolved');
      expect(result.detail).toMatchObject({ scriptRedirect: true, externalLinks: 0 });
    });

    it('does not follow a lone anchor on a captcha page', async () => {
      const result = await run(pageWith('<p>unusual traffic</p><a href="https://example.com/a">a</a>'));
      expect(result.resolved).toBe('unresolved');
      expect(result.detail).toMatchObject({ bodyHint: 'captcha' });
    });

    it('does not follow a script redirect on a consent page', async () => {
      const result = await run(
        pageWith('<p>Before you continue</p><script>location.replace("https://example.com/s")</script>')
      );
      expect(result.resolved).toBe('unresolved');
      expect(result.detail).toMatchObject({ bodyHint: 'consent', scriptRedirect: true });
    });

    it('still follows a meta refresh on a captcha page', async () => {
      const result = await run(
        pageWith('unusual traffic<meta http-equiv="refresh" content="0;url=https://example.com/m">')
      );
      expect(result).toMatchObject({ url: 'https://example.com/m', via: 'meta_refresh' });
    });

    it('ignores a lone youtube.com anchor', async () => {
      const result = await run(pageWith('<a href="https://www.youtube.com/watch?v=1">v</a>'));
      expect(result.resolved).toBe('unresolved');
      expect(result.detail).toMatchObject({ bodyHint: 'other', externalLinks: 0 });
    });

    it('follows the real link when a youtube.com link sits beside it', async () => {
      const result = await run(
        pageWith('<a href="https://www.youtube.com/watch?v=1">v</a><a href="https://example.com/real">r</a>')
      );
      expect(result).toEqual({ url: 'https://example.com/real', resolved: 'followed', via: 'anchor' });
    });

    it.each([
      'https://www.google.co.uk/x',
      'https://google.de/x',
      'https://news.google.com.au/x',
      'https://fonts.gstatic.com/x',
    ])('does not follow a script redirect to %s', async target => {
      const result = await run(pageWith(`<script>location.replace("${target}")</script>`));
      expect(result.resolved).toBe('unresolved');
    });

    it.each(['https://notyoutube.com/a', 'https://google.example.com/a'])(
      'still follows an anchor to %s',
      async target => {
        const result = await run(pageWith(`<a href="${target}">a</a>`));
        expect(result).toMatchObject({ url: target, via: 'anchor' });
      }
    );

    it('is unresolved for two distinct external anchors', async () => {
      const result = await run(pageWith('<a href="https://example.com/a">a</a><a href="https://example.org/b">b</a>'));
      expect(result.resolved).toBe('unresolved');
      expect(result.detail).toMatchObject({ externalLinks: 2, scriptRedirect: false, hasRefreshHeader: false });
    });

    it('counts no external links when anchors only point at google hosts', async () => {
      const result = await run(
        pageWith('<a href="https://www.google.com/a">a</a><a href="https://accounts.google.com/b">b</a>')
      );
      expect(result.detail).toMatchObject({ externalLinks: 0 });
    });

    it('flags a refresh header that does not validate', async () => {
      const result = await run(pageWith('x', { refresh: '0;url=https://www.google.com/x' }));
      expect(result.detail).toMatchObject({ hasRefreshHeader: true, bodyLength: 1 });
    });

    it('stays fast on a pathological body', async () => {
      const started = Date.now();
      await run(pageWith(`<a ${'href='.repeat(8000)}`));
      await run(pageWith(`location.href="${'\\'.repeat(30000)}`));
      expect(Date.now() - started).toBeLessThan(1000);
    });
  });

  it('is unresolved for a 200 meta refresh back to Google', async () => {
    const fetchImpl = vi.fn(async () => page('<meta http-equiv="refresh" content="0;url=https://www.google.com/x">'));
    expect((await resolveSearchRedirect(GOTO, { fetchImpl })).resolved).toBe('unresolved');
  });

  it('is unresolved for a 200 without a meta refresh', async () => {
    const fetchImpl = vi.fn(async () => page('<html>hello</html>'));
    expect(await resolveSearchRedirect(GOTO, { fetchImpl })).toMatchObject({ url: GOTO, resolved: 'unresolved' });
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
    expect(await resolveSearchRedirect(GOTO, { fetchImpl })).toMatchObject({ url: GOTO, resolved: 'unresolved' });
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
    expect(result).toMatchObject({ url: GOTO, resolved: 'unresolved' });
  });

  describe('unresolved detail', () => {
    const run = (fetchImpl: unknown, timeoutMs?: number) =>
      resolveSearchRedirect(GOTO, { fetchImpl: fetchImpl as typeof fetch, timeoutMs });
    const noToken = (result: { detail?: unknown }) =>
      expect(JSON.stringify(result.detail)).not.toContain('opaque-token');

    it('reports a 429 captcha page as a status failure with a body hint', async () => {
      const result = await run(
        vi.fn(async () => new Response('Our systems have detected unusual traffic', { status: 429 }))
      );
      expect(result.detail).toEqual(expect.objectContaining({ reason: 'status', status: 429, bodyHint: 'captcha' }));
      noToken(result);
    });

    it('keeps URLs and page text out of the 200 structure markers', async () => {
      const result = await run(
        vi.fn(async () =>
          page(
            '<a href="https://a.example/opaque-token">x</a><a href="https://b.example/y">y</a>location.href="/opaque-token"'
          )
        )
      );
      expect(result.detail).toMatchObject({ externalLinks: 2, scriptRedirect: true });
      noToken(result);
      expect(JSON.stringify(result.detail)).not.toContain('example');
    });

    it('reports a 302 back to Google with the location host only', async () => {
      const result = await run(vi.fn(async () => redirect(302, 'https://consent.google.com/m?continue=opaque-token')));
      expect(result.detail).toEqual({ reason: 'google_location', status: 302, locationHost: 'consent.google.com' });
      noToken(result);
    });

    it('reports a 302 without a Location', async () => {
      const result = await run(vi.fn(async () => redirect(302)));
      expect(result.detail).toEqual({ reason: 'no_location', status: 302 });
    });

    it('reports a 302 to a non-http location', async () => {
      const result = await run(vi.fn(async () => redirect(302, '/somewhere')));
      expect(result.detail).toEqual({ reason: 'bad_location', status: 302 });
    });

    it('reports a 200 consent page without a meta refresh', async () => {
      const result = await run(vi.fn(async () => page('<html>Before you continue to Google</html>')));
      expect(result.detail).toEqual({
        reason: 'no_meta_refresh',
        status: 200,
        contentType: 'text/html',
        bodyHint: 'consent',
        bodyLength: 'Before you continue to Google'.length + '<html></html>'.length,
        hasRefreshHeader: false,
        scriptRedirect: false,
        externalLinks: 0,
      });
    });

    it('reports a redirect notice page', async () => {
      const result = await run(vi.fn(async () => page('<title>Redirect Notice</title>')));
      expect(result.detail?.bodyHint).toBe('redirect_notice');
    });

    it('extracts a decoded, collapsed, capped title and flags a verifying page', async () => {
      const long = 'x'.repeat(200);
      const titled = await run(vi.fn(async () => page('<title>\n Verifying  &amp; wait \n</title>')));
      expect(titled.detail).toMatchObject({ bodyTitle: 'Verifying & wait', bodyHint: 'verifying' });
      const capped = await run(vi.fn(async () => page(`<title>${long}</title>`)));
      expect(capped.detail?.bodyTitle).toHaveLength(80);
    });

    it('omits bodyTitle when the page has no title', async () => {
      const result = await run(vi.fn(async () => page('<html>nothing</html>')));
      expect(result.detail).not.toHaveProperty('bodyTitle');
      expect(result.detail?.bodyHint).toBe('other');
    });

    it.each([
      ['English', '<title>Verifying your request</title>'],
      ['German', '<title>Verifizierung Ihrer Anfrage</title>'],
    ])('hints verifying for a %s title', async (_label, html) => {
      const result = await run(vi.fn(async () => page(html)));
      expect(result.detail?.bodyHint).toBe('verifying');
    });

    it('lets captcha and consent take precedence over verifying', async () => {
      const captcha = await run(vi.fn(async () => page('<title>Verifying</title> unusual traffic')));
      expect(captcha.detail?.bodyHint).toBe('captcha');
      const consent = await run(vi.fn(async () => page('<title>Verifying</title> before you continue')));
      expect(consent.detail?.bodyHint).toBe('consent');
    });

    it('reports a 5xx without reading a body', async () => {
      const result = await run(vi.fn(async () => new Response('oops', { status: 503 })));
      expect(result.detail).toMatchObject({ reason: 'status', status: 503 });
      expect(result.detail?.bodyHint).toBeUndefined();
    });

    it('reports a timeout', async () => {
      const fetchImpl = (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
      expect((await run(fetchImpl, 10)).detail).toEqual({ reason: 'timeout' });
    });

    it('keeps the status when the body read times out', async () => {
      const fetchImpl = (_url: string, init?: RequestInit) => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            init?.signal?.addEventListener('abort', () => controller.error(new Error('aborted')));
          },
        });
        return Promise.resolve(new Response(body, { status: 429 }));
      };
      const result = await run(fetchImpl, 20);
      expect(result.resolved).toBe('unresolved');
      expect(result.detail).toEqual({ reason: 'timeout', status: 429 });
    });

    it('reports other thrown errors as network errors', async () => {
      const result = await run(
        vi.fn(async () => {
          throw new Error(`ECONNRESET ${GOTO}`);
        })
      );
      expect(result.detail).toEqual({ reason: 'network_error' });
      noToken(result);
    });
  });
});

describe('isRetryableUnresolved', () => {
  const waiting: UnresolvedDetail = { reason: 'no_meta_refresh', status: 200, bodyHint: 'verifying' };
  it.each<[string, UnresolvedDetail | undefined, boolean]>([
    ['a 200 waiting page', waiting, true],
    ['a 200 other page', { ...waiting, bodyHint: 'other' }, true],
    ['a timeout', { reason: 'timeout' }, true],
    ['captcha', { ...waiting, bodyHint: 'captcha' }, false],
    ['consent', { ...waiting, bodyHint: 'consent' }, false],
    ['a 4xx', { reason: 'status', status: 429 }, false],
    ['a 5xx', { reason: 'status', status: 503 }, false],
    ['a google location', { reason: 'google_location', status: 302 }, false],
    ['a bad location', { reason: 'bad_location', status: 302 }, false],
    ['a network error', { reason: 'network_error' }, false],
    ['no detail', undefined, false],
  ])('is %s -> %s', (_label, detail, expected) => {
    expect(isRetryableUnresolved(detail)).toBe(expected);
  });
});

describe('resolveSearchRedirect cookies', () => {
  const waitingPage = (cookies: string[]) => {
    const headers = new Headers({ 'content-type': 'text/html' });
    for (const cookie of cookies) headers.append('set-cookie', cookie);
    return new Response('<title>Google</title>', { status: 200, headers });
  };

  it('returns name=value pairs from multiple Set-Cookie headers without attributes', async () => {
    const result = await resolveSearchRedirect(GOTO, {
      fetchImpl: vi.fn(async () =>
        waitingPage(['NID=abc; Path=/; HttpOnly', '__Secure-STRP=def; Secure; SameSite=Lax'])
      ),
    });
    expect(result.retryCookies).toEqual(['NID=abc', '__Secure-STRP=def']);
    expect(JSON.stringify(result.detail)).not.toMatch(/NID|abc|def/);
  });

  it('caps the pair count and the total size', async () => {
    const many = Array.from({ length: 30 }, (_v, i) => `c${i}=v`);
    const counted = await resolveSearchRedirect(GOTO, { fetchImpl: vi.fn(async () => waitingPage(many)) });
    expect(counted.retryCookies).toHaveLength(10);
    const big = Array.from({ length: 5 }, (_v, i) => `c${i}=${'x'.repeat(1500)}`);
    const sized = await resolveSearchRedirect(GOTO, { fetchImpl: vi.fn(async () => waitingPage(big)) });
    expect(sized.retryCookies).toHaveLength(2);
  });

  it('has no retryCookies when none were set', async () => {
    const result = await resolveSearchRedirect(GOTO, { fetchImpl: vi.fn(async () => waitingPage([])) });
    expect(result).not.toHaveProperty('retryCookies');
  });

  it('sends the cookies option as a Cookie header', async () => {
    const fetchImpl = vi.fn(async () => redirect(302, 'https://example.org/a'));
    await resolveSearchRedirect(GOTO, { fetchImpl, cookies: ['NID=abc', 'B=c'] });
    expect(fetchImpl).toHaveBeenCalledWith(GOTO, expect.objectContaining({ headers: { Cookie: 'NID=abc; B=c' } }));
  });

  it('sends no Cookie header without the option', async () => {
    const fetchImpl = vi.fn(async () => redirect(302, 'https://example.org/a'));
    await resolveSearchRedirect(GOTO, { fetchImpl });
    expect(fetchImpl.mock.calls[0][1]).not.toHaveProperty('headers');
  });
});
