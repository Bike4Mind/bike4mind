/**
 * Inline script for the root layout, run while the HTML is still parsing and before the GA tag: on
 * a page whose path ends in `/shared`, the fragment is a no-sign-in share token, so it moves out of
 * the URL into `window.__b4mShareFragment` before any analytics tag can record the page's location.
 * The share pages read it back from there when the URL has no fragment of its own. Same pattern as
 * authFragmentCaptureScript (utils/authParams); `__b4mShareFragment`'s shape is read by premium
 * overlays, so keep it in sync with them.
 */
export function shareFragmentCaptureScript(): string {
  return `(function(){try{var l=window.location;if(/\\/shared\\/?$/.test(l.pathname)&&l.hash.length>1){window.__b4mShareFragment={pathname:l.pathname,hash:l.hash};history.replaceState(history.state,'',l.pathname+l.search);}}catch(e){}})();`;
}
