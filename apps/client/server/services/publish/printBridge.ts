/**
 * Publish - "Save as PDF" bridge injected INTO the sandboxed bundle.
 *
 * Chrome's File > Print on the wrapper page prints the WRAPPER, and a cross-document
 * iframe paginates only the slice that is currently visible - so the viewer gets the
 * artifact's first screen and nothing else. The fix is to print the FRAME's own
 * document, from inside the frame, which preserves live interactive state (slider
 * positions, canvas/SVG charts, computed colors) rather than re-rendering a fresh copy.
 *
 * The parent cannot call `print()` on a cross-origin (or opaque-origin) frame, so the
 * trigger lives here and the wrapper asks for it over postMessage:
 *   parent -> iframe : { b4m: 'print' }
 * Message types must stay disjoint from the pin bridge's and fragmentNav's; all three
 * ignore what they do not recognize. The frame validates `event.source` always, and in
 * Approach B (a true cross-origin embed) also pins the parent origin from
 * `document.referrer` and checks `event.origin` against it - same pattern as the pin
 * bridge. In the same-origin srcdoc fallback the sandboxed doc has no referrer, so the
 * pin stays '*' and the source check carries the check on its own.
 *
 * `VIEWER_SANDBOX` must carry `allow-modals` or `window.print()` is a silent no-op here.
 * This script may never contain a literal `</script>`.
 */

/**
 * Print stylesheet shipped with the bridge. Two long-standing print failures in
 * hand-authored artifacts, both invisible on screen:
 *  - `body{height:100vh;overflow:auto}` (or a flex app shell) clips the printed output
 *    to a single page, because a scroll container does not paginate.
 *  - backgrounds and chart fills are dropped unless the viewer happens to tick Chrome's
 *    "Background graphics" box, which turns a dark-themed artifact into white-on-white.
 */
export const PRINT_BRIDGE_CSS =
  '@media print{html,body{height:auto!important;overflow:visible!important}' +
  '*{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important}}';

export const PRINT_BRIDGE_JS = String.raw`(function(){
  'use strict';
  var PO=(function(){try{return document.referrer?new URL(document.referrer).origin:'*';}catch(e){return '*';}})();
  function doPrint(){try{window.focus();window.print();}catch(e){}}
  window.addEventListener('message',function(e){
    if(e.source!==window.parent){return;}
    if(PO!=='*'&&e.origin!==PO){return;}
    var d=e.data||{};
    if(d.b4m==='print'){doPrint();}
  });
  document.addEventListener('keydown',function(e){
    if(!(e.metaKey||e.ctrlKey)||e.altKey||e.shiftKey){return;}
    if(e.key!=='p'&&e.key!=='P'){return;}
    e.preventDefault();
    doPrint();
  },true);
})();`;

/**
 * Print stylesheet + trigger, appended to every rendered bundle. Capture phase on the
 * keydown so the shortcut is claimed before author handlers: with focus inside the
 * frame the browser would otherwise print the wrapper, which is the clipped render this
 * whole bridge exists to avoid.
 */
export function buildPrintBridgeTag(): string {
  return `<style>${PRINT_BRIDGE_CSS}</style><script>${PRINT_BRIDGE_JS}</script>`;
}
