const STAGING_HOST = 'app.staging.bike4mind.com';

/**
 * True only when API_URL is staging. An allowlist on purpose: previews and localhost carry no Stripe
 * team price, and production Stripe is live mode, so "not a preview" would be the wrong test.
 */
export function isStagingEnv(): boolean {
  try {
    return new URL(process.env.API_URL || 'http://localhost:3000').hostname === STAGING_HOST;
  } catch {
    return false;
  }
}
