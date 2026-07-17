import * as cheerio from 'cheerio';
import { type ValidationViolation, BLESSED_SCRIPT_PATHS } from '@bike4mind/common';

/**
 * Publish - bundle validation. Ported from Polaris Publish v1 via the
 * `artifact-publishing` blueprint.
 *
 * Enforces the blessed-JS allowlist + forbidden-pattern scan + iframe rejection
 * at finalize time. Pure function; no I/O. Returns a (possibly empty) list of
 * violations - empty means the bundle passes. Runs against `index.html` only;
 * relative asset refs must resolve to the bundle manifest, absolute refs must
 * hit an allowlisted host.
 *
 * Sandboxed-origin model: bundles are served inside an opaque-origin
 * `<iframe sandbox="allow-scripts">`, so author INLINE scripts now execute (they
 * are no longer stripped at serve time). The opaque origin - not this validator -
 * is the security boundary against ATO. These publish-time checks are therefore
 * retained as HYGIENE, not as the last line of defense:
 *   - the forbidden-pattern scan (eval/Function/document.write/string-timers) is
 *     kept as a hard rejection - those patterns are code smells and several break
 *     the sandboxed render; rejecting at finalize gives authors clear feedback.
 *   - the `<script src>` allowlist and `<iframe>`/`<base>`/meta-refresh rejections
 *     are kept so a published bundle can't pull arbitrary external code or retarget
 *     the framed document (residual phishing surface even on an opaque origin).
 *
 * Allowlisted hosts are deployment-specific and derived from the deployment's own
 * SERVER_DOMAIN - no brand fallback, so a fork never trusts another deployment's hosts.
 */

/** Deployment domain (e.g. `example.com`, `staging.example.com`); empty when unset. */
const SERVER_DOMAIN = process.env.SERVER_DOMAIN ?? '';

/**
 * Public app host the published bundles are served from - `app.<SERVER_DOMAIN>`.
 * Empty when SERVER_DOMAIN is unconfigured, which makes the host allowlists below (and
 * the viewer host check in viewerSecurity.ts) fail closed rather than trust a brand host.
 */
export const PUBLISH_HOST = SERVER_DOMAIN ? `app.${SERVER_DOMAIN}` : '';

/**
 * Trusted Host suffix for same-deployment subdomains (staging/preview), e.g.
 * `.example.com`. Empty when SERVER_DOMAIN is unset so suffix matching is disabled
 * (never `.` alone, which would match arbitrary trailing-dot hosts).
 */
export const PUBLISH_HOST_SUFFIX = SERVER_DOMAIN ? `.${SERVER_DOMAIN}` : '';

/**
 * Per-artifact isolation host suffix (Approach B). Published bundles render at
 * `{publicId}.usercontent.app.<SERVER_DOMAIN>` - its own browser origin per artifact. The
 * host is nested under the app host (`usercontent.app....`, not `usercontent....`) so its ACM
 * cert validation/alias records resolve inside the existing `app.<SERVER_DOMAIN>` Route53
 * zone without a dedicated hosted zone or NS delegation; must stay in sync with the
 * `*.usercontent.app.${domain}` alias in infra/router.ts. Empty when SERVER_DOMAIN is unset,
 * which disables Approach B (the serve handler then falls back to the same-origin
 * sandboxed-iframe srcdoc model).
 */
export const USERCONTENT_HOST_SUFFIX = SERVER_DOMAIN ? `.usercontent.app.${SERVER_DOMAIN}` : '';

const B4M_HOST = PUBLISH_HOST;

/**
 * Blessed `<script src>` paths (same-origin) - defined in `@bike4mind/common` so the
 * publish validator/CSP (server) and the in-app sandbox sanitizer (client) share one
 * source of truth. Re-exported here so existing server importers keep their path.
 */
export { BLESSED_SCRIPT_PATHS };

/** Allowed `<script src>` URLs - strict exact-match. Relative + absolute forms of the blessed
 *  libs; the absolute form is added only when B4M_HOST is configured (self-host with
 *  SERVER_DOMAIN unset would otherwise allowlist a scheme-only `https:///static/...`). The
 *  relative blessed paths still validate either way, which is the self-host reference form. */
