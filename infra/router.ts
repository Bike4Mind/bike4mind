// Intentional circular dependency: router.ts → waf.ts → wafPolicy.ts, and waf.ts is evaluated
// after router.ts. This is safe because wafWebAcl is only consumed inside the transform.cdn
// callback (lazy evaluation, not at import time). Do NOT access `router` from waf.ts at module
// scope — it would be undefined at that point.
import { wafWebAcl } from './waf';

// const isPermanentStage = ['production', 'dev'].includes($app.stage);

// Preview domain derives from the deployment's SERVER_DOMAIN — no brand fallback
// (issue #9306). Empty when neither PREVIEW_DOMAIN nor SERVER_DOMAIN is set.
const previewDomain = process.env.PREVIEW_DOMAIN || `preview.${process.env.SERVER_DOMAIN ?? ''}`;
export const domain =
  process.env.SERVER_DOMAIN ||
  // If SERVER_DOMAIN is not set, it checks if SEED_STAGE_NAME is set and constructs a domain using it.
  // SEED_STAGE_NAME is typically used in different deployment stages (like 'dev', 'staging', 'prod').
  // If SEED_STAGE_NAME is set, it appends it to 'previewDomain' to form a subdomain.
  ((process.env.SEED_STAGE_NAME || '').length > 0 ? `${process.env.SEED_STAGE_NAME}.${previewDomain}` : undefined);

export function getAllowedOrigins(domain: string | undefined): string[] {
  const origins = ['http://localhost:3000', 'https://localhost:3000'];

  if (domain) {
    origins.push(`https://app.${domain}`);
    origins.push(`https://staging.${domain}`);
  }

  return origins;
}

// const router = isPermanentStage
//   ? new sst.aws.Router('Router', {
//       domain: {
//         name: `app.${domain}`,
//         aliases: [`*.app.${domain}`],
//       },
//     })
//   : sst.aws.Router.get('Router', 'E16LJAOKPV5LK1'); // ID of the Router distribution created in the dev stage.

// Cache policy configuration similar to SST v2's approach
// Environment-specific cache policies with fallback to defaults
const isProd = $app.stage === 'production';

// Get cache policy ID from environment variables with stage-specific fallbacks
const getCachePolicyId = () => {
  if (isProd && process.env.PROD_CACHE_POLICY_ID) {
    return process.env.PROD_CACHE_POLICY_ID;
  }
  if (!isProd && process.env.STAGING_CACHE_POLICY_ID) {
    return process.env.STAGING_CACHE_POLICY_ID;
  }
  return null;
};

// Use existing cache policy ID directly (no SST resource management)
const cachePolicyId = getCachePolicyId();

// Determine if we should use the shared dev router or create/manage our own
// The shared-dev stage has a persistent CloudFront distribution that all developers reference
// to avoid creating new distributions on every dev session
const isSharedDevStage = $app.stage === 'shared-dev';
// Use IS_PREVIEW environment variable (set in CI for preview deployments) instead of regex.
// The shared Router is only for S3 requests for now.
const shouldUseSharedRouter = $dev && !isSharedDevStage && process.env.DEV_ROUTER_DISTRIBUTION_ID;

// True only for personal `sst dev` stages that consume the shared router via
// Router.get(). These stages serve files through the local dev proxy
// (/api/app-files/serve) instead of registering per-stage CloudFront routes.
export const isSharedRouterConsumer = !!shouldUseSharedRouter;

// For shared-dev stage, use the deployment's files.dev.<domain> as the custom domain. The
// domain is account-tied and sourced from SERVER_DOMAIN with no brand fallback (#9310/#9306);
// null when the stage isn't shared-dev or no domain is configured.
const sharedDevDomain = isSharedDevStage && process.env.SERVER_DOMAIN ? `files.dev.${process.env.SERVER_DOMAIN}` : null;

/**
 * Route prefix for shared dev router
 * When using shared router, namespace routes by stage to prevent conflicts
 * Example: /erik/api/ai/v1/tools, /john/api/ai/v1/completions
 */
export const routePrefix = $dev && process.env.DEV_ROUTER_DISTRIBUTION_ID ? `/${$app.stage}` : '';

