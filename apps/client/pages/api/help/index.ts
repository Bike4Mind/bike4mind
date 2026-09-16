import { baseApi } from '@server/middlewares/baseApi';
import { optionalJwtAuth } from '@server/middlewares/optionalJwtAuth';
import type { HelpIndex, HelpIndexEntry, HelpCategory } from '@bike4mind/scripts/help/types';
import fs from 'fs';
import path from 'path';

/**
 * Help Index API Endpoint
 *
 * Serves the help index with proper cache headers to ensure users
 * always get the latest version after deployments.
 *
 * Uses baseApi({ auth: false }) with the shared optionalJwtAuth() shim: a valid Bearer JWT
 * populates req.user, an unauthenticated request is not rejected, and a pre-MFA or relying-party
 * OAuth token degrades to anonymous (so it cannot flip isAdmin and leak admin-only entries) -
 * the same default-deny every optional-auth route shares. Admin-only entries are filtered out for
 * non-admin (including anonymous) callers.
 *
 * Cache strategy:
 * - no-store disables browser/service worker caching (response varies by auth)
 * - React Query handles client-side caching with session-keyed cache busting
 * - ETag support for conditional requests (role-aware)
 */

/**
 * Filter help index entries and categories by access level.
 * Non-admin users only see 'public' entries.
 */
function filterHelpIndex(helpIndex: HelpIndex, isAdmin: boolean): HelpIndex {
  if (isAdmin) return helpIndex;

  const filteredEntries = helpIndex.entries.filter(
    (entry: HelpIndexEntry) => !entry.accessLevel || entry.accessLevel === 'public'
  );

  const filterCategories = (categories: HelpCategory[]): HelpCategory[] =>
    categories
      .filter(cat => !cat.accessLevel || cat.accessLevel === 'public')
      .map(cat => ({
        ...cat,
        entries: cat.entries.filter(entry => !entry.accessLevel || entry.accessLevel === 'public'),
        subcategories: filterCategories(cat.subcategories),
      }))
      .filter(cat => cat.entries.length > 0 || cat.subcategories.length > 0);

  return {
    ...helpIndex,
    entries: filteredEntries,
    categories: filterCategories(helpIndex.categories),
  };
}

const handler = baseApi({ auth: false })
  .use(optionalJwtAuth())
  .get(async (req, res) => {
    try {
      const indexPath = path.join(process.cwd(), 'app/generated/help-index.json');

      let indexContent: string;
      try {
        indexContent = await fs.promises.readFile(indexPath, 'utf-8');
      } catch {
        res.status(404).json({
          error: 'Help index not found. Run pnpm help:build-index to generate it.',
        });
        return;
      }

      const helpIndex: HelpIndex = JSON.parse(indexContent);
      const isAdmin = !!req.user?.isAdmin;

      // Generate role-aware ETag for conditional requests
      const etag = `"${helpIndex.version}-${isAdmin ? 'admin' : 'public'}"`;

      const clientEtag = req.headers['if-none-match'];
      if (clientEtag === etag) {
        res.status(304).end();
        return;
      }

      const filteredIndex = filterHelpIndex(helpIndex, isAdmin);

      // no-store: response varies by user role - browser/service worker must not cache
      // (React Query handles client-side caching with session-unique cache keys)
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('Vary', 'Authorization');
      res.setHeader('ETag', etag);

      res.json(filteredIndex);
    } catch (error) {
      console.error('[HelpIndex] Error loading index:', error);
      res.status(500).json({
        error: 'Failed to load help index',
      });
    }
  });

export default handler;
