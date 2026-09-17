// Brand identity, externalized for open-core. Sourced from NEXT_PUBLIC_* env
// (inlined into the client bundle at build time by Next.js) with no brand fallback - empty
// when unset - so a fresh clone never ships a hardcoded "Bike4Mind" literal. Defined locally
// rather than imported from @bike4mind/common, which is server-only.
export const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME || '';
export const WEBSITE_URL = process.env.NEXT_PUBLIC_WEBSITE_URL || '';
export const getWebsiteUrl = (path?: string) => (path ? `${WEBSITE_URL}/${path}` : WEBSITE_URL);

/**
 * The origin this app is served at, for canonical/SEO output (`app/robots.ts`,
 * `app/sitemap.ts`).
 *
 * NOT {@link WEBSITE_URL}, which is the MARKETING site: infra names it that way
 * (`WEBSITE_URL: marketing site URL`) and `app/utils/externalLinks.ts` spends it on
 * pricing/blog/terms pages that do not exist in `app/routes/`. Building a sitemap
 * from it would advertise this app's paths on a different host, which search engines
 * reject as outside the sitemap's own origin.
 *
 * Its own variable rather than a reuse of `APP_URL`, which is resolved at deploy time
 * into the Lambda environment and so is not available to a `force-static` build.
 * Empty when unset - same no-fallback rule as the brand values above - which the two
 * consumers read as "emit nothing" rather than guessing an origin.
 */
export const CANONICAL_ORIGIN = process.env.NEXT_PUBLIC_CANONICAL_ORIGIN || '';

/**
 * Human-facing brand/display name for PROSE contexts. Mirrors the server-side
 * getBrandName in @bike4mind/common. Unlike the raw {@link APP_NAME} constant - empty when unset
 * to preserve the no-brand-fallback invariant - this returns a neutral word so client
 * copy never renders broken when NEXT_PUBLIC_APP_NAME is unset. Use APP_NAME where empty-is-correct.
 *
 * Server-side fallback order: NEXT_PUBLIC_APP_NAME -> APP_NAME -> SEED_APP_NAME (capitalized).
 * On the client, process.env.APP_NAME and SEED_APP_NAME are undefined (non-public vars are not
 * inlined into the client bundle), so the fallback naturally degrades to 'the app' there.
 */
export const getBrandName = (): string => {
  const raw = process.env.NEXT_PUBLIC_APP_NAME || process.env.APP_NAME || process.env.SEED_APP_NAME || '';
  if (!raw) return 'the app';
  // Capitalize first letter and any letter following a digit (e.g. "bike4mind" -> "Bike4Mind").
  return (raw.charAt(0).toUpperCase() + raw.slice(1)).replace(/(\d)([a-z])/g, (_, d, l) => d + l.toUpperCase());
};
