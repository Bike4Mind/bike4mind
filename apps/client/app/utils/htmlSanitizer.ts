import DOMPurify from 'dompurify';
import { BLESSED_SCRIPT_PATHS } from '@bike4mind/common';

/**
 * Shared DOMPurify configuration for HTML artifact rendering.
 *
 * Both the inline chat preview (InlineArtifactPreview) and the full-panel
 * HTML artifact viewer (HtmlArtifactViewer) render user-supplied HTML inside
 * a sandboxed iframe. The iframe `sandbox` attribute is the real security
 * boundary; DOMPurify's role here is to strip event-handler attributes and
 * `javascript:` URIs - NOT to prune layout-critical HTML5 tags. An earlier
 * over-restrictive allow-list replaced DOMPurify's defaults and stripped
 * <head>/<link>/<meta>/semantic tags, breaking page layout.
 */

// Event-handler attributes. DOMPurify strips `on*` attributes by default, so
// this list is belt-and-suspenders. Kept as a named constant so both call
// sites stay in sync (previously they drifted: one listed 7 handlers, the
// other 10).
const FORBIDDEN_EVENT_ATTRS = [
  'onload',
  'onerror',
  'onclick',
  'onmouseover',
  'onmouseout',
  'onfocus',
  'onblur',
  'onchange',
  'onsubmit',
  'onreset',
];

// Document-shell tags that DOMPurify strips by default. We extend the default
// allow-list (which already covers HTML5 semantic tags, text tags, and media
// tags) rather than replacing it.
const DOCUMENT_SHELL_TAGS = ['link', 'meta', 'style', 'html', 'head', 'body', 'title'];

// Layout/meta/a11y attributes not present in DOMPurify's default allow-list.
const EXTRA_ATTRS = [
  'rel',
  'media',
  'content',
  'name',
  'charset',
  'integrity',
  'crossorigin',
  'role',
  'colspan',
  'rowspan',
];

// Script-specific attributes, only added when the caller opts in to scripts.
const SCRIPT_ATTRS = ['defer', 'async', 'type', 'src'];

export interface SanitizeHtmlOptions {
  /**
   * Opt in to retaining `<script>` tags (both inline and `src`) in the output.
   *
   * SECURITY MODEL: when scripts are allowed we deliberately do NOT narrow
   * DOMPurify's `ALLOWED_URI_REGEXP`. That regexp is global - narrowing it to a
   * script-host allow-list would also strip legitimate CDN stylesheet `<link>`s,
   * images, and fonts. Instead, the real boundaries are (1) the consuming
   * iframe's `sandbox="allow-scripts"` (no `allow-same-origin` -> opaque origin,
   * so author JS cannot touch the app's cookies/storage/credentialed fetch) and
   * (2) the per-route CSP on `/api/artifact-sandbox`, whose `script-src` pins
   * which script `src` hosts/paths can actually load. We still always forbid
   * `iframe`/`object`/`embed` so injected content cannot nest privileged frames
   * or plugins even when scripts are allowed.
   *
   * This path also disables DOMPurify's SAFE_FOR_XML mXSS guard, which would
   * otherwise force-remove any <script> whose body contains a `<` glued to a
   * word char (ordinary JS like `for(i=0;i<n;i++)`); see the call site for the
   * full rationale. The sandbox iframe + route CSP remain the boundary.
   *
   * Callers that render into a NON-sandboxed context must leave this false.
   */
  allowScripts?: boolean;
}

export interface SanitizeHtmlResult {
  cleanHtml: string;
  isCompleteDocument: boolean;
}

