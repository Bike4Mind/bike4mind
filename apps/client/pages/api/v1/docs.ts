import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * GET /api/v1/docs - interactive API reference (Scalar) for the OpenAPI spec.
 *
 * Why an API route, not a public/ HTML file: files under apps/client/public/
 * are served straight from S3/CloudFront in SST/OpenNext and never reach the
 * Lambda, so the global proxy.ts middleware cannot attach a CSP to them.
 * Routing through /api/* forces this handler to run and set its own CSP - same
 * approach as artifact-sandbox.ts.
 *
 * The Scalar renderer is VENDORED (apps/client/public/scalar/scalar.standalone.js,
 * pinned; see that dir's README) and loaded same-origin, so the page has no
 * third-party script host and the CSP stays script-src 'self'. Two config flags
 * keep it self-contained: withDefaultFonts:false (no fonts.scalar.com) and
 * agent.disabled (Scalar's Agent otherwise calls api.scalar.com at load). With
 * both off the page makes zero cross-origin requests - it only fetches the spec
 * from same-origin /api/v1/openapi.json (connect-src 'self').
 *
 * Under this exact CSP the reference renders correctly (verified headless, i.e.
 * with no service worker). Scalar attempts one eval-based feature-detection that
 * script-src 'self' blocks harmlessly (caught, no console error, rendering
 * unaffected); we keep the CSP tight rather than add 'unsafe-eval' just for it.
 *
 * Known cosmetic quirk in a real browser: the app's PWA service worker (Serwist,
 * app/sw.ts) routes /api/* through NetworkOnly, and a Scalar-initiated fetch to
 * an /api/* deep-link can surface a benign `no-response` console error. The page
 * still renders and works; fixing the SW interaction is tracked separately (it
 * is app-wide infra, out of scope for this route).
 */

const VENDORED_SCALAR_SRC = '/scalar/scalar.standalone.js';
const SPEC_URL = '/api/v1/openapi.json';

// Keeps the page self-contained (see the header comment): no hosted fonts, no
// Agent calls to api.scalar.com.
const SCALAR_CONFIG = { withDefaultFonts: false, agent: { disabled: true } };

// Scoped to this route (global CSP does not apply to /api/*). script-src stays
// 'self' (only the same-origin vendored bundle loads; no 'unsafe-eval' - the one
// Scalar eval path is blocked harmlessly). style-src needs 'unsafe-inline' for
// the styles Scalar injects at runtime (a nonce cannot authorize style attrs).
const DOCS_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
  "form-action 'none'",
].join('; ');

const DOCS_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Bike4Mind API Reference</title>
  <style>body{margin:0}</style>
</head>
<body>
  <script id="api-reference" data-url="${SPEC_URL}" data-configuration='${JSON.stringify(SCALAR_CONFIG)}'></script>
  <script src="${VENDORED_SCALAR_SRC}"></script>
</body>
</html>`;

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return res.status(405).end('Method Not Allowed');
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Security-Policy', DOCS_CSP);
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300');

  return res.status(200).send(req.method === 'HEAD' ? '' : DOCS_HTML);
}
