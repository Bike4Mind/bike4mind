import type { PremiumRouteIndexing } from '../premiumContract';

/**
 * The crawler policy behind `app/robots.ts` and `app/sitemap.ts`, kept separate from
 * those two files because Next.js metadata routes are awkward to unit-test directly.
 *
 * Both consumers are statically generated, so everything here must be pure and must
 * produce byte-stable output: a build that reorders entries churns the CDN cache for
 * no reason. Hence the sort in every builder.
 */

/**
 * Core surfaces that must never be crawled.
 *
 * `/a/`, `/uc/` and `/embed/` already send `X-Robots-Tag: noindex, nofollow` per
 * response; listing them here is belt and braces, and it also stops a crawler
 * spending budget on them in the first place.
 *
 * `/p/` is deliberately ABSENT. Published artifacts are indexable only when the
 * owner opts in, and that decision is enforced per response by the serve handler
 * (`pages/api/publish/serve/[...path].ts`, `searchIndexable`). A blanket disallow
 * here would stop crawlers fetching the page at all, so they would never see the
 * `index` header and the opt-in would silently stop working.
 */
export const CORE_DISALLOWED_PATHS: readonly string[] = ['/api/', '/a/', '/uc/', '/embed/', '/serwist/', '/login'];

/**
 * An overlay's entries arrive as plain data typed only at the contribution boundary,
 * so a malformed value would otherwise be interpolated straight into a served file.
 * Keep origin-relative paths and nothing else: a protocol-relative `//evil.test` or a
 * bare `foo` would change what the line means to a crawler.
 */
function isOriginRelativePath(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//');
}

function normalize(paths: readonly string[]): string[] {
  return [...new Set(paths.filter(isOriginRelativePath))].sort();
}

/**
 * Every `Disallow:` pattern for the single `User-agent: *` group.
 *
 * GROUP TRAP, for whoever adds named crawler groups later: a crawler obeys only its
 * own most-specific `User-agent:` group and ignores `*` entirely. The moment a named
 * group exists it needs its own copy of these patterns, and a named group without its
 * own `Allow:`/`Disallow:` lines inherits nothing from `*`.
 */
export function buildDisallowList(overlays: readonly PremiumRouteIndexing[]): string[] {
  return normalize([...CORE_DISALLOWED_PATHS, ...overlays.flatMap(o => o.disallowPaths ?? [])]);
}

/**
 * Origin-relative paths for the sitemap.
 *
 * Core contributes none of its own: the app is a login-walled SPA, and its one
 * genuinely public surface (`/p/`) is per-owner opt-in and database-backed, so it
 * cannot be enumerated in a static build. The list is therefore whatever the
 * installed overlays declare, which is empty in a fork.
 */
export function buildSitemapPaths(overlays: readonly PremiumRouteIndexing[]): string[] {
  return normalize(overlays.flatMap(o => o.sitemapPaths ?? []));
}

/** Trailing slashes would double up when a path is appended. */
export function normalizeOrigin(websiteUrl: string): string {
  return websiteUrl.replace(/\/+$/, '');
}

/**
 * The absolute `Sitemap:` URL for robots.txt, or undefined when there should be no
 * such line at all: with no configured origin it cannot be written absolutely (which
 * the spec requires), and with nothing to list it would point crawlers at an empty
 * file for no reason.
 */
export function buildSitemapUrl(websiteUrl: string, sitemapPaths: readonly string[]): string | undefined {
  const origin = normalizeOrigin(websiteUrl);
  if (!origin || sitemapPaths.length === 0) return undefined;
  return `${origin}/sitemap.xml`;
}
