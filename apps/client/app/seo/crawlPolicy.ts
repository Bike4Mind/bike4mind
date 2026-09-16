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
 * THE RULE THIS LIST FOLLOWS. `Disallow:` is the right tool for a well-known path
 * whose content is worthless to a crawler. It is the WRONG tool for a URL that is
 * itself a capability, because a crawler blocked from fetching a page can still
 * index the URL from a link it found elsewhere, and will never read the `noindex`
 * it was blocked from seeing. So:
 *
 *  - A capability-token URL is NEVER listed here. `/p/`, `/a/`, `/uc/` and `/embed/`
 *    are all served by `pages/api/publish/serve/[...path].ts`, which sets
 *    `X-Robots-Tag: noindex, nofollow` on every response that is not an explicit
 *    owner opt-in, before any response branch. Allowing the crawl and serving that
 *    header is the combination that actually keeps a page out of the index; the
 *    handler says so itself, and a `Disallow:` here would defeat it. `/uc/` has a
 *    second reason: it is served on an isolated origin, so a rule in THIS origin's
 *    robots.txt does not govern that host at all.
 *  - An authenticated app path IS listed. The path is no secret, and the SPA serves
 *    every one of them as the same content-free shell from `app/[[...slug]]`, with no
 *    `noindex` of its own. Without these lines an `Allow: /` invites a crawler to
 *    walk the app host and collect byte-identical thin-content pages.
 *
 * NOT EXHAUSTIVE, and cannot be: these are the top-level segments of `app/routes/`
 * that existed when the policy was written. A new authenticated top-level route
 * belongs here too. Nothing enforces that, which is the honest cost of preferring a
 * literal list over a blanket `Disallow: /` that would also cover the share surfaces
 * above.
 *
 * Deliberately absent for a third reason: `/share/` and `/report/` are SPA routes
 * whose `$id` is an invite/report token, so they are capability URLs by the rule
 * above - but unlike the `/p/` family they carry no `noindex` header, so neither
 * listing nor omitting them is correct. Omitting them at least avoids inviting the
 * URL-only indexing that a bare `Disallow:` causes. Giving them a header is a
 * separate change.
 */
export const CORE_DISALLOWED_PATHS: readonly string[] = [
  // Not user-facing surfaces at all.
  '/api/',
  '/serwist/',
  // Account and session flows. `/verify-` covers both verify-email and verify-change;
  // `/admin` covers admin-emergency; `/agent` covers agents and agent-executions;
  // `/quests` covers quests-v5. Matching is prefix-based, so one entry does for each.
  '/login',
  '/register',
  '/activate',
  '/accept-policies',
  '/verify-',
  '/auth',
  '/oauth',
  // Authenticated product surfaces.
  '/admin',
  '/agent',
  '/artifacts-demo',
  '/deep-agents',
  '/email',
  '/gears',
  '/google-drive',
  '/hearth',
  '/hud',
  '/integrations',
  '/notebooks',
  '/organizations',
  '/profile',
  '/projects',
  '/quests',
  '/skills',
  '/subscribe',
  '/subscriptions',
  '/tutorials',
];

/**
 * Characters legal in an origin-relative path, minus the ones that would change the
 * meaning of the file the path is interpolated into.
 *
 * Next's metadata serializer does no escaping whatsoever - it builds robots.txt as
 * `Disallow: ${item}` and the sitemap as `<loc>${item.url}</loc>` - so this guard is
 * the only thing between a contributed string and the served bytes. Two characters
 * matter beyond the RFC 3986 path set:
 *
 *  - A newline turns one entry into several lines. `"/x\nUser-agent: Googlebot\nAllow: /"`
 *    emits a real named crawler group, and per the GROUP TRAP below a named group makes
 *    that crawler ignore `*` entirely, so everything above becomes crawlable for it.
 *  - A bare `&` (and `<`, `>`, `"`) is a fatal XML parse error inside `<loc>`, which
 *    silently invalidates the whole sitemap. `&` is legal in an RFC 3986 path, so it is
 *    excluded HERE rather than relied on to be absent.
 *
 * The input is first-party and build-time (the generator reads contributions off the
 * build checkout), so this is not remotely reachable. It is a guard against a typo
 * that CI cannot see, because a multi-line template string is valid TypeScript.
 */
const UNSAFE_PATH_CHARACTER = /[^A-Za-z0-9\-._~!$()*+,;=:@%/?#]/;

/**
 * An overlay's entries arrive as plain data typed only at the contribution boundary,
 * so a malformed value would otherwise be interpolated straight into a served file.
 * Keep origin-relative paths and nothing else: a protocol-relative `//evil.test` or a
 * bare `foo` would change what the line means to a crawler.
 */
function isOriginRelativePath(value: unknown): value is string {
  return (
    typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !UNSAFE_PATH_CHARACTER.test(value)
  );
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
 *
 * A path covered by a `Disallow:` pattern is dropped rather than advertised. The two
 * contribution fields are independent, and `PremiumRouteIndexing` has no `allowPaths`
 * sibling to order against a broader disallow, so an overlay that declares
 * `disallowPaths: ['/widgets/']` next to `sitemapPaths: ['/widgets/overview']` would
 * otherwise ship a sitemap advertising the exact URL its own robots.txt forbids -
 * a green build, a valid-looking file, and zero indexing with nothing to read as an
 * error. Dropping it keeps the two files consistent by construction; the entry
 * reappears the moment the disallow that covers it goes away.
 */
export function buildSitemapPaths(overlays: readonly PremiumRouteIndexing[]): string[] {
  const disallowed = buildDisallowList(overlays);
  return normalize(overlays.flatMap(o => o.sitemapPaths ?? [])).filter(
    path => !disallowed.some(pattern => path.startsWith(pattern))
  );
}

/** Trailing slashes would double up when a path is appended. */
export function normalizeOrigin(canonicalOrigin: string): string {
  return canonicalOrigin.replace(/\/+$/, '');
}

/**
 * The absolute `Sitemap:` URL for robots.txt, or undefined when there should be no
 * such line at all: with no configured origin it cannot be written absolutely (which
 * the spec requires), and with nothing to list it would point crawlers at an empty
 * file for no reason.
 */
export function buildSitemapUrl(canonicalOrigin: string, sitemapPaths: readonly string[]): string | undefined {
  const origin = normalizeOrigin(canonicalOrigin);
  if (!origin || sitemapPaths.length === 0) return undefined;
  return `${origin}/sitemap.xml`;
}
