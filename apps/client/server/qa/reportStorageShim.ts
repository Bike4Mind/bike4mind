/**
 * The report proxy (pages/api/admin/qa/report/[runId]/[token]/[...path].ts) serves the Playwright
 * HTML report under a CSP sandbox with no allow-same-origin. In that opaque origin any read of
 * window.localStorage throws, and the report reads it on startup, so the page renders blank.
 * This script swaps in a per-page, in-memory Storage only where the real one throws: the
 * sandbox stays as it is, and nothing the report stores outlives the tab.
 */
const SHIM = `<script>(function(){function m(){var d=Object.create(null);return{get length(){return Object.keys(d).length},key:function(i){var k=Object.keys(d);return i>=0&&i<k.length?k[i]:null},getItem:function(k){k=String(k);return k in d?d[k]:null},setItem:function(k,v){d[String(k)]=String(v)},removeItem:function(k){delete d[String(k)]},clear:function(){d=Object.create(null)}}}['localStorage','sessionStorage'].forEach(function(n){try{window[n]}catch(e){try{Object.defineProperty(window,n,{value:m(),configurable:true})}catch(e2){}}})})();</script>`;

const HEAD_OPEN = /<head\b[^>]*>/i;

/** Returns the HTML with the storage shim placed first in <head>, ahead of the report's own scripts. */
export function withStorageShim(html: Buffer): Buffer {
  const text = html.toString('utf8');
  const head = HEAD_OPEN.exec(text);
  const at = head ? head.index + head[0].length : 0;
  return Buffer.from(text.slice(0, at) + SHIM + text.slice(at), 'utf8');
}
