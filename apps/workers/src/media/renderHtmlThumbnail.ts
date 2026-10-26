import sharp from 'sharp';
import type { BrowserContext, BrowserContextOptions } from 'playwright-core';

/**
 * Screenshot an untrusted HTML document into a small WebP. Used for owner-only publish thumbnails
 * by the renderer function (publishThumbnailRenderer.ts); the browser itself comes from
 * `openContext`, so the Lambda passes @sparticuz/chromium (launchLambdaChromium.ts) and a local
 * smoke run can pass Playwright's.
 *
 * Isolation, outermost first:
 *  - a separate function with no application credentials or permissions (infra/queues.ts), whose
 *    execution environment serves one render only (lambdaRuntimeExit.ts);
 *  - a fresh browser context on an empty per-render profile (renderEnvironment.ts): no cookies,
 *    storage, credentials or service workers, downloads off;
 *  - every request is aborted unless it is a GET for one of `allowedScriptUrls` exactly (the
 *    blessed library scripts), WebSockets are closed, and WebRTC is removed from every frame;
 *  - the document runs in `<iframe sandbox="allow-scripts">` - an opaque origin that cannot
 *    navigate the top page, open popups, show dialogs or start downloads - under a CSP that
 *    repeats the network policy (`connect-src 'none'`, images/fonts/media from data: only).
 *
 * A page that never settles is screenshotted as it stands once the settle budget runs out; one
 * that wedges the renderer past the hard deadline throws ThumbnailRenderTimeoutError, which the
 * caller treats as permanent for that version rather than retrying it.
 */

export const THUMBNAIL_VIEWPORT = { width: 1280, height: 800 } as const;
export const THUMBNAIL_OUTPUT = { width: 640, height: 400 } as const;
/** Wait for network idle at most this long (ms), then screenshot whatever is painted. */
export const THUMBNAIL_SETTLE_TIMEOUT_MS = 15_000;
/** Ceiling for one render from page creation to encoded image (ms); inside the 60 s Lambda timeout. */
export const THUMBNAIL_HARD_TIMEOUT_MS = 35_000;
/** Lets a just-mounted script-rendered page paint before the capture (ms). */
const PAINT_SETTLE_MS = 400;
const SCREENSHOT_TIMEOUT_MS = 10_000;
const CLOSE_TIMEOUT_MS = 5_000;
const WEBP_QUALITY = 80;

/** Chromium switches every thumbnail launch adds: no UDP for WebRTC even if a frame reaches it. */
export const THUMBNAIL_CHROMIUM_ARGS = ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp'];

export const THUMBNAIL_CONTEXT_OPTIONS: BrowserContextOptions = {
  viewport: { ...THUMBNAIL_VIEWPORT },
  deviceScaleFactor: 1,
  javaScriptEnabled: true,
  acceptDownloads: false,
  serviceWorkers: 'block',
  reducedMotion: 'reduce',
  colorScheme: 'light',
  locale: 'en-US',
  timezoneId: 'UTC',
};

/** Opens an isolated context; `close` must tear down everything the call launched. */
export type OpenThumbnailContext = (
  options: BrowserContextOptions
) => Promise<{ context: BrowserContext; close: () => Promise<void> }>;

export class ThumbnailRenderTimeoutError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ThumbnailRenderTimeoutError';
  }
}

export interface RenderHtmlThumbnailInput {
  /** The document to depict. Hosted as the srcdoc of a sandboxed frame, never as the top page. */
  srcdoc: string;
  /** Exact URLs (origin + path, no query) the document may load. Everything else is aborted. */
  allowedScriptUrls: readonly string[];
  openContext: OpenThumbnailContext;
  settleTimeoutMs?: number;
  hardTimeoutMs?: number;
}

export async function renderHtmlThumbnail(input: RenderHtmlThumbnailInput): Promise<Buffer> {
  const { context, close } = await input.openContext(THUMBNAIL_CONTEXT_OPTIONS);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new ThumbnailRenderTimeoutError('thumbnail render exceeded its hard deadline')),
        input.hardTimeoutMs ?? THUMBNAIL_HARD_TIMEOUT_MS
      );
    });
    const png = await Promise.race([capture(context, input), deadline]);
    return await sharp(png)
      .resize(THUMBNAIL_OUTPUT.width, THUMBNAIL_OUTPUT.height, { fit: 'cover', position: 'top' })
      .webp({ quality: WEBP_QUALITY })
      .toBuffer();
  } finally {
    clearTimeout(timer);
    // A wedged browser can hang close(); the Lambda timeout reaps it if this gives up first.
    await settleWithin(close(), CLOSE_TIMEOUT_MS);
  }
}

