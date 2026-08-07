/**
 * "Save as PDF" for published artifacts (issue #1142, item 2) via the browser's
 * own print dialog - the "cheapest" of the rendering approaches: no server-side
 * headless renderer, no new infra.
 *
 * The one constraint that shapes this file: author HTML must never execute in the
 * app origin. The rest of the export pipeline serves it sandboxed or as an
 * attachment for exactly that reason. So we do NOT `window.open` the content (a
 * blob/document URL would inherit the app origin). Instead we mount it in an
 * off-screen iframe sandboxed WITHOUT `allow-same-origin`, giving it an opaque
 * origin that cannot read app cookies, storage, or DOM. `allow-scripts` lets a
 * bundle (React/HTML) actually render, and `allow-modals` lets the injected
 * trigger open the print dialog. Because the parent cannot reach into a
 * cross-origin frame's `print()`, the trigger lives inside the frame and reports
 * back over `postMessage` so we can reclaim the node.
 *
 * Owner-path only. The public viewer footers stay CSP-locked (see publishExport.ts).
 */

const COMPLETE = 'b4m-print-complete';

// Runs inside the sandboxed frame: print once painted, then ping the parent so it
// can remove the frame (afterprint is unreliable in some browsers, hence the
// post-print fallback ping).
const PRINT_BOOTSTRAP =
  '<script>(function(){' +
  'function done(){try{parent.postMessage("' +
  COMPLETE +
  '","*");}catch(e){}}' +
  'window.addEventListener("afterprint",done);' +
  'window.addEventListener("load",function(){' +
  'setTimeout(function(){try{window.focus();window.print();}catch(e){}setTimeout(done,500);},400);' +
  '});' +
  '})();</script>';

/**
 * Inject the print trigger into an HTML export. An author `Content-Security-Policy`
 * meta would only block the inline trigger without adding any protection here (the
 * opaque-origin sandbox is the real boundary), so it is dropped.
 */
export function buildPrintDocument(html: string): string {
  const withoutCsp = html.replace(/<meta\b[^>]*http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi, '');
  return /<\/body\s*>/i.test(withoutCsp)
    ? withoutCsp.replace(/<\/body\s*>/i, `${PRINT_BOOTSTRAP}</body>`)
    : withoutCsp + PRINT_BOOTSTRAP;
}

/**
 * Render a self-contained HTML export in an isolated frame and open the print
 * dialog, where the user picks "Save as PDF". Fire-and-forget: the frame removes
 * itself once printing finishes (or after a backstop timeout if the dialog is
 * dismissed without an afterprint event).
 */
export function printHtmlForPdf(html: string): void {
  if (typeof document === 'undefined') return;

  const iframe = document.createElement('iframe');
  iframe.setAttribute('sandbox', 'allow-scripts allow-modals');
  iframe.setAttribute('aria-hidden', 'true');
  // Off-screen but sized so the content lays out and paints (a 0x0 or display:none
  // frame prints blank). Letter-ish dimensions in px.
  iframe.style.cssText = 'position:fixed;left:-10000px;top:0;width:816px;height:1056px;border:0';
  iframe.srcdoc = buildPrintDocument(html);

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    window.removeEventListener('message', onMessage);
    window.clearTimeout(fallback);
    iframe.remove();
  };
  const onMessage = (e: MessageEvent) => {
    if (e.source === iframe.contentWindow && e.data === COMPLETE) cleanup();
  };
  window.addEventListener('message', onMessage);
  // Backstop for a dialog dismissed without firing afterprint.
  const fallback = window.setTimeout(cleanup, 120000);

  document.body.appendChild(iframe);
}
