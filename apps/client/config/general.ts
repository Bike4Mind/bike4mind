// Brand identity, externalized for open-core. Sourced from NEXT_PUBLIC_* env
// (inlined into the client bundle at build time by Next.js) with no brand fallback - empty
// when unset - so a fresh clone never ships a hardcoded "Bike4Mind" literal. Defined locally
// rather than imported from @bike4mind/common, which is server-only.
export const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME || '';
export const WEBSITE_URL = process.env.NEXT_PUBLIC_WEBSITE_URL || '';
export const getWebsiteUrl = (path?: string) => (path ? `${WEBSITE_URL}/${path}` : WEBSITE_URL);

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
