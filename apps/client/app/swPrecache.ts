/**
 * Globs dropped from the service worker's precache manifest at build time (createSerwistRoute's
 * `globIgnores`, relative to apps/client). A single precache entry the CDN answers with anything
 * but 200 rejects the whole install, and the browser then silently keeps the previous worker, so
 * nothing the hosted asset store might not serve may stay on the list.
 *
 * pdf.js data files (standard fonts, CJK character maps, ICC profiles, wasm decoders) are nearly
 * 200 entries only the PDF viewer needs, and the directory carries extensionless LICENSE files
 * that the asset store does not serve. The viewer fetches them on demand and the runtime cache
 * keeps them from there.
 */
export const precacheGlobIgnores = ['public/pdfjs-assets-*/**'];
