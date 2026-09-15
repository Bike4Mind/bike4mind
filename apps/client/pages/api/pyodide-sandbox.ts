import type { NextApiRequest, NextApiResponse } from 'next';
import { pyodideSandboxWorkerBody } from '@client/app/workers/pyodide/sandboxWorkerBody';
import { pyodideCspSources } from '@client/app/utils/pyodideDistribution';

/**
 * GET /api/pyodide-sandbox - iframe target that executes PYTHON artifacts.
 *
 * Sibling of /api/react-artifact-sandbox and /api/artifact-sandbox, and here for the same
 * reason those exist: artifact code is authored by a model or a collaborator, so it must not
 * run on the app origin.
 *
 * Python was the artifact type that never got this treatment. It ran in a Worker created from
 * the app origin, and a Worker inherits its creator's origin - so Pyodide's always-present `js`
 * module gave guest Python a same-origin, same-site `fetch`. The session refresh cookie is
 * `HttpOnly` but host-only and `SameSite=Strict`, which is exactly the shape that rides along
 * on such a request: `js.fetch('/api/auth/refreshToken', {method:'POST'})` from inside a
 * Python artifact could mint the viewer's session.
 *
 * The parent frames this route with `sandbox="allow-scripts"` and NO `allow-same-origin`, so
 * this document gets an OPAQUE origin. That closes the hole twice over: `SameSite=Strict` is
 * not sent from an opaque initiator, and no app-origin response is readable without CORS
 * headers the app never sets. The CSP below is the belt to that pair of braces - `connect-src`
 * names the Pyodide distribution and nothing else, so even a request that could be made has
 * nowhere to go.
 *
 * Routing through `/api/*` is what makes the CSP authoritative: `proxy.ts` deliberately skips
 * the global app CSP for `/api/*`, and a `public/` file would be served by CloudFront and never
 * reach the Lambda at all.
 *
 * The Worker lives INSIDE this frame rather than Pyodide running on the frame's own thread.
 * `interrupt()` has always been "terminate the worker", which is what stops an infinite loop.
 * Running on the frame thread would make termination mean `iframe.remove()` from the parent,
 * which only lands if the frame is out-of-process - true in Chrome and Firefox, not in Safari.
 * Keeping the Worker keeps a runaway `while True:` killable everywhere.
 *
 * Protocol: this shell posts `pyodide-sandbox-ready` on load, then relays `PyodideWorkerMessage`
 * from the parent into the Worker and `PyodideWorkerResponse` back out, verbatim.
 */

const SANDBOX_READY = 'pyodide-sandbox-ready';

function buildSandboxCsp(): string {
  const pyodideSources = pyodideCspSources(process.env.PYODIDE_BASE_URL).join(' ');

  return [
    "default-src 'none'",
    // The shell script is inline; the Worker is a blob; the Worker importScripts() pyodide.js
    // from the distribution. A blob Worker inherits THIS policy, so the distribution has to be
    // named here as well as in connect-src.
    //
    // 'wasm-unsafe-eval' is load-bearing, not a nicety: CSP3 gates WebAssembly compilation on
    // script-src, and Pyodide IS WebAssembly. Without it loadPyodide() dies on
    // WebAssembly.instantiateStreaming with a CompileError and Python never starts.
    // Note what is deliberately NOT granted: 'unsafe-eval'. The narrow token permits wasm and
    // still refuses string-to-JS eval, so guest Python cannot reach js.eval().
    `script-src 'unsafe-inline' blob: 'wasm-unsafe-eval' ${pyodideSources}`,
    // The only network reach guest Python has. Pyodide fetches its own wasm and wheels here;
    // there is deliberately no 'self', so the app origin is unreachable from inside.
    `connect-src ${pyodideSources}`,
    'worker-src blob:',
    "style-src 'none'",
    "img-src 'none'",
    "font-src 'none'",
    "media-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    'child-src blob:',
    // Only the app may frame this. Without it, any site could host the sandbox and drive it.
    "frame-ancestors 'self'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

/**
 * Serialize the worker for a blob URL.
 *
 * The escape is not decoration. This string is emitted inside an inline `<script>`, and the
 * HTML tokenizer stays in script-data state until the FIRST closing script tag it sees - so a
 * closing tag appearing anywhere in the worker source, even inside a Python string, would
 * truncate the script and dump the remainder into the document as text. Rewriting it to the
 * `<\/script` form is inert to the tokenizer and collapses back to the original inside the JS
 * string literal. Pinned by pyodide-sandbox.test.ts.
 */
function buildWorkerSource(): string {
  const source = `(${pyodideSandboxWorkerBody.toString()})();`;
  return JSON.stringify(source).replace(/<\/script/gi, '<\\/script');
}

function buildSandboxHtml(): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Python Artifact Sandbox</title></head>
<body>
<script>
(function () {
  var workerSource = ${buildWorkerSource()};
  var worker = null;

  function toParent(message) {
    window.parent.postMessage(message, '*');
  }

  function startWorker() {
    worker = new Worker(URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' })));
    worker.onmessage = function (event) { toParent(event.data); };
    worker.onerror = function (event) {
      toParent({ type: 'error', error: (event && event.message) || 'Python sandbox worker failed' });
    };
  }

  try {
    startWorker();
  } catch (error) {
    toParent({ type: 'error', error: 'Could not start the Python sandbox: ' + String(error && error.message) });
    return;
  }

  window.addEventListener('message', function (event) {
    // Opaque origin: targetOrigin cannot be checked, so provenance is the source window.
    // Only the framing parent can drive this sandbox.
    if (event.source !== window.parent) return;
    if (!event.data || typeof event.data !== 'object') return;
    if (!worker) return;

    // 'cancel' is advisory - the worker only observes it between steps. A wedged run is
    // stopped by the parent dropping this whole frame, which takes the Worker with it.
    worker.postMessage(event.data);
  });

  toParent({ type: '${SANDBOX_READY}' });
})();
</script>
</body>
</html>`;
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return res.status(405).end('Method Not Allowed');
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Security-Policy', buildSandboxCsp());
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  // Static shell - the parent drives it by postMessage after load. Matches the sibling
  // artifact-sandbox routes, including their caveat: a CSP change here takes up to 5 minutes
  // to propagate through CDN/browser caches.
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300');

  return res.status(200).send(req.method === 'HEAD' ? '' : buildSandboxHtml());
}
