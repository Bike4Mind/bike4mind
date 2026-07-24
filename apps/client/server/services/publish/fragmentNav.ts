/**
 * Publish - same-page fragment navigation for sandboxed bundles.
 *
 * A bundle document inside the sandboxed viewer iframe cannot fragment-navigate
 * natively: a srcdoc document's URL is `about:srcdoc` (its base URL is inherited
 * from the wrapper), and a directly-served bundle carries an injected trailing-slash
 * `<base>` for asset resolution - either way `#tldr` (or an absolute link to the
 * artifact's own URL plus a fragment) resolves to a URL that differs from the
 * document URL, so a click triggers a full CROSS-DOCUMENT iframe navigation instead
 * of an in-page scroll. Worse, that navigation is issued from the sandbox's opaque
 * origin, which strips SameSite cookies: a passphrase-gated artifact re-serves its
 * prompt shell INTO the sandboxed frame, where the form cannot submit (the sandbox
 * has no `allow-forms` and suppresses the submit event entirely) and fetch would be
 * uncredentialed - a dead end the viewer can only escape by reloading.
 *
 * Two cooperating scripts restore in-page semantics:
 *   - FRAGMENT_NAV: injected INTO the sandboxed bundle (renderSandboxedBundle). It
 *     intercepts clicks on links that identify THIS page (raw `#...` hrefs, or
 *     absolute URLs whose origin+path match the bundle's own), scrolls to the
 *     fragment target, and notifies the parent so the address bar can follow:
 *       iframe -> parent : { b4m: 'fragment', hash: '#...' | '' }
 *     It also accepts the page hash from the parent (initial deep link + hashchange):
 *       parent -> iframe : { b4m: 'hash', hash: '#...' }
 *   - HASH_BRIDGE_JS: inlined in the app-origin wrapper / loader shell (srcdoc mode
 *     only - the Approach B wrapper CSP has no 'unsafe-inline', so deep-link scroll
 *     is a known gap there). Forwards location.hash into the iframe and mirrors
 *     in-bundle jumps back via history.replaceState (fragment-only, validated).
 *
 * Both scripts run on the opaque origin / app origin respectively and exchange only
 * the fragment string. Message types must stay disjoint from the pin bridge's
 * ('pinmode'/'pins'/'scrollto'/'ready'/'pin-dropped'/'pin-activate') - both sides
 * ignore unknown types. Neither script may contain a literal `</script>`.
 */

export interface FragmentNavConfig {
  /** Origins whose absolute links may identify this page (doc origin + app host). */
  origins: string[];
  /** URL paths that identify this page (canonical /p path, /a/<token>, /uc alias). */
  paths: string[];
}

const FRAGMENT_NAV_JS = String.raw`(function(){
  'use strict';
  var CFG=__B4M_FRAGMENT_CFG__;
  function norm(p){return p.length>1?p.replace(/\/+$/,''):p;}
  function targetFor(hash){var id;try{id=decodeURIComponent(hash.slice(1));}catch(e){id=hash.slice(1);}
    if(!id){return null;}
    var el=document.getElementById(id);if(el){return el;}
    var named=document.getElementsByName(id);return named&&named[0]?named[0]:null;}
  function jump(hash,notify){
    var el=hash?targetFor(hash):null;
    if(el){el.scrollIntoView();}
    else if(!hash||hash==='#'||hash==='#top'){window.scrollTo(0,0);}
    if(notify){try{window.parent.postMessage({b4m:'fragment',hash:hash&&hash!=='#'?hash:''},'*');}catch(e){}}
  }
  document.addEventListener('click',function(e){
    if(e.defaultPrevented||e.button!==0||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey){return;}
    var a=e.target&&e.target.closest?e.target.closest('a[href]'):null;
    if(!a){return;}
    var raw=a.getAttribute('href')||'';
    var hash;
    if(raw.charAt(0)==='#'){hash=raw;}
    else{
      var u;try{u=new URL(String(a.href));}catch(err){return;}
      if(CFG.origins.indexOf(u.origin)===-1){return;}
      if(CFG.paths.indexOf(norm(u.pathname))===-1){return;}
      hash=u.hash;
    }
    e.preventDefault();
    jump(hash,true);
  });
  window.addEventListener('message',function(e){
    if(e.source!==window.parent){return;}
    var d=e.data||{};
    if(d.b4m==='hash'&&typeof d.hash==='string'&&d.hash){jump(d.hash,false);}
  });
})();`;

/**
 * Build the fragment-nav <script> tag for injection into a sandboxed bundle.
 * The config is serialized with `<` escaped so no author-influenced path (slug,
 * share token) can close the script tag.
 */
export function buildFragmentNavScriptTag(config: FragmentNavConfig): string {
  const cfg = {
    origins: [...new Set(config.origins.filter(Boolean))],
    paths: [...new Set(config.paths.filter(Boolean).map(p => (p.length > 1 ? p.replace(/\/+$/, '') : p)))],
  };
  const json = JSON.stringify(cfg).replace(/</g, '\\u003c');
  return `<script>${FRAGMENT_NAV_JS.replace('__B4M_FRAGMENT_CFG__', json)}</script>`;
}

/**
 * Parent-side hash bridge for the wrapper page and the loader shell (srcdoc mode).
 * Sends the page hash on every iframe load (covers the loader shell's late srcdoc
 * injection) and on hashchange; accepts fragment updates back and mirrors them into
 * the address bar. Incoming hashes are fragment-only by construction (regex-gated
 * `#...` or empty), so replaceState can never change path or query.
 */
export const HASH_BRIDGE_JS = String.raw`(function(){
  var frame=document.querySelector('iframe');
  if(!frame){return;}
  function send(){try{frame.contentWindow.postMessage({b4m:'hash',hash:location.hash||''},'*');}catch(e){}}
  frame.addEventListener('load',send);
  window.addEventListener('hashchange',send);
  window.addEventListener('message',function(e){
    if(e.source!==frame.contentWindow){return;}
    var d=e.data||{};
    if(d.b4m!=='fragment'||typeof d.hash!=='string'){return;}
    if(d.hash!==''&&!/^#\S{1,512}$/.test(d.hash)){return;}
    try{history.replaceState(null,'',location.pathname+location.search+d.hash);}catch(err){}
  });
})();`;
