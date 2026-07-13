export const secrets = {
  MONGODB_URI: new sst.Secret('MONGODB_URI', 'my-secret-placeholder-value'),
  SESSION_SECRET: new sst.Secret('SESSION_SECRET', 'my-secret-placeholder-value'),
  JWT_SECRET: new sst.Secret('JWT_SECRET', 'my-secret-placeholder-value'),
  SLACK_WEBHOOK_URL: new sst.Secret('SLACK_WEBHOOK_URL', 'not-configured'),
  SLACK_ERROR_REPORTING_WEBHOOK_URL: new sst.Secret('SLACK_ERROR_REPORTING_WEBHOOK_URL', 'not-configured'),
  GOOGLE_CLIENT_ID: new sst.Secret('GOOGLE_CLIENT_ID', 'not-configured'),
  GOOGLE_CLIENT_SECRET: new sst.Secret('GOOGLE_CLIENT_SECRET', 'not-configured'),
  GITHUB_CLIENT_ID: new sst.Secret('GITHUB_CLIENT_ID', 'not-configured'),
  GITHUB_CLIENT_SECRET: new sst.Secret('GITHUB_CLIENT_SECRET', 'not-configured'),
  STRIPE_SECRET_KEY: new sst.Secret('STRIPE_SECRET_KEY', 'not-configured'),
  STRIPE_PUBLISHABLE_KEY: new sst.Secret('STRIPE_PUBLISHABLE_KEY', 'not-configured'),
  STRIPE_WEBHOOK_SECRET: new sst.Secret('STRIPE_WEBHOOK_SECRET', 'not-configured'),
  SUPPORT_EMAIL: new sst.Secret('SUPPORT_EMAIL', 'not-configured'),
  MAIL_FROM: new sst.Secret('MAIL_FROM', 'not-configured'),
  MAIL_HOST: new sst.Secret('MAIL_HOST', 'not-configured'),
  MAIL_PORT: new sst.Secret('MAIL_PORT', 'not-configured'),
  MAIL_USERNAME: new sst.Secret('MAIL_USERNAME', 'not-configured'),
  MAIL_PASSWORD: new sst.Secret('MAIL_PASSWORD', 'not-configured'),
  ANTHROPIC_API_KEY: new sst.Secret('ANTHROPIC_API_KEY', 'not-configured'),
  GEMINI_API_KEY: new sst.Secret('GEMINI_API_KEY', 'not-configured'),
  OKTA_AUDIENCE: new sst.Secret('OKTA_AUDIENCE', 'not-configured'),
  OKTA_CLIENT_ID: new sst.Secret('OKTA_CLIENT_ID', 'not-configured'),
  OKTA_CLIENT_SECRET: new sst.Secret('OKTA_CLIENT_SECRET', 'not-configured'),
  // When 'true', SST-sourced Okta config uses the org-level auth server directly
  // instead of the custom /oauth2/default path. Lets a stage whose tenant has no
  // custom auth server (e.g. trial orgs) skip the doomed custom discovery — and the
  // ERROR it logs on every cold start before the in-memory org-level demotion kicks
  // in (#9000 / #9176 follow-up). Defaults 'false' to preserve existing behavior.
  OKTA_USE_ORG_AUTH_SERVER: new sst.Secret('OKTA_USE_ORG_AUTH_SERVER', 'false'),
  NPM_TOKEN: new sst.Secret('NPM_TOKEN', 'not-configured'),
  SLACK_SIGNING_SECRET: new sst.Secret('SLACK_SIGNING_SECRET', 'not-configured'),
  SLACK_APP_ID: new sst.Secret('SLACK_APP_ID', 'not-configured'),
  B4M_PROD_API_KEY: new sst.Secret('B4M_PROD_API_KEY', 'not-configured'),
  SLACK_CLIENT_ID: new sst.Secret('SLACK_CLIENT_ID', 'not-configured'),
  SLACK_CLIENT_SECRET: new sst.Secret('SLACK_CLIENT_SECRET', 'not-configured'),
  SLACK_OAUTH_REDIRECT_URI: new sst.Secret('SLACK_OAUTH_REDIRECT_URI', 'not-configured'),
  // Secret encryption key for encrypting secrets stored in database (AES-256-GCM)
  // Generate with: openssl rand -hex 32
  SECRET_ENCRYPTION_KEY: new sst.Secret('SECRET_ENCRYPTION_KEY', 'my-secret-placeholder-value'),
  // Previous encryption key for key rotation — set this to the old key when rotating
  SECRET_ENCRYPTION_KEY_PREVIOUS: new sst.Secret('SECRET_ENCRYPTION_KEY_PREVIOUS', 'not-configured'),
  // Shared-secret bearer authenticating the frontend's internal /process dispatch to the
  // always-on ChatCompletion service (see server/utils/dispatchQuest.ts +
  // server/chatCompletion/internal/route.ts). Dedicated so the AES encryption key
  // (SECRET_ENCRYPTION_KEY) is never presented as a network auth token. Rotate freely.
  // Generate with: openssl rand -hex 32
  CHAT_COMPLETION_INTERNAL_SECRET: new sst.Secret('CHAT_COMPLETION_INTERNAL_SECRET', 'my-secret-placeholder-value'),
  // Secrets for Website Security (OWASP ZAP) integration
  // Configure these per environment using `sst secret set` and mirror them
  // into the corresponding GitHub environment secrets.
  SECOPS_ZAP_DISPATCH_TOKEN: new sst.Secret('SECOPS_ZAP_DISPATCH_TOKEN', 'not-configured'),
  SECOPS_ZAP_INGEST_TOKEN: new sst.Secret('SECOPS_ZAP_INGEST_TOKEN', 'not-configured'),
  GITHUB_ZAP_REF: new sst.Secret('GITHUB_ZAP_REF', 'main'),
  // Secrets for Code Analysis (Semgrep) integration
  // Configure these per environment using `sst secret set` and mirror them
  // into the corresponding GitHub environment secrets.
  SECOPS_CODE_INGEST_URL: new sst.Secret('SECOPS_CODE_INGEST_URL', 'not-configured'),
  SECOPS_CODE_INGEST_TOKEN: new sst.Secret('SECOPS_CODE_INGEST_TOKEN', 'not-configured'),
  // Secrets for Packages / Dependencies security integration
  // Configure these per environment using `sst secret set` and mirror them
  // into the corresponding GitHub environment secrets.
  SECOPS_PACKAGES_INGEST_URL: new sst.Secret('SECOPS_PACKAGES_INGEST_URL', 'not-configured'),
  SECOPS_PACKAGES_INGEST_TOKEN: new sst.Secret('SECOPS_PACKAGES_INGEST_TOKEN', 'not-configured'),
  SECOPS_PACKAGES_DISPATCH_TOKEN: new sst.Secret('SECOPS_PACKAGES_DISPATCH_TOKEN', 'not-configured'),
  // Secrets for Secrets / Password & Key Protection integration
  // Configure these per environment using `sst secret set` and mirror them
  // into the corresponding GitHub environment secrets.
  SECOPS_SECRETS_INGEST_URL: new sst.Secret('SECOPS_SECRETS_INGEST_URL', 'not-configured'),
  SECOPS_SECRETS_INGEST_TOKEN: new sst.Secret('SECOPS_SECRETS_INGEST_TOKEN', 'not-configured'),
  SECOPS_SECRETS_DISPATCH_TOKEN: new sst.Secret('SECOPS_SECRETS_DISPATCH_TOKEN', 'not-configured'),
  // Secrets for Cloud Security (Prowler) integration
  // Configure these per environment using `sst secret set` and mirror them
  // into the corresponding GitHub environment secrets.
  SECOPS_PROWLER_INGEST_TOKEN: new sst.Secret('SECOPS_PROWLER_INGEST_TOKEN', 'not-configured'),
  // GitHub PAT (workflow scope) used to dispatch the prowler-only.yml workflow on demand.
  // Scope required: workflow. Generate at https://github.com/settings/tokens
  SECOPS_PROWLER_WORKFLOW_TOKEN: new sst.Secret('SECOPS_PROWLER_WORKFLOW_TOKEN', 'not-configured'),
  // Secrets for Firewall / WAF Security Dashboard integration
  // Explicit WebACL ARNs and CloudFront distribution IDs; can be comma-separated lists.
  SECOPS_WAF_WEBACL_ARN: new sst.Secret('SECOPS_WAF_WEBACL_ARN', 'not-configured'),
  SECOPS_WAF_DISTRIBUTION_ID: new sst.Secret('SECOPS_WAF_DISTRIBUTION_ID', 'not-configured'),
  // Secret for Active Defense (in-product attack simulation) ingest endpoint.
  // Set per stage: sst secret set SECOPS_ATTACK_SIMULATION_INGEST_TOKEN <value> --stage <stage>
  SECOPS_ATTACK_SIMULATION_INGEST_TOKEN: new sst.Secret('SECOPS_ATTACK_SIMULATION_INGEST_TOKEN', 'not-configured'),
  // What's New distribution URL for fork/staging environments to sync modals from production
  // Only set this for non-production environments (dev, staging, forks)
  // Production generates modals and doesn't need this
  // Preview environments use placeholder - runtime checks for valid https:// URL
  WHATS_NEW_DISTRIBUTION_URL: new sst.Secret('WHATS_NEW_DISTRIBUTION_URL', 'not-configured'),
  // Identifies main/source deployments (bike4mind staging + production)
  // Set to 'true' on main staging (dev stage) and main production to enable source-only features
  // Fork deployments should NOT have this set (defaults to 'false')
  // Used by: LiveOps Triage tab visibility (hides from forks)
  IS_SOURCE_DEPLOYMENT: new sst.Secret('IS_SOURCE_DEPLOYMENT', 'false'),
  // Shared secret for authenticating rate limit ingest requests from MCP Lambda
  RATE_LIMIT_INGEST_TOKEN: new sst.Secret('RATE_LIMIT_INGEST_TOKEN', 'not-configured'),
  // RSA private key for signing OIDC ID tokens (RS256). Base64-encoded PEM.
  // Generate with: openssl genrsa 2048 | base64 | tr -d '\n'
  // If not set, an ephemeral key is generated at runtime (dev only — NOT safe for production).
  OAUTH_RSA_PRIVATE_KEY: new sst.Secret('OAUTH_RSA_PRIVATE_KEY', 'not-configured'),
  // Shared secret for E2E test endpoints (/api/test/create-user, /api/test/cleanup)
  // Set per stage: sst secret set E2E_CLEANUP_SECRET <value> --stage <stage>
  E2E_CLEANUP_SECRET: new sst.Secret('E2E_CLEANUP_SECRET', 'not-configured'),
  // Feature flag for the break-glass emergency-login endpoint.
  // Endpoint returns 404 by default — set to 'true' to activate during an OAuth outage.
  // Set per stage: sst secret set EMERGENCY_LOGIN_ENABLED "true" --stage <stage>
  EMERGENCY_LOGIN_ENABLED: new sst.Secret('EMERGENCY_LOGIN_ENABLED', 'false'),
  // Overwatch — Google Analytics Data API service account key (base64-encoded JSON)
  GA_SERVICE_ACCOUNT_KEY: new sst.Secret('GA_SERVICE_ACCOUNT_KEY', 'not-configured'),
  // Overwatch — Workspace email to impersonate via domain-wide delegation for GA access
  GA_IMPERSONATE_SUBJECT: new sst.Secret('GA_IMPERSONATE_SUBJECT', 'not-configured'),
  // Overwatch — YouTube Data API v3 key for public channel subscriber counts (Phase 0)
  // Generate an API key (not service account) in GCP restricted to YouTube Data API v3.
  // YouTube OAuth CLIENT_ID/SECRET are deferred to Phase 2 (#8078).
  YOUTUBE_API_KEY: new sst.Secret('YOUTUBE_API_KEY', 'not-configured'),
  // Overwatch — LinkedIn OAuth app credentials for token refresh and follower counts
  // Note: r_organization_social scope may require LinkedIn partner program approval.
  // End-to-end token refresh requires OAuth callback routes in #8079.
  LINKEDIN_CLIENT_ID: new sst.Secret('LINKEDIN_CLIENT_ID', 'not-configured'),
  LINKEDIN_CLIENT_SECRET: new sst.Secret('LINKEDIN_CLIENT_SECRET', 'not-configured'),
  // OptiHashi external-compute integration
  OPTIHASHI_API_URL: new sst.Secret('OPTIHASHI_API_URL', 'not-configured'),
  OPTIHASHI_API_TOKEN: new sst.Secret('OPTIHASHI_API_TOKEN', 'not-configured'),
  OPTIHASHI_WEBHOOK_SECRET: new sst.Secret('OPTIHASHI_WEBHOOK_SECRET', 'not-configured'),
  // Previous webhook secret for zero-downtime key rotation; set to old value when rotating
  OPTIHASHI_WEBHOOK_SECRET_PREVIOUS: new sst.Secret('OPTIHASHI_WEBHOOK_SECRET_PREVIOUS', 'not-configured'),
  // External instance-service (internal Fargate) — URL + bearer token, subscriber-fanout
  // pattern. 'not-configured' disables consumption (the consumer degrades gracefully).
  INSTANCE_SERVICE_URL: new sst.Secret('INSTANCE_SERVICE_URL', 'not-configured'),
  INSTANCE_SERVICE_TOKEN: new sst.Secret('INSTANCE_SERVICE_TOKEN', 'not-configured'),
  // Previous token for zero-downtime rotation; set to old value when rotating.
  INSTANCE_SERVICE_TOKEN_PREVIOUS: new sst.Secret('INSTANCE_SERVICE_TOKEN_PREVIOUS', 'not-configured'),
  // Overwatch HTTP ingest kill switch. Default 'true' (enabled).
  // Set to 'false' to disable the POST /api/overwatch/v1/events endpoint.
  // Per-stage. Flipping takes effect on next Lambda cold-start (~10-30min under traffic).
  // Force propagation: deploy a no-op commit, or cycle reserved concurrency in AWS Console.
  OVERWATCH_INGEST_ENABLED: new sst.Secret('OVERWATCH_INGEST_ENABLED', 'true'),
  // b4m → Overwatch analytics ingest. b4m is a client of the Overwatch HTTP ingest endpoint;
  // all three values are set per-stage via `sst secret set` (prod: --profile bike4mind-prod).
  // Migration to standalone Overwatch = repoint OVERWATCH_INGEST_URL + re-mint key. Zero code change.
  OVERWATCH_INGEST_URL: new sst.Secret('OVERWATCH_INGEST_URL', 'not-configured'),
  OVERWATCH_INGEST_KEY: new sst.Secret('OVERWATCH_INGEST_KEY', 'not-configured'),
  // b4m-side kill switch for analytics emission. Set to 'false' to silence emission without
  // touching the receiver. Separate from OVERWATCH_INGEST_ENABLED (receiver-side).
  B4M_ANALYTICS_ENABLED: new sst.Secret('B4M_ANALYTICS_ENABLED', 'true'),
  // Permanent HMAC salt for pseudonymizing user._id before sending to Overwatch.
  // ⚠️  NEVER ROTATE — rotating re-pseudonymizes all users, breaks UserDay dedup, and resets
  //     retention history. Set once per stage and leave it. The ingest key rotates freely; this does not.
  // Generate: openssl rand -hex 32
  OVERWATCH_PSEUDONYM_SALT: new sst.Secret('OVERWATCH_PSEUDONYM_SALT', 'not-configured'),
};

export const allSecrets = Object.values(secrets);
