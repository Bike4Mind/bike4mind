import { SHARE_FOOTER_HELD_ID } from '@client/app/utils/shareFooter';

/**
 * Publish - sign-up gate bridge injected INTO the sandboxed bundle.
 *
 * The serve route can only recognize a signed-in viewer from an Authorization header, which a
 * top-level navigation never carries, and an open-public page is shared-cached anyway - so a
 * signed-in viewer is served the same gated render as an anonymous prospect. The wrapper
 * widget (pages/api/publish/widget.ts), on the app origin, can tell the viewer has a session
 * and asks the frame to drop the gate:
 *   parent -> iframe : { b4m: 'member' }
 *   iframe -> parent : { b4m: 'gate-ready' }  (so a message sent before this loaded is re-sent)
 * On 'member' the gate is dismissed through its own checkbox and the brand footer card held by
 * holdShareFooterCtaBeforeGate is revealed - the same page a Bearer-authenticated render gets.
 *
 * Injected only when the gate is shown; the gate itself stays script-free and works without
 * this. Message types must stay disjoint from the pin, print and fragment bridges'. Same
 * source/origin validation as printBridge.ts. May never contain a literal `</script>`.
 */
export const SIGNUP_GATE_BRIDGE_JS = String.raw`(function(){
  'use strict';
  var PO=(function(){try{return document.referrer?new URL(document.referrer).origin:'*';}catch(e){return '*';}})();
  function member(){
    var box=document.getElementById('b4m-gate-dismiss');if(box){box.checked=true;}
    var panel=document.getElementById('b4m-gate-panel');if(panel){panel.style.display='none';}
    var held=document.getElementById('${SHARE_FOOTER_HELD_ID}');if(held){held.style.display='';}
  }
  window.addEventListener('message',function(e){
    if(e.source!==window.parent){return;}
    if(PO!=='*'&&e.origin!==PO){return;}
    var d=e.data||{};
    if(d.b4m==='member'){member();}
  });
  try{parent.postMessage({b4m:'gate-ready'},PO);}catch(e){}
})();`;

/** Append the bridge at the end of the bundle body (before </body> if present, else appended). */
export function injectSignupGateBridge(srcdoc: string): string {
  const tag = `<script>${SIGNUP_GATE_BRIDGE_JS}</script>`;
  return /<\/body>/i.test(srcdoc) ? srcdoc.replace(/<\/body>/i, `${tag}</body>`) : srcdoc + tag;
}
