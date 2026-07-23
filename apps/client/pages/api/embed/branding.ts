/**
 * GET /api/embed/branding?k=<embed key>
 *
 * Public branding bootstrap for the embeddable-chat LAUNCHER. The loader
 * (pages/api/embed/widget.ts) runs on the customer's page with only the embed
 * key, so it fetches this at mount to theme the floating launch button before
 * the iframe ever opens. Returns ONLY the public-safe cosmetic fields
 * (primaryColor, displayName), sanitized with the same @bike4mind/common
 * helpers the widget page uses - so the launcher and the iframe theme identically.
 *
 * The key rides the query string (like serve.ts) so this is a simple cross-origin
 * GET: no preflight, cacheable response. It is a publishable-class credential
 * already present verbatim in the customer's page source, so the query-string
 * carry is the same accepted access-log residual serve.ts documents.
 *
 * Caching: unlike serve.ts (whose no-store is a security requirement - a cached
 * frame-ancestors CSP would outlive a revocation) branding is cosmetic, so a
 * short public max-age is fine and deliberate: it bounds the key verification
 * (a bcrypt compare + a lastUsed write) this endpoint would otherwise run on
 * every visitor's page view. A branding edit takes effect within one TTL.
 *
 * embedCors() only sets Access-Control-Allow-Origin so the cross-origin loader
 * can read the JSON; the key itself is the gate. Any verification failure
 * returns a uniform 404 - no branch may confirm that a probed key exists.
 */

import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { embedCors } from '@server/middlewares/embedCors';
import { verifyEmbedApiKey } from '@server/cli/auth';
import { parseBrandingColor, parseBrandingDisplayName } from '@bike4mind/common';

/** Per-IP flood backstop: every cache-miss costs a key lookup on an unauth surface. */
const BRANDING_RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;
/** Cosmetic data: cache briefly so key verification does not run on every page view. */
const BRANDING_MAX_AGE_S = 300;

/** Structural response shape baseApi hands us (status().json()). */
interface JsonResponse {
  setHeader(name: string, value: string): unknown;
  status(code: number): { json(body: unknown): unknown };
}

/** Public-safe launcher branding: cosmetic fields only, each present only when it sanitizes. */
interface LauncherBranding {
  primaryColor?: string;
  displayName?: string;
}

/** Errors are never cached and carry no key-existence signal. */
function sendError(res: JsonResponse, status: number, error: string): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.status(status).json({ error });
}

const handler = baseApi({ auth: false })
  .use(embedCors())
  .use(rateLimit({ limit: BRANDING_RATE_LIMIT, windowMs: RATE_WINDOW_MS, bucket: 'embed-branding' }))
  .get(async (req, res) => {
    const k = req.query.k;
    // Array-valued k (?k=a&k=b) is param smuggling, not a usable key.
    if (typeof k !== 'string' || k.length === 0) {
      return sendError(res, 400, 'missing_key');
    }

    let info;
    try {
      info = await verifyEmbedApiKey({ 'x-api-key': k });
    } catch {
      // Uniform 404 for every verification failure (unknown, revoked, wrong
      // scope, non-org): no branch may confirm that a probed key exists.
      return sendError(res, 404, 'not_found');
    }

    // Build a fresh object with only the public-safe cosmetic fields; never
    // spread info.branding, so logoUrl/agentId/organizationId/hideBranding stay
    // server-side. Each field is included only when its sanitizer accepts it.
    const branding = info.branding ?? {};
    const out: LauncherBranding = {};
    const color = parseBrandingColor(branding.primaryColor);
    if (color !== null) out.primaryColor = color;
    const displayName = parseBrandingDisplayName(branding.displayName);
    if (displayName !== null) out.displayName = displayName;

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', `public, max-age=${BRANDING_MAX_AGE_S}`);
    return res.status(200).json(out);
  });

export const config = { api: { externalResolver: true } };
export default handler;
