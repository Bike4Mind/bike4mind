import * as cheerio from 'cheerio';
import type { PublishVisibility } from '@bike4mind/common';
import { BLESSED_SCRIPT_PATHS, PUBLISH_HOST } from './validateBundle';
import { buildFragmentNavScriptTag } from './fragmentNav';
import { buildPrintBridgeTag } from './printBridge';

/**
 * Publish - sandboxed-bundle serializer.
 *
 * Re-enables author inline JS by preparing a bundle's `index.html` to be hosted
 * inside a `<iframe sandbox={VIEWER_SANDBOX}>` (NO `allow-same-origin`) on the
 * `/p/...` viewer page. The sandbox gives the bundle an opaque (`null`) origin:
 * its inline scripts run, but they cannot read the app origin's `localStorage`/
 * cookies, and any `fetch('/api/*')` goes out with no credentials. Author JS is
 * therefore NO LONGER stripped here (contrast the interim same-origin fix that
 * removed every inline `<script>`).
 *
 * Pure function, no I/O - mirrors `validateBundle` so it is fully unit-testable.
 * The serve handler downloads bytes and constructs the iframe wrapper; this
 * function only transforms the bundle HTML that becomes the iframe `srcdoc`.
 *
 * Asset model (the opaque origin has no usable base URL of its own), selected by
 * `assetMode` (defaults from `visibility`: public -> base, gated -> inline):
 *   - base     -> inject `<base href="{origin}{urlBase}/">` so relative asset
 *                refs load back through the `{urlBase}` asset route. Used for
 *                public `/p/*` (uncredentialed) AND for `/a/<shareToken>` links
 *                (the asset requests re-enter carrying the token, so they self-
 *                authorize even for a non-public artifact - no inlining needed).
 *   - inline   -> the caller passes an `assets` map of pre-fetched bytes (fetched
 *                on the app origin WITH the viewer's credential); each relative
 *                ref is inlined as a `data:` URI / inline `<style>` so the opaque
 *                origin never makes a credentialed request. Missing/oversized
 *                assets are reported in `droppedAssets` rather than left to fail
 *                silently.
 *
 * Blessed library scripts (`/static/...`, see BLESSED_SCRIPT_PATHS) are always
 * rewritten to absolute `{origin}{path}` URLs - a root-relative path would not
 * resolve against the opaque `about:srcdoc` document, and they load fine
 * cross-origin from the app host without credentials.
 *
 * Off-origin `<a href>`s are retargeted to a new tab (see `retargetOffOriginLinks`),
 * which is the only outbound navigation the viewer sandbox permits.
 *
 * Multi-page bundles: `pagePath` names the bundle file being rendered (default
 * `index.html`). Relative refs resolve against THAT file's directory, exactly as they
 * would on a static host, and relative `<a href>`s into the bundle are rewritten to
 * absolute bundle URLs. The rewrite is what makes them work at all in inline mode: an
 * `about:srcdoc` document inherits the wrapper's base URL (`.../{slug}`, no trailing
 * slash), so `poster/poster.html` would otherwise resolve one segment too high.
 * A page other than `index.html` never went through publish-time validation, so the
 * markup that validation rejects on the index (frames, `<base>`, meta refresh,
 * non-blessed script srcs) is stripped from it here instead.
 *
 * Every render also carries the print bridge (see `printBridge.ts`) - the wrapper's
 * "Save as PDF" prints THIS document rather than the frame-clipping wrapper, so the
 * trigger has to live in the bundle. Unconditional, so the saved `?export=html` file
 * and the isolated-origin render print the same way the wrapper does.
 */

export interface SandboxAsset {
  data: Buffer;
  mimeType: string;
}