// Public CDN path prefixes that serve user-uploaded or user-influenced files from S3.
// The base list must mirror resolveProxyTarget in appFileProxy.ts (the allowlist of prefixes
// routed through CloudFront) - i.e. the router.routeBucket(...) registrations in
// infra/buckets.ts PLUS the tavern overlay's /tavern-sounds + /tavern-icons routes
// (contributed via contributeTavernInfra, sst.config.ts) and /whats-new (a separate
// distribution bucket the proxy can't serve, so it's here but absent from resolveProxyTarget).
// KEEP IN SYNC with both; packages/scripts/src/checkUserFileCdnPrefixes.test.ts is the guard.
// routePrefix is baked in so the prefixes are the literal URIs the viewer requests on EVERY
// stage that owns its router - '' on deployed stages, '/<stage>' on `sst dev --stage
// shared-dev` (routeBucket registers `${routePrefix}/generated`, etc.), where a bare
// '/generated/' would never match.
const userFileCdnPrefixes = [
  '/generated/',
  '/proxied-images/',
  '/admin-logos/',
  '/profile-photos/',
  '/org-files/',
  '/tavern-sounds/',
  '/tavern-icons/',
  '/app-config/',
  '/whats-new/',
].map(prefix => `${routePrefix}${prefix}`);

// Same inert-document CSP the self-host proxy sets (apps/client/pages/api/app-files/serve/
// [...key].ts). KEEP THE TWO IN SYNC - both serve these prefixes same-origin with the app.
// allow-downloads keeps legitimate downloads of non-executable generated files (PDF, xlsx)
// working; it grants no script/form/same-origin/popup capability, so the inertness the
// backstop exists for is unchanged.
const USER_FILE_CSP = "default-src 'none'; sandbox allow-downloads";
// Request header stamped in the viewer-REQUEST function to mark a user-file request; read
// back in the viewer-response function (see below). Spoofable but harmless: a spoofed marker
// can only ADD the restrictive CSP to the attacker's own response, never remove it.
const USER_FILE_MARKER_HEADER = 'x-b4m-user-file';

// Defense-in-depth CSP backstop for hosted/CDN-served user files. A user-supplied file
// (an SVG or HTML uploaded as e.g. a profile photo) opened directly at its CDN URL must not
// execute script. SST v4's lazy Router serves every route through ONE routing CloudFront
// Function (viewer-request) plus ONE viewer-response function, with no per-route cache
// behaviors or ResponseHeadersPolicy to attach to. The catch: SST rewrites event.request.uri
// INSIDE the viewer-request function (verified against the SST 4.17.1 Router source), so by
// the viewer-response stage the URI is the rewritten S3 key (e.g. /generated/x -> /x), not
// the public prefix. Matching prefixes at response time would therefore silently miss the
// four rewritten prefixes (/generated, /whats-new, /admin-logos, /org-files) - the very case
// this backstop exists to cover. So we stamp a marker in the viewer-REQUEST injection, which
// SST emits as the FIRST statement of the routing function (before its own rewrite), where
// the URI is still the original prefix; the viewer-response function then keys off that
// marker. The identity prefixes are also matched directly as a fallback, so on deployed
// stages (routePrefix = '') coverage never regresses below the pre-marker behavior even if
// the marker header were dropped in transit. That fallback is dead on `sst dev --stage
// shared-dev`: routePrefix is `/shared-dev`, SST strips it during its rewrite, so the
// response-time URI surfaces bare (e.g. /profile-photos/...) while the fallback compares
// against the routePrefix-baked /shared-dev/profile-photos/. There, the marker is load-bearing.
const userFileMarkerInjection = `
  var __ufUri = event.request.uri;
  var __ufPrefixes = ${JSON.stringify(userFileCdnPrefixes)};
  for (var __ufI = 0; __ufI < __ufPrefixes.length; __ufI++) {
    if (__ufUri.indexOf(__ufPrefixes[__ufI]) === 0) {
      event.request.headers["${USER_FILE_MARKER_HEADER}"] = { value: "1" };
      break;
    }
  }
`;

// Applied ONLY to user-file responses so the SPA (default behavior) and the ALB API routes
// (/api/ai/v1/completions, ...) are left untouched.
const userFileCspInjection = `
  var __cspHit = event.request.headers["${USER_FILE_MARKER_HEADER}"] !== undefined;
  if (!__cspHit) {
    var __cspUri = event.request.uri;
    var __cspPrefixes = ${JSON.stringify(userFileCdnPrefixes)};
    for (var __cspI = 0; __cspI < __cspPrefixes.length; __cspI++) {
      if (__cspUri.indexOf(__cspPrefixes[__cspI]) === 0) { __cspHit = true; break; }
    }
  }
  if (__cspHit) {
    event.response.headers["content-security-policy"] = { value: "${USER_FILE_CSP}" };
    event.response.headers["x-content-type-options"] = { value: "nosniff" };
  }
`;

