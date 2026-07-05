import type { NextApiRequest, NextApiResponse } from 'next';
import { buildBundleScriptSrc } from '@server/services/publish/viewerSecurity';

/**
 * GET /api/artifact-sandbox - HTML iframe target for client-rendered artifacts.
 *
 * Why this is an API route, not a `public/` file:
 *   Files under `apps/client/public/` are uploaded to S3 and served directly
 *   by the CloudFront S3 origin in SST/OpenNext deployments. They never reach
 *   the Next.js Lambda, so the global `proxy.ts` middleware cannot attach
 *   per-response headers (CSP, X-Frame-Options, X-XSS-Protection). Routing
 *   through `/api/*` forces the request through the Lambda and lets this
 *   handler set its own CSP - same approach as `/p/* -> /api/publish/serve/*`.
 *
 * The CSP here is intentionally scoped to this route. `style-src https:`
 * allows HTML artifacts to load CDN stylesheets (Tailwind, Bootstrap, etc.)
 * without widening the global app policy. `connect-src 'none'` blocks
 * outbound network calls from inside the sandbox, so artifact content
 * cannot exfiltrate. `frame-src 'none'` prevents nested iframes.
 *
 * Body is delivered to the sandbox via postMessage from the parent - the
 * parent sends `{ type: 'artifact-html', content }` after receiving the
 * `artifact-sandbox-ready` signal. Using `document.write` is intentional:
 * it lets the sandbox swap in a full HTML document (with its own <head>,
 * <link rel="stylesheet">, etc.) after load, which `innerHTML` cannot do.
 */

// CDN script hosts allowed for HTML artifacts that pull a library off a public CDN.
const SANDBOX_CDN_SCRIPT_HOSTS =
  'https://cdn.jsdelivr.net https://unpkg.com https://cdn.tailwindcss.com https://cdnjs.cloudflare.com https://esm.sh';

/**
 * Per-request CSP. `script-src` additionally pins the blessed app-host libraries
 * (e.g. /static/lib/chart.js@4.x.js) via the SAME exact-path allowlist the publish
 * viewer uses (buildBundleScriptSrc), so a self-hosted blessed lib absolutized to
 * the app origin (HtmlArtifactViewer) can load while arbitrary same-origin script
 * paths stay blocked. Host is derived from the (untrusted) Host header but
 * format-gated + allowlisted inside buildBundleScriptSrc.
 */
function buildArtifactSandboxCsp(req: NextApiRequest): string {
  const headers = req.headers ?? {};
  const blessedScriptSrc = buildBundleScriptSrc(headers.host, headers['x-forwarded-proto']);
  return [
    "default-src 'none'",
    "style-src 'unsafe-inline' https:",
    `script-src 'unsafe-inline' ${SANDBOX_CDN_SCRIPT_HOSTS} ${blessedScriptSrc}`.trim(),
    'img-src data: blob: https:',
    'font-src data: https://fonts.gstatic.com https://fonts.googleapis.com https://fonts.bunny.net',
    "connect-src 'none'",
    'media-src blob: data: https:',
    "object-src 'none'",
    "frame-src 'none'",
    "frame-ancestors 'self'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

const SANDBOX_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>html,body{margin:0;padding:0;width:100%;height:100%}</style>
</head>
<body>
<script>
  // event.origin is intentionally not checked: this iframe runs with an
  // opaque origin (sandbox="allow-scripts", no allow-same-origin), so the
  // parent must postMessage with targetOrigin '*' — no other window can
  // hold a Window reference to this sandbox, so event.source === window.parent
  // is sufficient provenance. A named handler with explicit removeEventListener
  // (not { once: true }) so unrelated postMessages from browser extensions or
  // dev tooling cannot silently consume the listener before the parent posts.
  window.parent.postMessage({ type: 'artifact-sandbox-ready' }, '*');
  function handleArtifactMessage(event) {
    if (event.source !== window.parent) return;
    if (!event.data || event.data.type !== 'artifact-html') return;
    window.removeEventListener('message', handleArtifactMessage);
    document.open();
    document.write(event.data.content);
    document.close();
  }
  window.addEventListener('message', handleArtifactMessage);
</script>
</body>
</html>`;

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return res.status(405).end('Method Not Allowed');
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Security-Policy', buildArtifactSandboxCsp(req));
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  // Static document body - safe to cache aggressively, the parent supplies
  // artifact content via postMessage after load. Trade-off: a CSP tightening
  // takes up to 5 minutes to propagate through CDN/browser caches. The CSP
  // varies by Host, but buildBundleScriptSrc always emits the canonical
  // `https://${PUBLISH_HOST}` blessed token (alongside the per-request origin),
  // so a cached response still authorizes the blessed lib on the canonical app
  // host that in-app viewers actually run on.
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300');

  return res.status(200).send(req.method === 'HEAD' ? '' : SANDBOX_HTML);
}
