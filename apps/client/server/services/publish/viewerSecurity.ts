import * as cheerio from 'cheerio';
import { BLESSED_SCRIPT_PATHS, PUBLISH_HOST, PUBLISH_HOST_SUFFIX, USERCONTENT_HOST_SUFFIX } from './validateBundle';

/**
 * True if the request Host is an APP-WRAPPER host - the canonical app host (`PUBLISH_HOST`,
 * e.g. `app.example.com`) or an `*.app.<domain>` subdomain (matching infra/router.ts's
 * `*.app.${domain}` alias). Per-artifact isolated origins are EXCLUDED even though they are
 * nested under `.app.<domain>` (`*.usercontent.app.<domain>`): they are untrusted bundle
 * origins, not wrappers. Approach B's cross-origin embed is enabled ONLY from wrapper hosts:
 * every stage that PROVISIONS the `*.usercontent.app` alias serves the app here, whereas stages
 * that don't (e.g. shared-dev at `files.dev.<domain>`) must fall back to the same-origin srcdoc
 * rather than emit a cross-origin iframe to an unprovisioned host. Port-tolerant; false when
 * SERVER_DOMAIN unset.
 */
export function isAppWrapperHost(hostHeader?: string | string[]): boolean {
  const host = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader;
  if (!host || !PUBLISH_HOST) return false;
  const bare = host.split(':')[0].toLowerCase();
  if (bare === PUBLISH_HOST) return true;
  // Per-artifact isolated origins are nested UNDER the app host (`*.usercontent.app.<domain>`)
  // so they structurally end with `.app.<domain>` too. They are untrusted bundle origins,
  // NOT wrapper hosts - exclude them so a bundle host is never treated as a trusted wrapper
  // (which would let it emit the cross-origin embed / be granted wrapper-only handling).
  if (isUsercontentHost(bare)) return false;
  const rootDomain = PUBLISH_HOST.replace(/^app\./, ''); // SERVER_DOMAIN
  return bare.endsWith(`.app.${rootDomain}`);
}

/**
 * Per-artifact isolation host helpers (Approach B). A published bundle is served
 * from `{publicId}.usercontent.app.<SERVER_DOMAIN>` so each artifact is its own browser origin.
 * Empty suffix (SERVER_DOMAIN unset) -> Approach B disabled, callers fall back to srcdoc.
 */

/** The usercontent host for a publicId, e.g. `abc123.usercontent.app.example.com` (or '' if disabled). */
export function usercontentHostFor(publicId: string): string {
  return USERCONTENT_HOST_SUFFIX ? `${publicId}${USERCONTENT_HOST_SUFFIX}` : '';
}

/** True if the request Host is a per-artifact usercontent host (port-tolerant). */
export function isUsercontentHost(hostHeader?: string | string[]): boolean {
  const host = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader;
  if (!host || !USERCONTENT_HOST_SUFFIX) return false;
  const bare = host.split(':')[0].toLowerCase();
  return bare.endsWith(USERCONTENT_HOST_SUFFIX) && bare.length > USERCONTENT_HOST_SUFFIX.length;
}

/** Extract the publicId from a usercontent host, or '' if the host isn't one. */
export function publicIdFromUsercontentHost(hostHeader?: string | string[]): string {
  if (!isUsercontentHost(hostHeader)) return '';
  const host = Array.isArray(hostHeader) ? hostHeader[0] : (hostHeader as string);
  const bare = host.split(':')[0].toLowerCase();
  return bare.slice(0, bare.length - USERCONTENT_HOST_SUFFIX.length);
}

/**
 * Pure, serve-time security helpers for the public publish viewer
 * (`/api/publish/serve/[...path]`). Extracted from the route handler so the
 * load-bearing sanitization and CSP-construction logic can be unit-tested in isolation,
 * independent of Express req/res, MongoDB, and storage.
 *
 * Two pieces live here:
 *  - sanitizeRenderedHtml - strips executable / navigation-hijacking markup from
 *    marked-rendered reply HTML.
 *  - buildBundleScriptSrc / resolveDocOrigin - derive the bundle `script-src` allowlist
 *    from UNTRUSTED Host / X-Forwarded-Proto headers without letting a crafted header
 *    inject extra CSP directives.
 */

/**
 * Escape a string for safe interpolation into HTML text or a double-quoted attribute.
 * Shared by the viewer pages (wrapper, reply, loader shell) so title/URL interpolation
 * can't break out of its context.
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Sanitize marked-rendered reply HTML before injecting it into the viewer.
 * Defense-in-depth on top of the page's `script-src 'none'` CSP - strips executable /
 * navigation-hijacking markup (script, iframe/frame, object/embed, base, all meta - incl.
 * http-equiv refresh, link, form, style) plus event-handler attributes and javascript:/vbscript: URLs that
 * `marked` (which does not sanitize) would otherwise pass through. Uses cheerio (already a
 * server dep) rather than DOMPurify+jsdom to avoid bloating Lambda cold start.
 */