// Dev-only permissive CORS on every path (unchanged behavior; deployed stages rely on
// per-bucket CORS config instead).
const devCorsInjection = `
  event.response.headers["access-control-allow-origin"] = { value: "*" };
  event.response.headers["access-control-allow-methods"] = { value: "GET, HEAD, OPTIONS, POST, PUT" };
  event.response.headers["access-control-allow-headers"] = { value: "*" };
`;

const routerInstance = shouldUseSharedRouter
  ? sst.aws.Router.get('Router', process.env.DEV_ROUTER_DISTRIBUTION_ID!)
  : new sst.aws.Router('Router', {
      ...(sharedDevDomain
        ? {
            domain: {
              name: sharedDevDomain,
            },
          }
        : domain
          ? {
              domain: {
                name: `app.${domain}`,
                // `*.usercontent.app.${domain}` (Approach B, #9383): published bundles are
                // served from a per-artifact subdomain `{publicId}.usercontent.app.${domain}`
                // so each artifact gets its own browser origin (true artifact-vs-artifact
                // isolation) — same distribution, different host = different SOP origin.
                // It is nested UNDER the app host (`usercontent.app.…`, not `usercontent.…`)
                // on purpose: the auto-provisioned ACM cert's DNS validation record must land
                // in a Route53 hosted zone, and prod only delegates `app.${domain}` into its
                // account — the `${domain}` apex is managed elsewhere, so a bare
                // `*.usercontent.${domain}` has no parent zone and the deploy aborts (#9421).
                // Nesting under `app.` keeps the usercontent wildcard inside the existing
                // `app.${domain}` zone (and the `${stage}.${domain}` zone on other stages),
                // so no extra hosted zone or NS delegation is required.
                // The auto-provisioned ACM cert covers both wildcards (this is the path all
                // bike4mind stages take — app_cert_arn is "" in tenants.yml). When APP_CERT_ARN
                // is supplied (explicit-cert tenants/forks), aliases is undefined here, so the
                // operator MUST add `*.usercontent.app.${domain}` to BOTH the cert SANs AND the
                // distribution's alternate domain names — otherwise the usercontent host 403s
                // and the serve handler (which enables Approach B whenever SERVER_DOMAIN is set)
                // emits a cross-origin iframe to a host that won't load.
                aliases: !!process.env.APP_CERT_ARN ? undefined : [`*.app.${domain}`, `*.usercontent.app.${domain}`],
                dns: !!process.env.APP_CERT_ARN ? false : sst.aws.dns({ override: true }),
                cert: process.env.APP_CERT_ARN || undefined,
              },
            }
          : {}),
      // Attach both edge functions on every stage that owns its router (deployed +
      // shared-dev). The viewer-request function stamps the user-file marker BEFORE SST's URI
      // rewrite; the viewer-response function reads it to apply the CSP backstop, and
      // additionally injects permissive CORS on personal `sst dev` stages.
      edge: {
        viewerRequest: {
          injection: userFileMarkerInjection,
        },
        viewerResponse: {
          injection: userFileCspInjection + ($dev ? devCorsInjection : ''),
        },
      },
      transform: {
        // When reusing an existing cache policy, import it into Pulumi state\
        // This prevents creating a new cache policy and instead references the existing one
        cachePolicy: cachePolicyId
          ? (_args, opts) => {
              // Import the existing cache policy instead of creating a new one
              opts.import = cachePolicyId;
              // CRITICAL: Prevent deletion of the shared cache policy when this stack is destroyed
              // Multiple environments share this policy, so it must not be deleted with any single stack
              opts.retainOnDelete = true;
            }
          : undefined,
        cdn: args => {
          if (cachePolicyId && args.defaultCacheBehavior) {
            args.defaultCacheBehavior = {
              ...args.defaultCacheBehavior,
              cachePolicyId: cachePolicyId,
            };
          }

          // Attach SST-managed WAF if enabled (ENABLE_WAF=true).
          // Uses SST v4's first-class webAclArn property on CdnArgs, which internally
          // maps to the CloudFront webAclId field — no manual transform chaining needed.
          if (wafWebAcl) {
            args.webAclArn = wafWebAcl.arn;
          }

          // Defense-in-depth for the CLI completions SSE drop: raise the origin
          // response (read) timeout on every HTTP/custom origin to the 60s
          // default-allowed max, so CloudFront tolerates longer gaps between
          // streamed bytes during long extended-thinking steps and is never the
          // binding constraint. The PRIMARY fix is the 10s server-side heartbeat
          // in apps/client/server/cli/completions.ts; this just removes
          // CloudFront's 30s default from the equation. S3 origins use
          // s3OriginConfig (no originReadTimeout) and are left untouched. Only
          // applies on stages that own their router (this transform branch);
          // the shared-dev Router.get() path has no transform.
          // args fields are fully resolved (plain) at transform time — SST
          // resolves Inputs before invoking transform.cdn (see the
          // defaultCacheBehavior spread above). Narrow with a localized cast
          // rather than threading Output<> plumbing.
          const origins = args.origins as aws.types.input.cloudfront.DistributionOrigin[] | undefined;
          if (Array.isArray(origins)) {
            args.origins = origins.map(origin =>
              origin.customOriginConfig
                ? { ...origin, customOriginConfig: { ...origin.customOriginConfig, originReadTimeout: 60 } }
                : origin
            );
          }
        },
      },
    });

