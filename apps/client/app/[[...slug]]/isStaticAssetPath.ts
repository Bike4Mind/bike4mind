/**
 * A catch-all path whose final segment names a file (e.g. `/pdf.worker-0.0.0.min.mjs`) is a
 * request for a static asset, not a client route: a missing one must 404 instead of receiving
 * the SPA HTML shell. Only the last segment is tested, so a dot in an earlier segment
 * (`/v1.2/foo`) stays a client route.
 *
 * Kept as a tiny pure predicate (not inlined in the page) so it is unit-testable without
 * pulling in `next/navigation`.
 */
const STATIC_ASSET_EXTENSION_RE =
  /\.(?:js|mjs|cjs|wasm|json|css|map|jpe?g|png|gif|svg|webp|avif|ico|woff2?|ttf|otf|eot)$/i;

export function isStaticAssetPath(slug: string[] | undefined): boolean {
  if (!slug || slug.length === 0) return false;
  // `/status/tests/$testKey` is a client route whose one dynamic segment is an arbitrary
  // encoded QA key (e.g. `notebook.spec.ts > saves`) that can end in a file-like token, so it
  // must keep deep-linking to the SPA rather than 404.
  if (slug[0] === 'status' && slug[1] === 'tests') return false;
  return STATIC_ASSET_EXTENSION_RE.test(slug[slug.length - 1]);
}