export function sanitizeRenderedHtml(html: string): string {
  const $ = cheerio.load(html, undefined, false);
  $('script, iframe, frame, object, embed, base, meta, link, form, noscript, template, style').remove();
  $('*').each((_, el) => {
    if (!('attribs' in el) || !el.attribs) return;
    for (const attr of Object.keys(el.attribs)) {
      const name = attr.toLowerCase();
      const value = el.attribs[attr] ?? '';
      if (name.startsWith('on')) {
        $(el).removeAttr(attr);
      } else if (name === 'href' || name === 'xlink:href' || name === 'action' || name === 'formaction') {
        // Navigational attrs: also strip data: (a data:text/html link is a navigation/XSS vector).
        if (/^\s*(javascript|vbscript|data):/i.test(value)) $(el).removeAttr(attr);
      } else if (name === 'src') {
        // src keeps data: so inline data-URI images/media still render (CSP allows img/media data:).
        if (/^\s*(javascript|vbscript):/i.test(value)) $(el).removeAttr(attr);
      }
    }
  });
  return $.html();
}

/**
 * Resolve the document origin (`proto://host`) from the request's Host and
 * X-Forwarded-Proto headers. Both are attacker-controlled, so:
 *  - Host must both match a strict `host[:port]` shape (prevents CSP directive injection)
 *    AND be allowlisted - the app host, a `*.example.com` subdomain (staging/preview), or
 *    localhost/loopback. The leading dot rejects suffix attacks (`evilexample.com`). A
 *    well-formed but non-allowlisted `Host: attacker.com` would otherwise mint a CSP that
 *    whitelists attacker.com for script/connect/img; anything not allowlisted falls
 *    back to the canonical PUBLISH_HOST.
 *  - X-Forwarded-Proto is restricted to http/https (first value only); anything else
 *    falls back to http for localhost/loopback and https everywhere else.
 */
export function resolveDocOrigin(hostHeader?: string, forwardedProtoHeader?: string | string[]): string {
  const rawHost = hostHeader ?? PUBLISH_HOST;
  const reqHost = isAllowedDocHost(rawHost) ? rawHost : PUBLISH_HOST;

  const fwdRaw = Array.isArray(forwardedProtoHeader) ? forwardedProtoHeader[0] : forwardedProtoHeader;
  const fwdProto = fwdRaw?.split(',')[0]?.trim().toLowerCase();
  // X-Forwarded-Proto wins (a TLS reverse proxy sets it to https). Otherwise
  // default to http for self-host and localhost/loopback - a self-host stack
  // serves plain http unless the operator terminates TLS upstream (in which case
  // the proxy sends X-Forwarded-Proto=https, handled above) - and https elsewhere.
  const reqProto =
    fwdProto === 'http' || fwdProto === 'https'
      ? fwdProto
      : process.env.B4M_SELF_HOST === 'true' || /^(localhost|127\.0\.0\.1)(:|$)/.test(reqHost)
        ? 'http'
        : 'https';

  return `${reqProto}://${reqHost}`;
}

/**
 * Allowlist gate for the request Host. Format-gates first (blocks quote / CSP-directive
 * injection), then pins to the app host (`PUBLISH_HOST`), any same-deployment subdomain
 * (`PUBLISH_HOST_SUFFIX`, e.g. `.example.com` for staging/preview), or localhost/loopback
 * - with an optional port. Both PUBLISH_HOST and the suffix derive from SERVER_DOMAIN with
 * no brand fallback; when unconfigured they are empty and the guards below
 * fail closed (admit only localhost). The leading dot in the suffix rejects suffix attacks
 * (`evilexample.com`).
 */
function isAllowedDocHost(host: string): boolean {
  if (!/^[a-zA-Z0-9.-]+(:\d+)?$/.test(host)) return false;
  // Self-host serves the app + viewer from an operator-chosen origin (localhost,
  // a LAN/tailnet host, or a reverse-proxied domain) that SERVER_DOMAIN doesn't
  // enumerate. The format gate above already blocks CSP-directive injection, so
  // admit any well-formed Host in self-host; the SERVER_DOMAIN allowlist below is
  // a hosted, multi-tenant concern, moot on a single-operator deployment.
  if (process.env.B4M_SELF_HOST === 'true') return true;
  const name = host.split(':')[0].toLowerCase();
  if (name === 'localhost' || name === '127.0.0.1') return true;
  if (PUBLISH_HOST && name === PUBLISH_HOST) return true;
  if (PUBLISH_HOST_SUFFIX && name.endsWith(PUBLISH_HOST_SUFFIX)) return true;
  return false;
}

/**
 * Build the bundle `script-src` value - the exact blessed libs only (drop the
 * blanket 'self', which would permit any same-origin script path). Emits both the form
 * resolved against the request's document origin (covers dev/preview hosts where libs
 * load same-origin) and the absolute app-host form, matching validateBundle's
 * ALLOWED_SCRIPT_SRC contract exactly. Deduplicated and space-joined for the CSP header.
 */
export function buildBundleScriptSrc(hostHeader?: string, forwardedProtoHeader?: string | string[]): string {
  const docOrigin = resolveDocOrigin(hostHeader, forwardedProtoHeader);
  const tokens = BLESSED_SCRIPT_PATHS.map(p => `${docOrigin}${p}`);
  // Canonical app-host form only when PUBLISH_HOST is configured; skipping it when
  // SERVER_DOMAIN is unset (self-host) avoids emitting a scheme-only
  // `https:///static/...` token. The doc-origin form above already covers
  // self-host, where blessed libs load same-origin from the app itself.
  if (PUBLISH_HOST) {
    tokens.push(...BLESSED_SCRIPT_PATHS.map(p => `https://${PUBLISH_HOST}${p}`));
  }
  return Array.from(new Set(tokens)).join(' ');
}