// Root-relative blessed-library `<script src>` (e.g. /static/lib/chart.js@4.x.js,
// see BLESSED_SCRIPT_PATHS) point at the app's self-hosted libs. HTML artifacts
// render inside an opaque-origin sandbox iframe (no base URL of its own), so a
// root-relative src would never resolve. Absolutize EXACTLY the blessed paths to
// the app origin - the same `blessed.has(src)` rewrite the publish path performs
// (renderSandboxedBundle.ts) - so the lib loads cross-origin from the app host.
// The /api/artifact-sandbox CSP pins which of these may actually load.
//
// Matches any quoted `<script src>` (whitespace-anchored `\s+src` tolerates
// `src = "..."` spacing and avoids a false match on `data-src`), then rewrites only
// srcs that exactly equal a blessed path - non-blessed srcs are left untouched,
// identical to the publish-side allowlist.
const SCRIPT_SRC = /(<script\b[^>]*?\s+src\s*=\s*["'])([^"']*)(["'])/gi;

/**
 * Rewrite root-relative blessed `<script src>` to absolute app-origin URLs.
 * No-op on the server (no `window`); callers run this client-side before handing
 * HTML to the sandbox iframe.
 */
export const absolutizeBlessedScripts = (htmlContent: string): string => {
  if (typeof window === 'undefined') return htmlContent;
  const origin = window.location.origin;
  const blessed = new Set(BLESSED_SCRIPT_PATHS);
  return htmlContent.replace(SCRIPT_SRC, (match, pre, src, post) =>
    blessed.has(src) ? `${pre}${origin}${src}${post}` : match
  );
};

/**
 * Sanitize an HTML string for safe rendering inside a sandboxed iframe.
 *
 * Detects whether the input is a complete document (has `<!doctype` or
 * `<html>`) and preserves the document shell via `WHOLE_DOCUMENT` so that
 * stylesheet links, viewport meta, and `<title>` survive sanitization.
 */
export const sanitizeHtmlForIframe = (htmlContent: string, options: SanitizeHtmlOptions = {}): SanitizeHtmlResult => {
  const { allowScripts = false } = options;

  const lower = htmlContent.toLowerCase();
  const isCompleteDocument = lower.includes('<!doctype') || lower.includes('<html');

  const cleanHtml = DOMPurify.sanitize(htmlContent, {
    WHOLE_DOCUMENT: isCompleteDocument,
    ALLOW_DATA_ATTR: true,
    ALLOW_ARIA_ATTR: true,
    // DOMPurify's SAFE_FOR_XML mXSS guard (on by default) force-removes any
    // raw-text node whose content matches /<[/\w!]/ - i.e. a `<` glued to a
    // letter/digit/`_`/`/`/`!`. That heuristic exists to catch namespace-
    // confusion markup smuggled through text nodes, but it cannot tell HTML
    // from JavaScript: ordinary comparison/loop code (`for(i=0;i<n;i++)`,
    // `if(x<0)`, `a<b`) trips it, so DOMPurify silently deletes the WHOLE
    // <script> and interactive artifacts render inert. Disable the guard ONLY
    // on the allowScripts path, where the real boundary is already (1) the
    // opaque-origin sandbox iframe (`allow-scripts`, no `allow-same-origin`)
    // and (2) the /api/artifact-sandbox route CSP - and where the sanitized
    // output is `document.write`n into that opaque origin, so mXSS cannot reach
    // the app origin regardless. The default (guarded) path is untouched.
    ...(allowScripts ? { SAFE_FOR_XML: false } : {}),
    ADD_TAGS: [...DOCUMENT_SHELL_TAGS, ...(allowScripts ? ['script'] : [])],
    ADD_ATTR: [...EXTRA_ATTRS, ...(allowScripts ? SCRIPT_ATTRS : [])],
    FORBID_ATTR: FORBIDDEN_EVENT_ATTRS,
    // Always forbid plugin / nested-navigation tags. When `allowScripts`, we
    // additionally keep `script` out of FORBID_TAGS (it's on the allow-list via
    // ADD_TAGS). We intentionally leave DOMPurify's default ALLOWED_URI_REGEXP
    // in place rather than narrowing it: the iframe sandbox + the route CSP
    // (see SanitizeHtmlOptions.allowScripts) are the boundary that pins which
    // script sources may actually load.
    FORBID_TAGS: allowScripts ? ['iframe', 'object', 'embed'] : ['script', 'iframe', 'object', 'embed'],
  });

  return { cleanHtml, isCompleteDocument };
};
