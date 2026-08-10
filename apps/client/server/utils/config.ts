import { Resource } from 'sst';

/**
 * Safe read for a manifest-optional secret (see b4m-core/resource manifest.ts
 * "optional" entries). On the real SST runtime, accessing an unlinked/
 * unprovisioned `Resource.*` property throws in the getter itself - `?.`
 * cannot guard that, since the throw happens before `?.` ever runs. Config is
 * built eagerly at module scope and imported by nearly every server route, so
 * one un-provisioned optional secret would otherwise 500 every route on any
 * stage where it isn't linked. Every stage deployed from this repo's own
 * infra/secrets.ts + infra/web.ts links all of these today (each has a
 * default value), so this is forward-looking hardening rather than a fix for
 * a currently-reachable failure - it guards a self-host fork or a future
 * premium-cutover phase that stops declaring one of these secrets. Mirrors
 * the self-host shim's behavior (undefined instead of throwing) on the real
 * SST runtime too. Warns once per unlinked field so a stage that actually
 * hits this path is still diagnosable in logs, not just "the feature quietly
 * doesn't work."
 */
function readOptionalSecret(name: string, read: () => string | undefined): string | undefined {
  try {
    return read();
  } catch {
    console.warn(
      `[config] ${name} is not linked/provisioned on this stage - degrading to undefined instead of throwing.`
    );
    return undefined;
  }
}

