import { baseApi } from '@server/middlewares/baseApi';
import type { HelpIndex, HelpIndexEntry, HelpCategory } from '@bike4mind/scripts/help/types';
import passport from 'passport';
import fs from 'fs';
import path from 'path';
import type { Request, Response, NextFunction } from 'express';
import { sanitizeLocale, firstQueryValue } from '@server/help/localeParam';

/**
 * Help Index API Endpoint
 *
 * Serves the help index with proper cache headers to ensure users
 * always get the latest version after deployments.
 *
 * Uses baseApi({ auth: false }) with optional JWT authentication -
 * passport attempts to authenticate but unauthenticated users are not rejected.
 * Admin-only entries are filtered out for non-admin users.
 *
 * Cache strategy:
 * - no-store disables browser/service worker caching (response varies by auth)
 * - React Query handles client-side caching with session-keyed cache busting
 * - ETag support for conditional requests (role-aware)
 */

/**
 * Middleware that attempts JWT authentication without rejecting unauthenticated requests.
 * If a valid Bearer token is present, req.user is populated. Otherwise, req.user stays undefined.
 *
 * Auth failures are logged with a counter to help diagnose token validation issues
 * (e.g., expired tokens, misconfigured secrets) without blocking unauthenticated access.
 */
let authFailureCount = 0;
function optionalAuth(req: Request, res: Response, next: NextFunction) {
  passport.authenticate('jwt', { session: false }, (err: unknown, user: Express.User | false) => {
    if (err) {
      authFailureCount++;
      console.warn(`[HelpIndex] Optional auth error #${authFailureCount} (proceeding unauthenticated):`, err);
    }
    if (user) {
      req.user = user;
    }
    next();
  })(req, res, next);
}

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
  .use(optionalAuth)
  .get(async (req, res) => {
    try {
      const generatedDir = path.join(process.cwd(), 'app/generated');

      // Resolve the requested locale to a generated index file. `en` (and any
      // unbuilt locale) serves the canonical help-index.json; a built locale
      // serves help-index.<locale>.json, whose entries fall back to English
      // per-article. The locale is sanitized to a strict allowlist so it can
      // never escape the generated directory.
      const requestedLocale = sanitizeLocale(firstQueryValue(req.query.locale));
      const localeIndexPath =
        requestedLocale === 'en'
          ? path.join(generatedDir, 'help-index.json')
          : path.join(generatedDir, `help-index.${requestedLocale}.json`);

      let indexContent: string;
      let servedLocale = requestedLocale;
      try {
        indexContent = await fs.promises.readFile(localeIndexPath, 'utf-8');
      } catch {
        // Locale not built yet: fall back to the English index rather than 404.
        if (requestedLocale !== 'en') {
          try {
            indexContent = await fs.promises.readFile(path.join(generatedDir, 'help-index.json'), 'utf-8');
            servedLocale = 'en';
          } catch {
            res.status(404).json({ error: 'Help index not found. Run pnpm help:build-index to generate it.' });
            return;
          }
        } else {
          res.status(404).json({ error: 'Help index not found. Run pnpm help:build-index to generate it.' });
          return;
        }
      }

      const helpIndex: HelpIndex = JSON.parse(indexContent);
      const isAdmin = !!req.user?.isAdmin;

      // ETag is role- AND locale-aware so a language switch can't serve a stale
      // 304 from a different language's cached response.
      const etag = `"${helpIndex.version}-${isAdmin ? 'admin' : 'public'}-${servedLocale}"`;

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
