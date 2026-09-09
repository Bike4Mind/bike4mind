import { baseApi } from '@server/middlewares/baseApi';
import { ApiKeyScope } from '@bike4mind/common';
import { ADMIN_HELP_CONTENT_DIR, PUBLIC_HELP_CONTENT_DIR } from '@bike4mind/scripts/help/utils';
import fs from 'fs';
import path from 'path';

/**
 * Admin Help Content API Endpoint
 *
 * The ONLY way to read admin-only help articles and the media they reference. Admin content is
 * bundled into a server-only directory (`app/generated/help-content-admin`, written by
 * `packages/scripts/help/bundle-help-content.ts`) instead of `public/`, precisely so that Next
 * cannot serve it as an unauthenticated static asset. Public articles are unchanged and still
 * come straight out of `public/help-content/`.
 *
 * Markdown AND media both go through here: an admin article's images/videos are bundled beside it
 * under the same admin root, so gating only the markdown would leave the screenshots public. Media
 * additionally falls back to the public root - see rootsForExtension.
 *
 * Bodies are returned verbatim - frontmatter included. The help viewer strips it client-side, and
 * `server/help/retrieval.ts` strips it for the Help-AI context, so stripping it here would only
 * put a second, divergent parser in the path.
 *
 * Access-level filtering of the *index* (which slugs a caller may see at all) lives in
 * `filterHelpIndex` in `pages/api/help/index.ts`; this route is the matching gate on the bodies.
 */

/**
 * requiredScopes gates the API-key path only, matching the admin routes under `pages/api/admin/`:
 * apiKeyAuth rejects an under-scoped key before req.user is set, so a key issued for a narrow
 * integration cannot read platform admin documentation just because its owner is an admin. The
 * JWT/browser path (the help viewer, the only real consumer) is unaffected and still goes through
 * the isAdmin check below.
 */
const API_OPTIONS = { requiredScopes: [ApiKeyScope.ADMIN] };

const MARKDOWN_EXTENSION = '.md';
const MARKDOWN_CONTENT_TYPE = 'text/markdown; charset=utf-8';

/**
 * Media extensions this route will serve, and the Content-Type each gets. An allowlist rather
 * than a lookup-with-fallback: the roots are inside the deployed app directory, so an unknown
 * extension must be a miss, never an octet-stream download of whatever happens to sit there.
 */
const ASSET_CONTENT_TYPES: Record<string, string | undefined> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

/**
 * Root of the server-only admin content bundle. Files keep their docs-root-relative layout
 * (`admin/overview.md`, `admin/media/setup.gif`), so a request path is an article slug path.
 * Must stay in sync with the bundler's admin output dir and with the admin root in
 * `server/help/retrieval.ts`. Resolved per request rather than at module load so the value
 * tracks process.cwd() (which the Lambda handler sets) instead of import order.
 */
function adminContentRoot(): string {
  return path.join(process.cwd(), ADMIN_HELP_CONTENT_DIR);
}

/** Public content root - unchanged, and still served statically by Next. Asset fallback only. */
function publicContentRoot(): string {
  return path.resolve(process.cwd(), PUBLIC_HELP_CONTENT_DIR);
}

/** Lexical half of the traversal guard: the path must be relative and carry no `..` segment. */
function isEscapingPath(requested: string): boolean {
  return path.isAbsolute(requested) || requested.split(/[\\/]/).includes('..');
}

/**
 * Resolve a caller-supplied docs-root-relative path inside `root`, or null if it lands outside.
 *
 * Mirrors the guard in `server/help/retrieval.ts` ("Path traversal attempt blocked") so the two
 * stay recognisably the same. path.resolve alone is not the guard: it happily normalises
 * `../../generated/help-index.json` into a real path outside the root, which is why the resolved
 * absolute path is compared against `root + path.sep`.
 */
function resolveWithinRoot(root: string, requested: string): string | null {
  const resolved = path.resolve(root, requested);
  return resolved.startsWith(root + path.sep) ? resolved : null;
}

/**
 * Roots to search, in order, for a request with this extension.
 *
 * Assets fall back to the public root because the bundler writes an asset referenced by at least
 * one PUBLIC article to the public root ONLY - "public wins" in
 * `packages/scripts/help/bundle-help-content.ts` - so an admin article can legitimately reference
 * media that exists nowhere under the admin root. The fallback adds no exposure: Next already
 * serves the public root unauthenticated, so handing one of its files to an authenticated admin
 * is strictly narrower than the status quo.
 *
 * Markdown gets NO such fallback: public markdown is already a static asset, so letting an admin
 * pull it through the authed route would widen this route's reach for nothing.
 */
function rootsForExtension(extension: string): string[] {
  const roots = [adminContentRoot()];
  if (extension in ASSET_CONTENT_TYPES) roots.push(publicContentRoot());
  return roots;
}

const handler = baseApi(API_OPTIONS).get(async (req, res) => {
  // 404 - not 403 - for a non-admin caller, an unknown path, a traversal attempt and a missing
  // file alike: a distinct 403 would tell a prober which admin articles exist.
  const notFound = () => res.status(404).json({ error: 'Not found' });

  if (!req.user?.isAdmin) return notFound();

  const requested = typeof req.query.path === 'string' ? req.query.path : '';
  if (!requested) return notFound();

  // Ahead of the extension check so an escaping path is always logged, even when its extension
  // would have been refused anyway.
  if (isEscapingPath(requested)) {
    req.logger?.warn(`[HelpContent] Path traversal attempt blocked for path: ${requested}`);
    return notFound();
  }

  const extension = path.extname(requested).toLowerCase();
  const contentType = extension === MARKDOWN_EXTENSION ? MARKDOWN_CONTENT_TYPE : ASSET_CONTENT_TYPES[extension];
  if (!contentType) return notFound();

  let data: Buffer | null = null;
  for (const root of rootsForExtension(extension)) {
    // Resolve-then-verify per root: the guard is against whichever root is about to be read,
    // never once against a root the read does not use.
    const resolved = resolveWithinRoot(root, requested);
    if (!resolved) continue;
    try {
      data = await fs.promises.readFile(resolved);
      break;
    } catch {
      // Missing file, directory-as-path, or no content bundled under this root at all - none of
      // which are server errors. Fall through to the next root (see rootsForExtension).
    }
  }

  if (!data) return notFound();

  // no-store + Vary, matching pages/api/help/index.ts: the response is admin-only, so no shared
  // cache (browser, service worker, CDN) may hold it against a differently-authenticated request.
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Vary', 'Authorization');
  // The allowlist above declares the type; nosniff stops a browser overriding it (an .md body
  // sniffed as HTML would execute same-origin).
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // proxy.ts's CSP block excludes `/api/` while its matcher does cover `/help-content/*`, so an
  // SVG that used to be served statically under the app CSP no longer gets one here - and a
  // top-level navigation to `image/svg+xml` renders as a same-origin document. Forcing a download
  // costs the viewer nothing: it fetches media through `fetch` into a blob URL
  // (useAuthedMediaSrc in HelpContent.tsx), which ignores Content-Disposition.
  if (extension === '.svg') res.setHeader('Content-Disposition', 'attachment');

  return res.status(200).send(data);
});

export default handler;