/**
 * The base URL path for the local dev file proxy.
 * Must match LOCAL_FILE_PROXY_BASE in
 * apps/client/server/utils/appFileProxy.ts — kept in sync so the
 * runtime gate and infra always agree on the same string.
 */
export const LOCAL_FILE_PROXY_BASE = '/api/app-files/serve';

/**
 * `router.url` with any trailing slash removed. Shared by both URL injectors below so the
 * two cannot disagree about what "a bare origin" means - they already did once, which is
 * what this exists to prevent recurring.
 */
function bareOrigin(url: typeof routerInstance.url) {
  return url.apply(u => u.replace(/\/+$/, ''));
}

/**
 * Returns the CDN base URL to inject into Lambda environment variables.
 * Personal `sst dev` stages (DEV_ROUTER_DISTRIBUTION_ID set) use the local
 * proxy; all deployed stages use the real CloudFront distribution URL.
 *
 * Normalized for the same reason as APP_URL (see appUrlForLambdaEnv): consumers treat
 * NEXT_PUBLIC_CDN_URL as an origin and append their own path, so a trailing slash lands
 * as a double slash in every URL built from it. LOCAL_FILE_PROXY_BASE is a literal with
 * no trailing slash, so only the CloudFront arm needs normalizing.
 */
export function cdnUrlForLambdaEnv() {
  return $dev && process.env.DEV_ROUTER_DISTRIBUTION_ID ? LOCAL_FILE_PROXY_BASE : bareOrigin(routerInstance.url);
}

// Export router for other infrastructure to use
export const router = routerInstance;

/**
 * `router.url` with any trailing slash removed, so APP_URL is always a bare origin.
 *
 * `Router.url` can carry a trailing slash. Every consumer of APP_URL treats it as an
 * origin and appends its own path, so the slash is wrong everywhere it lands:
 *
 *   - `csrfProtection` compares it against `new URL(header).origin`, which is always
 *     normalized. A trailing slash makes the allow-list entry unmatchable, so every
 *     state-changing request is rejected while reads keep working.
 *   - `auth.ts` builds OAuth and SAML callback URLs as `APP_URL + '/api/auth/...'`,
 *     producing a double slash. Providers match callback URLs exactly.
 *   - `oauthServer.ts` uses it as the OIDC issuer, where the exact string is a
 *     spec-level identity rather than a formatting detail.
 *
 * Normalizing once here keeps all four injection sites agreeing on one value, rather
 * than each deciding for itself.
 */
export function appUrlForLambdaEnv() {
  return bareOrigin(routerInstance.url);
}

export const whatsNewDistributionId = new sst.Linkable('whatsNewDistributionId', {
  properties: {
    value: router.distributionID,
  },
});

// Explicitly expose the CloudFront distribution ID for backend discovery
// The backend (apps/client/server/security/wafLogsInsights.ts) needs this to query WAF logs
// When using Router.get() (shared dev router), we already know the distribution ID
// When creating a new Router, use SST v4's built-in distributionID property
export const routerDistributionId = new sst.Linkable('RouterDistributionId', {
  properties: {
    id: shouldUseSharedRouter ? process.env.DEV_ROUTER_DISTRIBUTION_ID! : router.distributionID,
  },
});
