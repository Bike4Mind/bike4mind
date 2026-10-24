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
 * Same-bundle links (another page of a multi-page bundle, or a file in it) get the same
 * treatment for the same reason: navigating the sandboxed frame drops the proof cookie,
 * and a download started inside the sandbox is blocked (no `allow-downloads`). When
 * `bundleBases` is set, FRAGMENT_NAV hands such a click to the parent instead:
 *       iframe -> parent : { b4m: 'navigate', path: '/p/.../page.html#x' }
 * and the parent navigates its OWN top-level browsing context there. The parent accepts
 * only a path under the bundle it is itself showing (derived from its own location),
 * so a bundle can never steer the viewer anywhere else. A `target=_blank` link to a page
 * is left to the browser: the sandbox lets it open as an escaped top-level tab, which
 * carries the SameSite=Lax proof cookie. Files are always routed, whatever their target,
 * because a download started from the sandbox is blocked even in an escaped popup.
 *
 * Both scripts run on the opaque origin / app origin respectively and exchange only
 * the fragment string or a same-bundle path. Message types must stay disjoint from the
 * pin bridge's ('pinmode'/'pins'/'scrollto'/'ready'/'pin-dropped'/'pin-activate') - both
 * sides ignore unknown types. Neither script may contain a literal `</script>`.
 */

export interface FragmentNavConfig {
  /** Origins whose absolute links may identify this page (doc origin + app host). */
  origins: string[];
  /** URL paths that identify this page (canonical /p path, /a/<token>, /uc alias). */
  paths: string[];
  /**
   * URL paths of the bundle root(s) whose other pages and files should be navigated at
   * top level via the parent. Empty disables routing (isolated origin, no parent bridge).
   */
  bundleBases?: string[];
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
      var p=norm(u.pathname);
      if(CFG.paths.indexOf(p)===-1){
        if(!inBundle(p)){return;}
        var page=CFG.bases.indexOf(p)!==-1||/\.html?$/i.test(p);
        if(page&&(a.getAttribute('target')||'').toLowerCase()==='_blank'){return;}
        e.preventDefault();
        var q=!page&&u.search==='?download=1'?u.search:'';
        try{window.parent.postMessage({b4m:'navigate',path:p+q+u.hash},'*');}catch(err){}
        return;
      }
      hash=u.hash;
    }
    e.preventDefault();
    jump(hash,true);
  });
  function inBundle(p){for(var i=0;i<CFG.bases.length;i++){if(p===CFG.bases[i]||p.indexOf(CFG.bases[i]+'/')===0){return true;}}return false;}
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
    bases: [...new Set((config.bundleBases ?? []).filter(Boolean).map(p => p.replace(/\/+$/, '')))],
  };
  const json = JSON.stringify(cfg).replace(/</g, '\\u003c');
  return `<script>${FRAGMENT_NAV_JS.replace('__B4M_FRAGMENT_CFG__', json)}</script>`;
}

/**
 * The ONE validator every consumer of a frame-supplied bundle path runs (the wrapper and
 * loader-shell hash bridge, and the loader shell's file hook). Inlined into each script, so
 * it is ES5 and self-contained. `b4mBundlePath(path)` returns
 * `{ path, hash, page, download }` for a same-origin path that is the bundle root this
 * document is showing (derived from its own location) or sits under it, else null. It
 * rejects anything a URL parser would rewrite (`.%2e`, `%2e.`, backslashes, `//`), any
 * segment that DECODES to `.`/`..` or still carries `%`, `/` or `\` after one decode (double
 * encoding), any query but a file's `?download=1`, and any other origin - so the only places
 * a bundle can send the viewer are its own pages and files. Refusing `%` also refuses a file
 * whose name contains one: the hosted request path is decoded once before the app sees it,
 * so `100%25.pdf` reaches the router as `100%.pdf` and fails there with a 400 anyway. If the
 * edge stops decoding, a second-decode check can replace this refusal.
 */
