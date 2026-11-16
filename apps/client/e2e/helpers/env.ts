import { z } from 'zod';

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

const apiRuntimeSchema = z.enum(['development', 'production']).optional();

/** Development servers deliberately bypass rate limits; remote targets default to production. */
export function expectsApiRateLimitEnforcement(
  apiUrl = process.env.API_URL || 'http://localhost:3000',
  runtime = process.env.E2E_API_RUNTIME
): boolean {
  const configuredRuntime = apiRuntimeSchema.parse(runtime);
  if (configuredRuntime) return configuredRuntime === 'production';
  const hostname = new URL(apiUrl).hostname.replace(/\.$/, '');
  const loopback =
    hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '[::1]' || /^127\./.test(hostname);
  return !loopback;
}

const SHARED_REAL_HOSTS = [STAGING_HOST, PRODUCTION_HOST];

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
