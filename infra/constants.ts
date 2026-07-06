export const isPreviewStage = process.env.IS_PREVIEW === 'true' || /^pr\d+$/.test($app.stage);
const isStagingStage = $app.stage === 'dev';
/** Stages that run at full production scale (reserved concurrency, full memory, etc.) */
export const PRODUCTION_STAGES: readonly string[] = ['production', 'dev'];

export const DEFAULT_LAMBDA_ENVIRONMENT = {
  SEED_APP_NAME: $app.name,
  SEED_STAGE_NAME: $app.stage,
  NEXT_PUBLIC_SEED_STAGE_NAME: $app.stage,
  // Account-tied deployment domain, available to every lambda so server code can derive
  // hosts/URLs from it with no brand fallback (issue #9306). Empty when unset.
  // NOTE: APP_URL is NOT set here — it is injected per-construct (see infra/web.ts). Any
  // handler that calls requireEnv('APP_URL') must run in a lambda whose env includes APP_URL.
  SERVER_DOMAIN: process.env.SERVER_DOMAIN || '',
  // Production domain (account-tied, no brand fallback), available on every stage so non-prod
  // jobs that pull config FROM production (see dataSyncerHandler) target the prod host rather
  // than the deploying stage's own domain. Empty when unset.
  PROD_SERVER_DOMAIN: process.env.PROD_SERVER_DOMAIN || '',
  // Brand identity, externalized for open-core (issue #9310). All three carry NO brand
  // fallback — empty when unset — so a fresh clone never ships the "Bike4Mind" literal.
  // APP_NAME: product/display name; WEBSITE_URL: marketing site URL; PLATFORM_EMAIL_DOMAIN:
  // inbound-email recipient domain (e.g. "@app.<domain>"). Operators set these per deploy.
  APP_NAME: process.env.APP_NAME || '',
  WEBSITE_URL: process.env.WEBSITE_URL || '',
  PLATFORM_EMAIL_DOMAIN: process.env.PLATFORM_EMAIL_DOMAIN || '',
  USE_DOCUMENTDB_COMPATIBILITY: process.env.USE_DOCUMENTDB_COMPATIBILITY || '',
  // Account-tied Stripe price ids, externalized for open-core (issue #9306). `next build`
  // inlines the NEXT_PUBLIC_* values into the client bundle, but the Stripe fulfillment
  // handlers run as standalone event-bus Lambdas (infra/eventBus.ts) that read them from
  // process.env at runtime — without these rows the webhook plan lookup silently missed
  // and paid invoices granted no subscription/credits (issue #9971). No brand fallback —
  // empty when unset.
  NEXT_PUBLIC_STRIPE_PRICE_PRO_TEST: process.env.NEXT_PUBLIC_STRIPE_PRICE_PRO_TEST || '',
  NEXT_PUBLIC_STRIPE_PRICE_PRO_PROD: process.env.NEXT_PUBLIC_STRIPE_PRICE_PRO_PROD || '',
  NEXT_PUBLIC_STRIPE_PRICE_LIBONC_TEST: process.env.NEXT_PUBLIC_STRIPE_PRICE_LIBONC_TEST || '',
  NEXT_PUBLIC_STRIPE_PRICE_LIBONC_PROD: process.env.NEXT_PUBLIC_STRIPE_PRICE_LIBONC_PROD || '',
  NEXT_PUBLIC_STRIPE_PRICE_ORG_SUB_TEST: process.env.NEXT_PUBLIC_STRIPE_PRICE_ORG_SUB_TEST || '',
  NEXT_PUBLIC_STRIPE_PRICE_ORG_SUB_PROD: process.env.NEXT_PUBLIC_STRIPE_PRICE_ORG_SUB_PROD || '',
  // Credit-valuation knobs (b4m-core/common/src/pricing.ts). Same dual nature as
  // the Stripe ids above: build-time inlined and runtime-read. Empty == in-source defaults.
  NEXT_PUBLIC_PRICE_MARGIN: process.env.NEXT_PUBLIC_PRICE_MARGIN || '',
  NEXT_PUBLIC_USD_TO_CREDITS_RATE: process.env.NEXT_PUBLIC_USD_TO_CREDITS_RATE || '',
  // Enable What's New modal distribution (S3 upload) for main production only
  // Fork environments should NOT set this - they consume via WHATS_NEW_DISTRIBUTION_URL
  ENABLE_WHATS_NEW_DISTRIBUTION: process.env.ENABLE_WHATS_NEW_DISTRIBUTION || '',
  // Extra SSRF-allowlisted host suffix(es) for the What's New distribution URL (open-core #9392).
  // Comma-separated; no brand fallback (empty == only CloudFront/S3 + SERVER_DOMAIN allowed). Lets
  // a fork pull the upstream feed from a custom domain that isn't CloudFront/S3 or its own host.
  WHATS_NEW_ALLOWED_DISTRIBUTION_HOSTS: process.env.WHATS_NEW_ALLOWED_DISTRIBUTION_HOSTS || '',
  // Enable E2E test endpoints (/api/test/*) on preview and staging deployments
  E2E_ENDPOINTS_ENABLED: isPreviewStage || isStagingStage ? 'true' : '',
  // Suppress punycode deprecation warning (DEP0040) from SST's transitive aws-sdk v2 dependency
  NODE_OPTIONS: '--disable-warning=DEP0040',
};