export const BUNDLE_PATH_JS = String.raw`function b4mBundleBase(){
  return (/^\/(?:p\/(?:u|pj|o)\/[^/]+\/[^/]+|a\/[^/]+)(?=\/|$)/.exec(location.pathname)||[''])[0];
}
function b4mBundlePath(path){
  var base=b4mBundleBase();
  if(typeof path!=='string'||!base||path.length>2048){return null;}
  var at=path.indexOf('#');
  var p=at===-1?path:path.slice(0,at);
  var hash=at===-1?'':path.slice(at);
  var download=/\?download=1$/.test(p);
  if(download){p=p.slice(0,-11);}
  if(/[\\\s?]/.test(p+hash)){return null;}
  if(hash&&!/^#[^#]{1,512}$/.test(hash)){return null;}
  if(p.charAt(0)!=='/'||p.charAt(1)==='/'){return null;}
  if(p!==base&&p.indexOf(base+'/')!==0){return null;}
  var u;try{u=new URL(p,location.origin);}catch(e){return null;}
  if(u.origin!==location.origin||u.pathname!==p||u.search){return null;}
  var segs=p.split('/');
  for(var i=1;i<segs.length;i++){
    var d;try{d=decodeURIComponent(segs[i]);}catch(e){return null;}
    if(d===''||d==='.'||d==='..'||/[%\/\\]/.test(d)){return null;}
  }
  var page=p===base||/\.html?$/i.test(p);
  if(page&&download){return null;}
  return {path:p,hash:hash,page:page,download:download};
}`;

/**
 * Parent-side hash bridge for the wrapper page and the loader shell (srcdoc mode).
 * Sends the page hash on every iframe load (covers the loader shell's late srcdoc
 * injection) and on hashchange; accepts fragment updates back and mirrors them into
 * the address bar. Incoming hashes are fragment-only by construction (regex-gated
 * `#...` or empty), so replaceState can never change path or query.
 *
 * Also answers `navigate` (see the file header) for a path `b4mBundlePath` accepts, and only
 * during a user activation: a click inside the frame activates its ancestors too, so a real
 * click passes, while a script looping navigate messages cannot force top-level navigations
 * or downloads on its own. Activation is transient (about 5 s) and a navigation does not
 * consume it, so one click is further held to one navigation per second and to one file
 * per 5 s - roughly one file per activation. Where the UA has no `navigator.userActivation`
 * there is no click to require, so only PAGE navigations pass there (one per 2 s); files,
 * which open or download, are refused rather than allowed without a click. Files go through `window.__b4mFetchDownload` when
 * a host page defines one (the loader shell, whose viewer authorizes by Bearer and so cannot
 * download by plain navigation); otherwise a top-level navigation to the file opens it.
 */
export const HASH_BRIDGE_JS = String.raw`(function(){
  var frame=document.querySelector('iframe');
  if(!frame){return;}
  function send(){try{frame.contentWindow.postMessage({b4m:'hash',hash:location.hash||''},'*');}catch(e){}}
  frame.addEventListener('load',send);
  window.addEventListener('hashchange',send);
  ${BUNDLE_PATH_JS}
  var lastNav=0,lastFile=0;
  function allowed(page){
    var ua=navigator.userActivation,now=Date.now();
    if(!ua){
      if(!page||now-lastNav<2000){return false;}
      lastNav=now;return true;
    }
    if(ua.isActive!==true||now-lastNav<1000){return false;}
    if(!page){if(now-lastFile<5000){return false;}lastFile=now;}
    lastNav=now;return true;
  }
  function navigate(raw){
    var t=b4mBundlePath(raw);
    if(!t||!allowed(t.page)){return;}
    var q=t.download?'?download=1':'';
    if(!t.page&&typeof window.__b4mFetchDownload==='function'){window.__b4mFetchDownload(t.path+q);return;}
    location.assign(t.path+q+t.hash);
  }
  window.addEventListener('message',function(e){
    if(e.source!==frame.contentWindow){return;}
    var d=e.data||{};
    if(d.b4m==='navigate'){navigate(d.path);return;}
    if(d.b4m!=='fragment'||typeof d.hash!=='string'){return;}
    if(d.hash!==''&&!/^#\S{1,512}$/.test(d.hash)){return;}
    try{history.replaceState(null,'',location.pathname+location.search+d.hash);}catch(err){}
  });
})();`;
