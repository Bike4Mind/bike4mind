import { describe, it, expect, vi } from 'vitest';
import sharp from 'sharp';
import type { BrowserContext } from 'playwright-core';
import {
  buildThumbnailFrameHtml,
  isAllowedThumbnailRequest,
  renderHtmlThumbnail,
  THUMBNAIL_CONTEXT_OPTIONS,
  THUMBNAIL_OUTPUT,
  ThumbnailRenderTimeoutError,
} from './renderHtmlThumbnail';

const SCRIPT = 'https://app.example.test/static/lib/chart.js';

describe('isAllowedThumbnailRequest', () => {
  const allowed = new Set([SCRIPT]);

  it('allows a GET of an exact allowlisted URL and inline data/blob resources', () => {
    expect(isAllowedThumbnailRequest(SCRIPT, 'GET', allowed)).toBe(true);
    expect(isAllowedThumbnailRequest('data:image/png;base64,AAAA', 'GET', allowed)).toBe(true);
    expect(isAllowedThumbnailRequest('blob:null/1234', 'GET', allowed)).toBe(true);
  });

  it('blocks everything else', () => {
    expect(isAllowedThumbnailRequest('https://evil.example.test/static/lib/chart.js', 'GET', allowed)).toBe(false);
    expect(isAllowedThumbnailRequest('https://app.example.test/static/lib/other.js', 'GET', allowed)).toBe(false);
    expect(isAllowedThumbnailRequest(`${SCRIPT}?exfil=1`, 'GET', allowed)).toBe(false);
    expect(isAllowedThumbnailRequest(SCRIPT, 'POST', allowed)).toBe(false);
    expect(isAllowedThumbnailRequest('https://user:pw@app.example.test/static/lib/chart.js', 'GET', allowed)).toBe(
      false
    );
    expect(isAllowedThumbnailRequest('http://169.254.169.254/latest/meta-data/', 'GET', allowed)).toBe(false);
    expect(isAllowedThumbnailRequest('file:///etc/passwd', 'GET', allowed)).toBe(false);
    expect(isAllowedThumbnailRequest('not a url', 'GET', allowed)).toBe(false);
  });
});

describe('buildThumbnailFrameHtml', () => {
  it('hosts the document only inside a scripts-only sandboxed frame under a no-network CSP', () => {
    const html = buildThumbnailFrameHtml('<p class="x">a & b</p>', ['https://app.example.test']);
    expect(html).toContain('<iframe sandbox="allow-scripts" srcdoc="<p class=&quot;x&quot;>a &amp; b</p>"></iframe>');
    expect(html).not.toMatch(/allow-same-origin|allow-top-navigation|allow-popups|allow-downloads|allow-forms/);
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("connect-src 'none'");
    expect(html).toContain("script-src 'unsafe-inline' https://app.example.test");
  });
});

const pngOf = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: { r: 40, g: 90, b: 60 } } })
    .png()
    .toBuffer();

const timeoutError = () => Object.assign(new Error('Timeout exceeded'), { name: 'TimeoutError' });

function fakeBrowser(page: {
  setContent?: () => Promise<void>;
  waitForLoadState?: () => Promise<void>;
  screenshot?: () => Promise<Buffer>;
}) {
  const routeHandlers: Array<(route: unknown) => unknown> = [];
  const pageApi = {
    on: vi.fn(),
    setContent: vi.fn(page.setContent ?? (async () => undefined)),
    waitForLoadState: vi.fn(page.waitForLoadState ?? (async () => undefined)),
    screenshot: vi.fn(page.screenshot ?? (() => pngOf(1280, 800))),
  };
  const context = {
    route: vi.fn(async (_pattern: string, handler: (route: unknown) => unknown) => {
      routeHandlers.push(handler);
    }),
    routeWebSocket: vi.fn(async () => undefined),
    addInitScript: vi.fn(async () => undefined),
    newPage: vi.fn(async () => pageApi),
  };
  const close = vi.fn(async () => undefined);
  const openContext = vi.fn(async () => ({ context: context as unknown as BrowserContext, close }));
  return { openContext, close, context, page: pageApi, routeHandlers };
}