export interface RenderSandboxedBundleInput {
  /** Raw HTML content of `index.html`. */
  indexHtml: string;
  /** Public URL path for the bundle, e.g. `/p/u/{scopeId}/{slug}` (no trailing slash). */
  urlBase: string;
  /** Document origin to resolve absolute URLs against, e.g. `https://app.example.com`. */
  origin: string;
  scriptOrigin?: string;
  /** Artifact visibility - the default `assetMode` derives from it (public -> base). */
  visibility: PublishVisibility;
  /**
   * Override the asset strategy. Defaults to `base` for public visibility and
   * `inline` otherwise. `/a/<shareToken>` links force `base` regardless of
   * visibility (token-authorized asset sub-paths need no inlining).
   */
  assetMode?: 'base' | 'inline';
  /**
   * Pre-fetched bundle assets keyed by their relative manifest path. Required when
   * `assetMode` resolves to `inline`; ignored for `base`.
   */
  assets?: Map<string, SandboxAsset>;
  /**
   * Short-lived signed storage URLs keyed by manifest path, minted post-gate by the caller
   * (inline mode only). A media ref with an entry here points straight at storage instead
   * of being inlined: video, audio and oversized images cannot ride a `data:` URI, and the
   * opaque frame cannot fetch them back through the gated route (no cookie on its requests).
   */
  signedAssets?: Map<string, string>;
  /**
   * URL paths that identify THIS page (canonical /p path plus the /a/<token> or /uc
   * alias it was reached at). When set, the fragment-nav helper (see fragmentNav.ts)
   * is injected so same-page `#fragment` links scroll in place instead of triggering
   * a cross-document iframe navigation that drops the sandbox's cookies and
   * dead-ends a gated bundle at its prompt shell. Leave unset for self-contained
   * sub-documents (`?a=` reply artifacts), whose real URL fragment-navigates natively.
   */
  pagePaths?: string[];
  /**
   * Bundle-relative path of the file being rendered (`index.html` when unset). Relative
   * refs resolve against its directory, and a page other than `index.html` is hardened
   * (see the file header).
   */
  pagePath?: string;
  /**
   * Route same-bundle links (other pages, downloadable files) to the parent wrapper via
   * the fragment-nav helper so they navigate at TOP level. Only meaningful when the
   * parent runs the hash bridge (srcdoc wrapper / loader shell); the isolated origin
   * navigates natively and must leave this off, or the click would go unanswered.
   */
  routeBundleLinks?: boolean;
}

export interface RenderSandboxedBundleResult {
  /** Transformed bundle HTML, ready to be embedded as an iframe `srcdoc`. */
  srcdoc: string;
  /** Relative asset paths that could not be inlined (missing/oversized) - gated only. */
  droppedAssets: string[];
}

/** Relative-ref attributes to rewrite/inline (excludes `script[src]`, handled separately). */
const RELATIVE_ATTR_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['img[src]', 'src'],
  ['video[src]', 'src'],
  ['audio[src]', 'src'],
  ['source[src]', 'src'],
  ['video[poster]', 'poster'],
];

