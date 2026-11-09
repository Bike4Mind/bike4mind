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

const SHARED_REAL_HOSTS = [STAGING_HOST, 'app.bike4mind.com'];

/**
 * True for the long-lived shared envs (staging, prod). A spec that flips a global admin setting must
 * refuse to run there: an aborted run would leave the setting changed for real users.
 */
export function isSharedRealEnv(apiUrl: string = process.env.API_URL || 'http://localhost:3000'): boolean {
  try {
    return SHARED_REAL_HOSTS.includes(new URL(apiUrl).hostname);
  } catch {
    return false;
  }
}
