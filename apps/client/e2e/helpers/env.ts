const STAGING_HOST = 'app.staging.bike4mind.com';
const PRODUCTION_HOSTS = new Set(['app.bike4mind.com', 'bike4mind.com', 'www.bike4mind.com']);
const PREVIEW_HOST = /^app\.pr\d+\.preview\.bike4mind\.com$/;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function apiHostname(): string | null {
  try {
    return new URL(process.env.API_URL || 'http://localhost:3000').hostname;
  } catch {
    return null;
  }
}

/**
 * True only when API_URL is staging. An allowlist on purpose: previews and localhost carry no Stripe
 * team price, and production Stripe is live mode, so "not a preview" would be the wrong test.
 */
export function isStagingEnv(): boolean {
  return apiHostname() === STAGING_HOST;
}

/** True for a per-PR preview stage (app.pr<N>.preview.bike4mind.com). */
export function isPreviewEnv(): boolean {
  return PREVIEW_HOST.test(apiHostname() ?? '');
}

/** True for a developer's local server. */
export function isLocalEnv(): boolean {
  return LOCAL_HOSTS.has(apiHostname() ?? '');
}

/** True when API_URL is production, or cannot be parsed (treated as production so nothing runs against it). */
export function isProductionEnv(): boolean {
  const host = apiHostname();
  return host === null || PRODUCTION_HOSTS.has(host);
}
