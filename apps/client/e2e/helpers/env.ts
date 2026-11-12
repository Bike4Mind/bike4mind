const STAGING_HOST = 'app.staging.bike4mind.com';
const PRODUCTION_HOST = 'app.bike4mind.com';

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

export function isProductionEnv(): boolean {
  return apiHostname() === PRODUCTION_HOST;
}