export function renderSandboxedBundle(input: RenderSandboxedBundleInput): RenderSandboxedBundleResult {
  const { indexHtml, urlBase, origin, visibility } = input;
  const assets = input.assets ?? new Map<string, SandboxAsset>();
  const assetMode = input.assetMode ?? (visibility === 'public' ? 'base' : 'inline');
  const droppedAssets: string[] = [];
  const pagePath = input.pagePath || 'index.html';
  const pageDir = pagePath.includes('/') ? pagePath.slice(0, pagePath.lastIndexOf('/') + 1) : '';

  const $ = cheerio.load(indexHtml);

  if (pagePath !== 'index.html') hardenSecondaryPage($);

  // Blessed libs: absolutize root-relative `/static/...` srcs to the app origin so
  // they resolve from the opaque-origin document (which has no base URL of its own).
  const blessed = new Set<string>(BLESSED_SCRIPT_PATHS);
  $('script[src]').each((_i, el) => {
    const src = $(el).attr('src');
    if (src && blessed.has(src)) $(el).attr('src', `${input.scriptOrigin ?? origin}${src}`);
  });

  if (assetMode === 'base') {
    // Relative asset refs load back through the `{urlBase}` route. A <base> makes
    // every relative URL (and the author's own) resolve against the bundle's path.
    ensureBaseHref($, `${origin}${urlBase}/${encodeBundlePath(pageDir)}`);
  } else {
    // Gated: inline every relative asset from the pre-fetched (credentialed) bytes so
    // the opaque origin never issues a credentialed request. Stylesheets become inline
    // <style>; everything else becomes a `data:` URI.
    //
    // AUTHORING CONSTRAINT (gated tier only): relative `@import` / `url(...)` references
    // INSIDE an inlined stylesheet are NOT recursively inlined - `about:srcdoc` has no base
    // URL, so they won't resolve (the subresource is silently absent). One-page artifacts
    // rarely chain stylesheets this way; authors who need it should inline their CSS or use
    // absolute app-host URLs. Public-tier bundles are unaffected (they keep the <base>).
    $('link[rel~="stylesheet"]').each((_i, el) => {
      const href = $(el).attr('href');
      if (!href || !isRelativeBundlePath(href)) return;
      const asset = assets.get(resolveBundlePath(pagePath, href) ?? href);
      if (!asset) {
        droppedAssets.push(href);
        $(el).remove();
        return;
      }
      $(el).replaceWith(`<style>${asset.data.toString('utf-8')}</style>`);
    });

    for (const [selector, attr] of RELATIVE_ATTR_PAIRS) {
      $(selector).each((_i, el) => {
        const value = $(el).attr(attr);
        if (!value || !isRelativeBundlePath(value)) return;
        const key = resolveBundlePath(pagePath, value) ?? value;
        const signed = input.signedAssets?.get(key);
        if (signed) {
          $(el).attr(attr, signed);
          return;
        }
        const asset = assets.get(key);
        if (!asset) {
          droppedAssets.push(value);
          return;
        }
        $(el).attr(attr, toDataUri(asset));
      });
    }
  }

  // Self-contained documents (`?a=` reply artifacts, exports) pass no urlBase: no bundle to link into.
  if (urlBase) absolutizeBundleLinks($, origin, urlBase, pagePath);
  retargetOffOriginLinks($, origin);

  if (input.pagePaths?.length) {
    // After author content so author click handlers run first (the helper skips
    // defaultPrevented events); the pin bridge appends after this, order-independent.
    appendToBody(
      $,
      buildFragmentNavScriptTag({
        origins: [origin, PUBLISH_HOST ? `https://${PUBLISH_HOST}` : ''],
        paths: input.pagePaths,
        bundleBases: input.routeBundleLinks ? [urlBase] : [],
      })
    );
  }

  appendToBody($, buildPrintBridgeTag());

  return { srcdoc: $.html(), droppedAssets };
}

/**
 * Force off-origin links into a new tab. Framing another origin is refused by the viewer's
 * `frame-src`, which replaces the whole artifact with the browser's "content is blocked"
 * page; a popup is what `VIEWER_SANDBOX` permits instead. `noopener` is added, but NOT
 * `noreferrer`: outbound referral attribution is deliberately kept (share links suppress
 * the Referer separately via the wrapper's referrer policy, which the framed document
 * inherits). Author JS that assigns `location` off-origin is still blocked - only the
 * link forms are covered.
 */
function retargetOffOriginLinks($: cheerio.CheerioAPI, origin: string): void {
  const sameOrigin = new Set([origin, PUBLISH_HOST ? `https://${PUBLISH_HOST}` : ''].filter(Boolean));
  $('a[href]').each((_i, el) => {
    let url: URL;
    try {
      // Resolved against the doc origin so relative and protocol-relative hrefs classify too.
      url = new URL($(el).attr('href') ?? '', origin);
    } catch {
      return;
    }
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || sameOrigin.has(url.origin)) return;
    $(el).attr('target', '_blank');
    const rel = new Set(($(el).attr('rel') ?? '').split(/\s+/).filter(Boolean));
    rel.add('noopener');
    $(el).attr('rel', [...rel].join(' '));
  });
}

/**
 * Rewrite relative `<a href>`s to absolute bundle URLs, resolved against the rendered
 * page's directory. A link to `index.html` (or the bundle root) maps to the bundle's own
 * URL, so the fragment helper treats `index.html#x` from the index as an in-page jump.
 * Links that climb out of the bundle are left alone; the server would 404 them anyway.
 * The query is dropped, except a file's exact `?download=1`, the one query the navigate
 * bridge passes on (fragmentNav.ts).
 */