const Config = {
  // Hard-required core boot secrets (see manifest.ts) - intentionally left
  // unguarded so a missing one fails fast at startup rather than degrading.
  MONGODB_URI: Resource.MONGODB_URI.value,
  SESSION_SECRET: Resource.SESSION_SECRET.value,
  JWT_SECRET: Resource.JWT_SECRET.value,
  // These are manifest-optional (self-host env-var fallback) but every real deployed
  // stage has always had them linked with a default, so callers assume `string` and
  // are out of scope for the premium-overlay eager-read fix below - left untouched.
  SLACK_WEBHOOK_URL: Resource.SLACK_WEBHOOK_URL.value,
  SLACK_ERROR_REPORTING_WEBHOOK_URL: Resource.SLACK_ERROR_REPORTING_WEBHOOK_URL.value,
  GOOGLE_CLIENT_ID: Resource.GOOGLE_CLIENT_ID.value,
  GOOGLE_CLIENT_SECRET: Resource.GOOGLE_CLIENT_SECRET.value,
  GITHUB_CLIENT_ID: Resource.GITHUB_CLIENT_ID.value,
  GITHUB_CLIENT_SECRET: Resource.GITHUB_CLIENT_SECRET.value,
  STRIPE_WEBHOOK_SECRET: Resource.STRIPE_WEBHOOK_SECRET.value,
  STRIPE_SECRET_KEY: Resource.STRIPE_SECRET_KEY.value,
  STRIPE_PUBLISHABLE_KEY: Resource.STRIPE_PUBLISHABLE_KEY.value,
  SUPPORT_EMAIL: Resource.SUPPORT_EMAIL.value,
  MAIL_FROM: Resource.MAIL_FROM.value,
  MAIL_HOST: Resource.MAIL_HOST.value,
  MAIL_PORT: Resource.MAIL_PORT.value,
  MAIL_USERNAME: Resource.MAIL_USERNAME.value,
  MAIL_PASSWORD: Resource.MAIL_PASSWORD.value,
  ANTHROPIC_API_KEY: Resource.ANTHROPIC_API_KEY.value,
  GEMINI_API_KEY: Resource.GEMINI_API_KEY.value,
  OKTA_AUDIENCE: Resource.OKTA_AUDIENCE.value,
  OKTA_CLIENT_ID: Resource.OKTA_CLIENT_ID.value,
  OKTA_CLIENT_SECRET: Resource.OKTA_CLIENT_SECRET.value,
  OKTA_USE_ORG_AUTH_SERVER: Resource.OKTA_USE_ORG_AUTH_SERVER.value,
  // Secret encryption key for encrypting secrets stored in database (AES-256-GCM).
  // NOTE: manifest.ts marks this hard-required (unlike the other entries below);
  // left as pre-existing `?.` behavior here rather than reconciled, since changing
  // encryption-key requiredness is out of scope for this change.
  SECRET_ENCRYPTION_KEY: Resource.SECRET_ENCRYPTION_KEY?.value,
  // RSA private key for OIDC ID token signing (RS256). Base64-encoded PEM.
  // If not set, an ephemeral key is generated at startup (dev only).
  OAUTH_RSA_PRIVATE_KEY: readOptionalSecret('OAUTH_RSA_PRIVATE_KEY', () => Resource.OAUTH_RSA_PRIVATE_KEY.value),
  SECRET_ENCRYPTION_KEY_PREVIOUS: readOptionalSecret(
    'SECRET_ENCRYPTION_KEY_PREVIOUS',
    () => Resource.SECRET_ENCRYPTION_KEY_PREVIOUS.value
  ),
  // OptiHashi external-compute integration
  OPTIHASHI_API_URL: readOptionalSecret('OPTIHASHI_API_URL', () => Resource.OPTIHASHI_API_URL.value),
  OPTIHASHI_API_TOKEN: readOptionalSecret('OPTIHASHI_API_TOKEN', () => Resource.OPTIHASHI_API_TOKEN.value),
  OPTIHASHI_WEBHOOK_SECRET: readOptionalSecret(
    'OPTIHASHI_WEBHOOK_SECRET',
    () => Resource.OPTIHASHI_WEBHOOK_SECRET.value
  ),
  OPTIHASHI_WEBHOOK_SECRET_PREVIOUS: readOptionalSecret(
    'OPTIHASHI_WEBHOOK_SECRET_PREVIOUS',
    () => Resource.OPTIHASHI_WEBHOOK_SECRET_PREVIOUS.value
  ),
  // Overwatch analytics integration
  OVERWATCH_INGEST_ENABLED: readOptionalSecret(
    'OVERWATCH_INGEST_ENABLED',
    () => Resource.OVERWATCH_INGEST_ENABLED.value
  ),
  OVERWATCH_INGEST_URL: readOptionalSecret('OVERWATCH_INGEST_URL', () => Resource.OVERWATCH_INGEST_URL.value),
  OVERWATCH_INGEST_KEY: readOptionalSecret('OVERWATCH_INGEST_KEY', () => Resource.OVERWATCH_INGEST_KEY.value),
  B4M_ANALYTICS_ENABLED: readOptionalSecret('B4M_ANALYTICS_ENABLED', () => Resource.B4M_ANALYTICS_ENABLED.value),
  OVERWATCH_PSEUDONYM_SALT: readOptionalSecret(
    'OVERWATCH_PSEUDONYM_SALT',
    () => Resource.OVERWATCH_PSEUDONYM_SALT.value
  ),
  STAGE: Resource.App.stage,
} as const;

const isProduction = () => Resource.App.stage === 'production';
// True only for local development, never in deployed environments.
const isDevelopment = () => {
  const isLocal = process.env.IS_LOCAL === 'true';
  const isDevEnv = process.env.NODE_ENV === 'development';
  const isNotDeployedStage = Resource.App.stage !== 'production' && Resource.App.stage !== 'staging';

  return (isLocal || isDevEnv) && isNotDeployedStage;
};

// E2E test endpoint guard - allows /api/test/* on local dev, preview, and staging deployments.
// Set via E2E_ENDPOINTS_ENABLED env var (injected by SST for preview/staging stages) or isDevelopment().
// Explicitly blocks production as defense-in-depth even if E2E_ENDPOINTS_ENABLED is accidentally set.
const isE2EEnabled = () => {
  if (Resource.App.stage === 'production') return false;
  if (process.env.E2E_ENDPOINTS_ENABLED === 'true') return true;
  return isDevelopment();
};

export { Config, isProduction, isDevelopment, isE2EEnabled };
