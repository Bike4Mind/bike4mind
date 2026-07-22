/**
 * GET /api/embed/serve (pretty path: /embed/chat?k=<embed key>)
 *
 * Serves the public embeddable chat widget page for a valid embed:chat key,
 * with a per-response CSP whose frame-ancestors is derived from the key's
 * allowedOrigins - the framing gate that lets exactly the allow-listed customer
 * sites iframe the widget (modeled on the publish/serve wrapper CSP).
 *
 * The key rides the query string because this is a top-level iframe navigation:
 * a browser cannot attach headers there. It is a publishable-class credential
 * already present verbatim in the customer's page source, but the URL still
 * gets Referrer-Policy: no-referrer and noindex so it never leaks further.
 * Accepted residual: CDN/origin access logs capture the full URL, so log read
 * access yields a working (revocable) key - scrub `k` from logged URLs if that
 * ever tightens.
 *
 * The key is re-verified live on every request (verifyEmbedApiKey), so
 * revocation and allowedOrigins edits take effect immediately - which is also
 * why the response must never be cached (a cached frame-ancestors would outlive
 * a revocation).
 *
 * No embedCors here: a navigation is not a CORS fetch, and echoing Origin into
 * response headers on a cacheable-looking page is a needless poisoning surface.
 */

import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { verifyEmbedApiKey } from '@server/cli/auth';
import { agentRepository } from '@bike4mind/database';
import { parseBrandingColor, parseBrandingLogoUrl, parseEmbedOrigin } from '@bike4mind/common';
import { renderEmbedWidgetHtml } from '@server/embed/embedWidgetPage';
import { embedKeyOwnerHasEntitlement } from '@server/entitlements/embedKeyEntitlement';
import { EMBED_WHITELABEL_ENTITLEMENT_KEY } from '@client/lib/entitlements/registry';

/** Structural response shape shared by the Express/Next response baseApi hands us. */
interface HtmlResponse {
  setHeader(name: string, value: string): unknown;
  status(code: number): { send(body: string): unknown };
}

/** Per-IP flood backstop: every request costs a key lookup on an unauth surface. */
const SERVE_RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;

/** Directives beyond frame-ancestors are pinned tight: the page is fully
 *  server-generated (inline script/style only, same-origin fetches, no forms).
 *  img-src widens to exactly one extra origin - the key's validated https logo -
 *  and only when such a logo exists; everything else stays byte-identical. */
function buildEmbedWidgetCsp(origins: string[], logoOrigin: string | null): string {
  return [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    "connect-src 'self'",
    logoOrigin ? `img-src data: ${logoOrigin}` : 'img-src data:',
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors 'self' ${origins.join(' ')}`,
  ].join('; ');
}

/** Uniform error page: fail closed (nothing may frame it), never reflect input. */
function sendErrorPage(res: HtmlResponse, status: number, message: string): void {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res
    .status(status)
    .send(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Unavailable</title></head><body><p>${message}</p></body></html>`
    );
}

const handler = baseApi({ auth: false })
  .use(rateLimit({ limit: SERVE_RATE_LIMIT, windowMs: RATE_WINDOW_MS, bucket: 'embed-serve' }))
  .get(async (req, res) => {
    const k = req.query.k;
    // Array-valued k (?k=a&k=b) is param smuggling, not a usable key.
    if (typeof k !== 'string' || k.length === 0) {
      return sendErrorPage(res, 400, 'Missing embed key.');
    }

    let info;
    try {
      info = await verifyEmbedApiKey({ 'x-api-key': k });
    } catch {
      // Uniform 404 for every verification failure (unknown, revoked, wrong
      // scope, non-org): no branch may confirm that a probed key exists.
      return sendErrorPage(res, 404, 'Not found.');
    }

    // Guard the header-interpolation boundary: stored origins are write-time
    // validated, but these strings go INTO a CSP header, so re-screen at the one
    // site where a malformed value would become header text rather than merely
    // failing a membership check.
    const origins = (info.allowedOrigins ?? []).filter(o => parseEmbedOrigin(o) === o);
    if (origins.length === 0) {
      // Only reachable with a valid key in hand, so this is a config signal for
      // the key owner, not an enumeration oracle. No grants -> nothing may frame.
      return sendErrorPage(res, 403, 'No embed origins are configured for this key.');
    }

    // Cosmetic only - the chat route re-hydrates the agent itself; a missing
    // name (or a failed lookup) just falls back to the page's default header.
    const agent = info.agentId ? await agentRepository.findById(info.agentId).catch(() => null) : null;

    // Effective branding is decided HERE and only the outcome reaches the page:
    // the raw hideBranding flag never crosses to the client. Stored values are
    // re-sanitized (they may predate write validation), and the entitlement is
    // resolved live against the key's billing owner, failing closed to "branding
    // shows" on any lookup error - so an expired plan un-hides on the next load.
    const branding = info.branding ?? {};
    const entitled = await embedKeyOwnerHasEntitlement(info, EMBED_WHITELABEL_ENTITLEMENT_KEY).catch(() => false);
    const showBranding = !(entitled && branding.hideBranding === true);
    const displayName =
      (typeof branding.displayName === 'string' && branding.displayName.trim()) || agent?.name || undefined;
    const primaryColor = parseBrandingColor(branding.primaryColor) ?? undefined;
    const logoUrl = parseBrandingLogoUrl(branding.logoUrl) ?? undefined;
    // Derived from the SAME sanitized URL the page receives, so the CSP grant
    // and the rendered img.src cannot disagree.
    const logoOrigin = logoUrl ? new URL(logoUrl).origin : null;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Security-Policy', buildEmbedWidgetCsp(origins, logoOrigin));
    res.setHeader('Cache-Control', 'private, no-store, must-revalidate');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // The URL carries the key; never leak it via Referer or index it.
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    return res.status(200).send(
      renderEmbedWidgetHtml({
        embedKey: k,
        agentId: info.agentId,
        displayName,
        primaryColor,
        logoUrl,
        poweredByLabel: showBranding && process.env.APP_NAME ? `Powered by ${process.env.APP_NAME}` : undefined,
      })
    );
  });

export const config = { api: { externalResolver: true } };
export default handler;