const route = (url: string, method = 'GET') => ({
  request: () => ({ url: () => url, method: () => method }),
  continue: vi.fn(async () => undefined),
  abort: vi.fn(async () => undefined),
});

describe('renderHtmlThumbnail', () => {
  it('renders the document into a 640x400 WebP and closes the browser', async () => {
    const browser = fakeBrowser({});
    const image = await renderHtmlThumbnail({
      srcdoc: '<h1>hi</h1>',
      allowedScriptUrls: [SCRIPT],
      openContext: browser.openContext,
    });

    const meta = await sharp(image).metadata();
    expect(meta).toMatchObject({ format: 'webp', width: THUMBNAIL_OUTPUT.width, height: THUMBNAIL_OUTPUT.height });
    expect(browser.openContext).toHaveBeenCalledWith(THUMBNAIL_CONTEXT_OPTIONS);
    expect(THUMBNAIL_CONTEXT_OPTIONS).toMatchObject({ acceptDownloads: false, serviceWorkers: 'block' });
    expect(browser.page.setContent).toHaveBeenCalledWith(
      expect.stringContaining('<iframe sandbox="allow-scripts" srcdoc="<h1>hi</h1>">'),
      expect.anything()
    );
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  it('routes every request through the allowlist and closes WebSockets', async () => {
    const browser = fakeBrowser({});
    await renderHtmlThumbnail({ srcdoc: '', allowedScriptUrls: [SCRIPT], openContext: browser.openContext });

    expect(browser.context.route).toHaveBeenCalledWith('**/*', expect.any(Function));
    expect(browser.context.routeWebSocket).toHaveBeenCalled();
    const [handler] = browser.routeHandlers;
    const ok = route(SCRIPT);
    const exfil = route('https://collector.example.test/x');
    await handler(ok);
    await handler(exfil);
    expect(ok.continue).toHaveBeenCalled();
    expect(exfil.abort).toHaveBeenCalledWith('blockedbyclient');
    expect(exfil.continue).not.toHaveBeenCalled();
  });

  it('screenshots what is painted when the page never reaches network idle', async () => {
    const browser = fakeBrowser({ waitForLoadState: async () => Promise.reject(timeoutError()) });
    const image = await renderHtmlThumbnail({ srcdoc: '', allowedScriptUrls: [], openContext: browser.openContext });
    expect((await sharp(image).metadata()).format).toBe('webp');
    expect(browser.page.screenshot).toHaveBeenCalled();
  });

  it('throws ThumbnailRenderTimeoutError past the hard deadline and still closes the browser', async () => {
    const browser = fakeBrowser({ screenshot: () => new Promise<Buffer>(() => undefined) });
    await expect(
      renderHtmlThumbnail({ srcdoc: '', allowedScriptUrls: [], openContext: browser.openContext, hardTimeoutMs: 600 })
    ).rejects.toBeInstanceOf(ThumbnailRenderTimeoutError);
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  it('maps a screenshot timeout to ThumbnailRenderTimeoutError', async () => {
    const browser = fakeBrowser({ screenshot: async () => Promise.reject(timeoutError()) });
    await expect(
      renderHtmlThumbnail({ srcdoc: '', allowedScriptUrls: [], openContext: browser.openContext })
    ).rejects.toBeInstanceOf(ThumbnailRenderTimeoutError);
  });

  it('rethrows other browser failures (retryable) and closes the browser', async () => {
    const browser = fakeBrowser({ setContent: async () => Promise.reject(new Error('Target crashed')) });
    await expect(
      renderHtmlThumbnail({ srcdoc: '', allowedScriptUrls: [], openContext: browser.openContext })
    ).rejects.toThrow('Target crashed');
    expect(browser.close).toHaveBeenCalledTimes(1);
  });
});