async function capture(context: BrowserContext, input: RenderHtmlThumbnailInput): Promise<Buffer> {
  const allowed = new Set(input.allowedScriptUrls);
  await context.route('**/*', route => {
    const request = route.request();
    return isAllowedThumbnailRequest(request.url(), request.method(), allowed)
      ? route.continue()
      : route.abort('blockedbyclient');
  });
  await context.routeWebSocket(/.*/, ws => ws.close());
  await context.addInitScript(DISABLE_WEBRTC_SCRIPT);

  const page = await context.newPage();
  page.on('popup', popup => void popup.close().catch(() => undefined));

  const settleTimeoutMs = input.settleTimeoutMs ?? THUMBNAIL_SETTLE_TIMEOUT_MS;
  const settleBy = Date.now() + settleTimeoutMs;
  const frameHtml = buildThumbnailFrameHtml(input.srcdoc, scriptOriginsOf(input.allowedScriptUrls));
  await ignoreTimeout(page.setContent(frameHtml, { waitUntil: 'load', timeout: settleTimeoutMs }));
  await ignoreTimeout(page.waitForLoadState('networkidle', { timeout: Math.max(1, settleBy - Date.now()) }));
  await sleep(PAINT_SETTLE_MS);

  try {
    return await page.screenshot({ type: 'png', animations: 'disabled', timeout: SCREENSHOT_TIMEOUT_MS });
  } catch (err) {
    if (isPlaywrightTimeout(err))
      throw new ThumbnailRenderTimeoutError('thumbnail screenshot timed out', { cause: err });
    throw err;
  }
}

/** The top page: nothing but the sandboxed frame, sized to the viewport, under a no-network CSP. */
export function buildThumbnailFrameHtml(srcdoc: string, scriptOrigins: readonly string[]): string {
  // Inherited by the about:srcdoc document, so it binds the author's code too.
  const csp = [
    "default-src 'none'",
    ['script-src', "'unsafe-inline'", ...scriptOrigins].join(' '),
    "style-src 'unsafe-inline'",
    'img-src data: blob:',
    'font-src data:',
    'media-src data: blob:',
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ');
  const { width, height } = THUMBNAIL_VIEWPORT;
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(csp)}">`,
    `<style>html,body{margin:0;padding:0;overflow:hidden;background:#fff}iframe{display:block;border:0;width:${width}px;height:${height}px}</style>`,
    `</head><body><iframe sandbox="allow-scripts" srcdoc="${escapeAttribute(srcdoc)}"></iframe></body></html>`,
  ].join('');
}

/** GET of an exact allowlisted URL, or an inline data:/blob: resource. No query, no credentials. */
export function isAllowedThumbnailRequest(url: string, method: string, allowed: ReadonlySet<string>): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === 'data:' || parsed.protocol === 'blob:') return true;
  if (method !== 'GET' || parsed.search || parsed.username || parsed.password) return false;
  return allowed.has(`${parsed.origin}${parsed.pathname}`);
}

function scriptOriginsOf(urls: readonly string[]): string[] {
  const origins = new Set<string>();
  for (const url of urls) {
    try {
      origins.add(new URL(url).origin);
    } catch {
      // An unparsable entry can never match a request either.
    }
  }
  return [...origins];
}

// Runs before any page script in every frame. Deleting the constructors is what stops a frame
// reaching a STUN/TURN host; the launch flag only narrows which transport it could have used.
const DISABLE_WEBRTC_SCRIPT = `for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel']) {
  try { delete window[name]; } catch (e) {}
}`;

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

async function ignoreTimeout(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
  } catch (err) {
    if (!isPlaywrightTimeout(err)) throw err;
  }
}

function isPlaywrightTimeout(err: unknown): boolean {
  return err instanceof Error && err.name === 'TimeoutError';
}

async function settleWithin(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([promise.catch(() => undefined), new Promise(resolve => (timer = setTimeout(resolve, ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