function absolutizeBundleLinks($: cheerio.CheerioAPI, origin: string, urlBase: string, pagePath: string): void {
  $('a[href]').each((_i, el) => {
    const href = $(el).attr('href') ?? '';
    if (!isRelativeBundlePath(href)) return;
    const resolved = resolveBundlePath(pagePath, href);
    if (resolved === null) return;
    const hashAt = href.indexOf('#');
    const hash = hashAt === -1 ? '' : href.slice(hashAt);
    const beforeHash = hashAt === -1 ? href : href.slice(0, hashAt);
    const queryAt = beforeHash.indexOf('?');
    const download = queryAt !== -1 && beforeHash.slice(queryAt) === '?download=1' && !isBundlePagePath(resolved);
    const target = resolved === '' || resolved === 'index.html' ? '' : `/${encodeBundlePath(resolved)}`;
    $(el).attr('href', `${origin}${urlBase}${target}${download ? '?download=1' : ''}${hash}`);
  });
}

/**
 * Strip from a secondary page what publish-time validation rejects on `index.html`. The
 * opaque sandbox is the security boundary either way; this keeps a secondary page from
 * framing other documents, retargeting its own base, or redirecting itself, which the
 * index cannot do either.
 */
function hardenSecondaryPage($: cheerio.CheerioAPI): void {
  $('iframe, frame, frameset, object, embed, base').remove();
  $('meta[http-equiv]').each((_i, el) => {
    if (($(el).attr('http-equiv') ?? '').trim().toLowerCase() === 'refresh') $(el).remove();
  });
  const blessed = new Set<string>(BLESSED_SCRIPT_PATHS);
  $('script[src]').each((_i, el) => {
    if (!blessed.has($(el).attr('src') ?? '')) $(el).remove();
  });
}

/**
 * Resolve a relative ref against the directory of `pagePath` to a bundle-relative path
 * (no leading slash, query and fragment dropped, percent-decoded to match manifest keys).
 * Returns null for a ref that climbs out of the bundle root or cannot be parsed.
 */
export function resolveBundlePath(pagePath: string, ref: string): string | null {
  // A sentinel origin with a root marker segment: `..` past the marker means the ref
  // escaped the bundle, which plain URL resolution would silently clamp at `/`.
  const ROOT = 'https://bundle.invalid/__root__/';
  let url: URL;
  try {
    url = new URL(ref, new URL(pagePath, ROOT));
  } catch {
    return null;
  }
  if (url.origin !== 'https://bundle.invalid' || !url.pathname.startsWith('/__root__/')) return null;
  const rel = url.pathname.slice('/__root__/'.length);
  try {
    return decodeURIComponent(rel);
  } catch {
    return rel;
  }
}

/**
 * True for a bundle file that is a page: rendered through the sandboxed wrapper like the
 * index, never served raw. Decided by extension, not the publisher-supplied MIME type -
 * the file never reaches the browser as its own document, so its declared type is moot.
 */
export function isBundlePagePath(path: string): boolean {
  return /\.html?$/i.test(path);
}

/** Percent-encode each segment of a bundle-relative path for use in a URL. */
export function encodeBundlePath(path: string): string {
  return path
    .split('/')
    .map(seg => encodeURIComponent(seg))
    .join('/');
}

/** Append markup after the author's content, tolerating a bundle with no `<body>`. */
function appendToBody($: cheerio.CheerioAPI, markup: string): void {
  const body = $('body');
  if (body.length) body.append(markup);
  else $.root().append(markup);
}

/** Insert (or update) a single `<base href>` as the first child of `<head>`. */
function ensureBaseHref($: cheerio.CheerioAPI, href: string): void {
  const existing = $('base[href]').first();
  if (existing.length) {
    existing.attr('href', href);
    return;
  }
  const head = $('head');
  const baseTag = `<base href="${href}">`;
  if (head.length) head.prepend(baseTag);
  else $.root().prepend(baseTag);
}

function toDataUri(asset: SandboxAsset): string {
  return `data:${asset.mimeType};base64,${asset.data.toString('base64')}`;
}

/** A bundle-relative path (not a fragment, root-absolute, or scheme-qualified URL). */
function isRelativeBundlePath(url: string): boolean {
  if (!url) return false;
  if (url.startsWith('#')) return false;
  if (url.startsWith('/')) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return false;
  return true;
}
