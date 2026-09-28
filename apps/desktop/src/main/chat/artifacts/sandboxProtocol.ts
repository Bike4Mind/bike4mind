import { protocol } from 'electron';

export const ARTIFACT_SCHEME = 'b4m-artifact';

/** What the renderer points the frame at. A host is required: the scheme is `standard`. */
export const ARTIFACT_SANDBOX_URL = `${ARTIFACT_SCHEME}://sandbox/`;

/**
 * The document an HTML artifact is rendered inside.
 *
 * Ported from the server's `/api/artifact-sandbox` (apps/client/pages/api/artifact-sandbox.ts),
 * which the renderer cannot use directly: that route lives on the backend origin, and the
 * renderer's CSP is `default-src 'self'` - framing a remote origin would mean admitting the
 * configurable environment URL into `frame-src`, which is the one thing this client's policy
 * has never done. Serving the same document from this app's own scheme keeps the frame local
 * and leaves `frame-src b4m-artifact:` as a closed addition to that policy.
 *
 * The content arrives by postMessage, not in the URL and not in the document: the frame runs
 * with an opaque origin (`sandbox="allow-scripts"`, no `allow-same-origin`), so the parent must
 * post with targetOrigin '*', and no other window can hold a reference to this frame - which is
 * what makes `event.source === window.parent` sufficient provenance. `document.write` is
 * deliberate, as upstream: it swaps in a whole document with its own <head>, which innerHTML
 * cannot do.
 */
const SANDBOX_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>html,body{margin:0;padding:0;width:100%;height:100%;background:#fff}</style>
</head>
<body>
<script>
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

/**
 * The frame's own policy, and the second half of its isolation.
 *
 * Stricter than the server route this is ported from, which admits a set of public CDN hosts
 * for script and style. Nothing remote is allowed here at all: the desktop prompt already tells
 * the model an artifact has no network, and a client whose renderer admits no remote origin
 * should not open one inside a frame showing model-written code. `connect-src 'none'` is what
 * stops an artifact exfiltrating whatever it was given; `frame-src 'none'` stops it nesting
 * another document to get a less restricted one.
 *
 * This is a header rather than a meta tag on purpose: a policy the artifact's own markup could
 * contain would be a policy the artifact could choose.
 */
const SANDBOX_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "script-src 'unsafe-inline'",
  'img-src data: blob:',
  'media-src data: blob:',
  'font-src data:',
  "connect-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
].join('; ');

/**
 * Declare the scheme before the app is ready, which is the only point it can still be done.
 *
 * `standard` gives it an origin so the frame is a normal document rather than an opaque
 * one-off, and `secure` keeps it from counting as mixed content. Deliberately NOT `bypassCSP`,
 * and deliberately without `supportFetchAPI`: nothing inside the frame is allowed to make a
 * request, and the CSP above says so too.
 */
export function registerArtifactScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: ARTIFACT_SCHEME, privileges: { standard: true, secure: true } }]);
}

/**
 * Serve the sandbox document. Must run after the app is ready.
 *
 * One static document for every artifact, and it carries no artifact content - so there is
 * nothing here to get a path or an id wrong about, and any URL under the scheme answers with
 * the same inert shell.
 */
export function registerArtifactProtocol(): void {
  protocol.handle(ARTIFACT_SCHEME, async () => {
    return new Response(SANDBOX_HTML, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': SANDBOX_CSP,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  });
}
