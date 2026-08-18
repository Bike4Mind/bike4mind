import * as cheerio from 'cheerio';
import type { PublishVisibility } from '@bike4mind/common';
import { BLESSED_SCRIPT_PATHS, PUBLISH_HOST } from './validateBundle';
import { buildFragmentNavScriptTag } from './fragmentNav';

/**
 * Publish - sandboxed-bundle serializer.
 *
 * Re-enables author inline JS by preparing a bundle's `index.html` to be hosted
 * inside a `<iframe sandbox="allow-scripts">` (NO `allow-same-origin`) on the
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
   * URL paths that identify THIS page (canonical /p path plus the /a/<token> or /uc
   * alias it was reached at). When set, the fragment-nav helper (see fragmentNav.ts)
   * is injected so same-page `#fragment` links scroll in place instead of triggering
   * a cross-document iframe navigation that drops the sandbox's cookies and
   * dead-ends a gated bundle at its prompt shell. Leave unset for self-contained
   * sub-documents (`?a=` reply artifacts), whose real URL fragment-navigates natively.
   */
  pagePaths?: string[];
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
];

export function renderSandboxedBundle(input: RenderSandboxedBundleInput): RenderSandboxedBundleResult {
  const { indexHtml, urlBase, origin, visibility } = input;
  const assets = input.assets ?? new Map<string, SandboxAsset>();
  const assetMode = input.assetMode ?? (visibility === 'public' ? 'base' : 'inline');
  const droppedAssets: string[] = [];

  const $ = cheerio.load(indexHtml);

  // Blessed libs: absolutize root-relative `/static/...` srcs to the app origin so
  // they resolve from the opaque-origin document (which has no base URL of its own).
  const blessed = new Set<string>(BLESSED_SCRIPT_PATHS);
  $('script[src]').each((_i, el) => {
    const src = $(el).attr('src');
    if (src && blessed.has(src)) $(el).attr('src', `${origin}${src}`);
  });

  if (assetMode === 'base') {
    // Relative asset refs load back through the `{urlBase}` route. A <base> makes
    // every relative URL (and the author's own) resolve against the bundle's path.
    ensureBaseHref($, `${origin}${urlBase}/`);
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
      const asset = assets.get(href);
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
        const asset = assets.get(value);
        if (!asset) {
          droppedAssets.push(value);
          return;
        }
        $(el).attr(attr, toDataUri(asset));
      });
    }
  }

  if (input.pagePaths?.length) {
    // After author content so author click handlers run first (the helper skips
    // defaultPrevented events); the pin bridge appends after this, order-independent.
    const tag = buildFragmentNavScriptTag({
      origins: [origin, PUBLISH_HOST ? `https://${PUBLISH_HOST}` : ''],
      paths: input.pagePaths,
    });
    const body = $('body');
    if (body.length) body.append(tag);
    else $.root().append(tag);
  }

  return { srcdoc: $.html(), droppedAssets };
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