const ALLOWED_SCRIPT_SRC: readonly string[] = [
  ...BLESSED_SCRIPT_PATHS,
  ...(B4M_HOST ? BLESSED_SCRIPT_PATHS.map(p => `https://${B4M_HOST}${p}`) : []),
];

/** Exact-match stylesheet allowlist (empty; reserved for stable blessed URLs). */
const ALLOWED_STYLESHEET_HREF: readonly string[] = [];

/** Hosts allowed for `<link rel="stylesheet">` regardless of path/query. */
const ALLOWED_STYLESHEET_HOSTS: readonly string[] = ['fonts.googleapis.com'];

/** Hosts allowed for content-bearing asset URLs (img/video/audio/source/link). */
const ALLOWED_ASSET_HOSTS: readonly string[] = [B4M_HOST];

/** Hosts allowed for connection hints (preconnect/dns-prefetch only - no content). */
const ALLOWED_PRECONNECT_HOSTS: readonly string[] = ['fonts.googleapis.com', 'fonts.gstatic.com'];

/** Inline-script patterns that trigger automatic rejection. */
const FORBIDDEN_INLINE_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\beval\s*\(/, reason: 'Inline script uses eval()' },
  { pattern: /\bnew\s+Function\s*\(/, reason: 'Inline script uses new Function()' },
  { pattern: /\bFunction\s*\([^)]*\)\s*\(/, reason: 'Inline script invokes Function() constructor' },
  { pattern: /document\.write\s*\(/, reason: 'Inline script uses document.write()' },
  { pattern: /document\.writeln\s*\(/, reason: 'Inline script uses document.writeln()' },
  {
    pattern: /set(?:Timeout|Interval)\s*\(\s*['"`]/,
    reason: 'Inline script uses string-form setTimeout/setInterval (equivalent to eval)',
  },
];

export interface ValidateBundleInput {
  /** Raw HTML content of `index.html`. */
  indexHtml: string;
  /** Manifest of all files in the bundle; relative refs must resolve here. */
  manifest: Array<{ path: string; mimeType: string }>;
}

export interface ValidateBundleResult {
  valid: boolean;
  violations: ValidationViolation[];
}

export function validateBundle(input: ValidateBundleInput): ValidateBundleResult {
  const violations: ValidationViolation[] = [];
  const $ = cheerio.load(input.indexHtml);
  const manifestPaths = new Set(input.manifest.map(f => f.path));

  // <script src> allowlist
  $('script[src]').each((_i, el) => {
    const src = $(el).attr('src') ?? '';
    if (!ALLOWED_SCRIPT_SRC.includes(src)) {
      violations.push({
        type: 'csp_violation',
        message: `Disallowed script source: ${src}. Allowed: ${ALLOWED_SCRIPT_SRC.join(', ')}`,
        file: 'index.html',
      });
    }
  });

  // <link rel="stylesheet"> - token-match `rel` so "stylesheet preload" still counts
  $('link[rel~="stylesheet"]').each((_i, el) => {
    const href = $(el).attr('href') ?? '';
    if (isRelativePath(href)) {
      if (!manifestPaths.has(href)) {
        violations.push({
          type: 'invalid_asset_url',
          message: `Stylesheet references missing bundle file: ${href}`,
          file: 'index.html',
        });
      }
      return;
    }
    if (isAllowedStylesheetHref(href)) return;
    violations.push({ type: 'csp_violation', message: `Disallowed stylesheet source: ${href}`, file: 'index.html' });
  });

  // <iframe> rejection
  $('iframe').each((_i, el) => {
    const src = $(el).attr('src') ?? '(no src)';
    violations.push({
      type: 'forbidden_iframe',
      message: `Iframes are not permitted (found <iframe src="${src}">)`,
      file: 'index.html',
    });
  });

  // <meta http-equiv="refresh"> + <base> rejection - these redirect/retarget the
  // page (CSP can't block meta-refresh), enabling phishing on the trusted domain.
  $('meta[http-equiv]').each((_i, el) => {
    if (($(el).attr('http-equiv') ?? '').trim().toLowerCase() === 'refresh') {
      violations.push({
        type: 'forbidden_pattern',
        message: 'meta refresh redirects are not permitted',
        file: 'index.html',
      });
    }
  });
  $('base').each(() => {
    violations.push({ type: 'forbidden_pattern', message: '<base> is not permitted', file: 'index.html' });
  });

  // Inline <script> forbidden-pattern scan
  $('script:not([src])').each((_i, el) => {
    const code = $(el).html() ?? '';
    for (const { pattern, reason } of FORBIDDEN_INLINE_PATTERNS) {
      if (pattern.test(code)) {
        violations.push({ type: 'forbidden_pattern', message: reason, file: 'index.html' });
      }
    }
  });

  // Connection hints - own narrow host list (no content fetched)
  $('link[rel~="preconnect"], link[rel~="dns-prefetch"]').each((_i, el) => {
    const href = $(el).attr('href') ?? '';
    if (!href || isRelativePath(href)) return;
    if (!isAllowedHost(href, ALLOWED_PRECONNECT_HOSTS)) {
      violations.push({
        type: 'invalid_asset_url',
        message: `Connection hint references a non-allowlisted host: ${href}. Allowed: ${ALLOWED_PRECONNECT_HOSTS.join(', ')}`,
        file: 'index.html',
      });
    }
  });

  // Content-bearing asset references
  const assetSelectors = [
    'img[src]',
    'video[src]',
    'audio[src]',
    'source[src]',
    'link[href]:not([rel~="stylesheet"]):not([rel~="preconnect"]):not([rel~="dns-prefetch"])',
  ];
  for (const selector of assetSelectors) {
    $(selector).each((_i, el) => {
      const url = $(el).attr('src') ?? $(el).attr('href') ?? '';
      if (!url) return;
      if (url.startsWith('data:')) return;
      if (isRelativePath(url)) {
        if (!manifestPaths.has(url)) {
          violations.push({
            type: 'invalid_asset_url',
            message: `Asset reference points to missing bundle file: ${url}`,
            file: 'index.html',
          });
        }
        return;
      }
      if (!isAllowedHost(url, ALLOWED_ASSET_HOSTS)) {
        violations.push({
          type: 'invalid_asset_url',
          message: `Asset URL references a non-allowlisted host: ${url}. Allowed: ${ALLOWED_ASSET_HOSTS.join(', ')}`,
          file: 'index.html',
        });
      }
    });
  }

  return { valid: violations.length === 0, violations };
}

function isRelativePath(url: string): boolean {
  if (!url) return false;
  if (url.startsWith('#')) return false;
  if (url.startsWith('/')) return false; // absolute path — must pass allowlist
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return false; // has scheme
  return true;
}

/**
 * Strict host-equality against an allowlist. Compares `URL().host` exactly - no
 * substring containment - so suffix attacks (`fonts.googleapis.com.evil.tld`)
 * and userinfo tricks (`fonts.googleapis.com@evil.tld`) are rejected. Malformed
 * URLs return false.
 */
function isAllowedHost(url: string, hosts: readonly string[]): boolean {
  try {
    return hosts.includes(new URL(url).host);
  } catch {
    return false;
  }
}

function isAllowedStylesheetHref(href: string): boolean {
  if (ALLOWED_STYLESHEET_HREF.includes(href)) return true;
  return isAllowedHost(href, ALLOWED_STYLESHEET_HOSTS);
}

/** Exposed for tests + introspection - not used at runtime by validateBundle. */
export const __testing = {
  ALLOWED_SCRIPT_SRC,
  ALLOWED_STYLESHEET_HREF,
  ALLOWED_STYLESHEET_HOSTS,
  ALLOWED_ASSET_HOSTS,
  ALLOWED_PRECONNECT_HOSTS,
  FORBIDDEN_INLINE_PATTERNS,
};
