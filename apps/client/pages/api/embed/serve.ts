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
import { parseEmbedOrigin } from '@bike4mind/common';
import { renderEmbedWidgetHtml } from '@server/embed/embedWidgetPage';

/** Structural response shape shared by the Express/Next response baseApi hands us. */
interface HtmlResponse {
  setHeader(name: string, value: string): unknown;
  status(code: number): { send(body: string): unknown };
}

/** Per-IP flood backstop: every request costs a key lookup on an unauth surface. */
const SERVE_RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;

/** Directives beyond frame-ancestors are pinned tight: the page is fully
 *  server-generated (inline script/style only, same-origin fetches, no forms). */
function buildEmbedWidgetCsp(origins: string[]): string {
  return [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    "connect-src 'self'",
    'img-src data:',
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

    // Read-time re-screen: only canonical pre-validated origins may enter the
    // CSP header. Fails closed on any legacy/corrupt row that predates
    // validateEmbedKeyOrigins.
    const origins = (info.allowedOrigins ?? []).filter(o => parseEmbedOrigin(o) === o);
    if (origins.length === 0) {
      // Only reachable with a valid key in hand, so this is a config signal for
      // the key owner, not an enumeration oracle. No grants -> nothing may frame.
      return sendErrorPage(res, 403, 'No embed origins are configured for this key.');
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Security-Policy', buildEmbedWidgetCsp(origins));
    res.setHeader('Cache-Control', 'private, no-store, must-revalidate');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // The URL carries the key; never leak it via Referer or index it.
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    return res.status(200).send(
      renderEmbedWidgetHtml({
        embedKey: k,
        agentId: info.agentId,
        keyId: info.keyId,
      })
    );
  });

export const config = { api: { externalResolver: true } };
export default handler;
