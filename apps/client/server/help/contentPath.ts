import path from 'path';

/**
 * Traversal-safe resolution of a docs-root-relative help content path, shared by the two server
 * readers of the content roots: `server/help/retrieval.ts` and `pages/api/help/content.ts`.
 *
 * Returns a normalised RELATIVE path, so callers append it to a root with a template literal
 * rather than handing the root to `path.resolve`. That is a bundle-size constraint, not a style
 * choice: @vercel/nft partially evaluates a `path.resolve()` whose base it cannot determine
 * statically - and a root picked out of a runtime array is exactly that - then gives up on a
 * concrete path and falls back to globbing the entire app directory into the traced Lambda
 * bundle. Measured at 47 MB of source, `public/`, e2e specs and `tsconfig.tsbuildinfo` against a
 * hard 250 MB ceiling. See the upload-spool fix in `server/utils/spoolRequestToFile.ts`, which
 * removed 43 MB for the same reason and by the same means.
 *
 * Because the read paths are opaque to the tracer, the content roots no longer trace themselves:
 * both are declared in `outputFileTracingIncludes` in `apps/client/next.config.mjs`. Those two
 * facts are a pair - removing the declaration silently 404s help content, and reintroducing a
 * `path.resolve` against a dynamic root silently re-adds the 47 MB.
 *
 * The guard is normalise-then-reject rather than resolve-then-compare-prefix. `path.normalize`
 * collapses `a/../../b` to `../b`, so a leading `..` IS the escape signal, and no absolute root is
 * needed to detect it. On POSIX a backslash is an ordinary filename character, so `..\..\x.md`
 * normalises to a single segment that still begins with `..` and is still rejected.
 */
export function safeHelpContentPath(candidate: string): string | null {
  // A NUL byte makes fs throw rather than read, but reject it here so the refusal is uniform and
  // logged by the caller alongside the other escape shapes.
  if (!candidate || candidate.includes('\0')) return null;

  // One absoluteness check, after normalising: path.normalize preserves a leading separator, so
  // this catches both an already-absolute input and anything that normalises to one. Checking the
  // raw candidate as well would be dead code.
  const normalised = path.normalize(candidate);
  if (normalised.startsWith('..') || path.isAbsolute(normalised)) return null;
  return normalised;
}
