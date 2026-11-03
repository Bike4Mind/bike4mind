// Intentional circular dependency: router.ts -> waf.ts -> wafPolicy.ts/wafAssociation.ts, and waf.ts is
// evaluated after router.ts. This is safe because wafWebAcl is only consumed inside the transform.cdn
// callback (lazy evaluation, not at import time). Do NOT access `router` from waf.ts at module
// scope — it would be undefined at that point.
import { wafWebAcl } from './waf';
import { allowsUsercontentRequest } from '../packages/server-utils/src/utils/usercontentRequest';
import { isPreviewStage } from './constants';
import {
  USER_FILE_MARKER_HEADER,
  minifyRouterFunction,
  noindexResponseInjection,
  userFileCdnPrefixes as bareUserFileCdnPrefixes,
  userFileCspInjection as userFileCspInjectionFor,
} from './routerFunctionCode';
import { CLOUDFRONT_VIEWER_JA4_HEADER } from '../packages/server-utils/src/utils/trustedClientIpHeaders';

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

// Public CDN path prefixes that serve user-uploaded or user-influenced files from S3 (the list
// itself lives in routerFunctionCode.ts). routePrefix is baked in so the prefixes are the
// literal URIs the viewer requests on EVERY stage that owns its router - '' on deployed
// stages, '/<stage>' on `sst dev --stage shared-dev` (routeBucket registers
// `${routePrefix}/generated`, etc.), where a bare '/generated/' would never match.
const userFileCdnPrefixes = bareUserFileCdnPrefixes.map(prefix => `${routePrefix}${prefix}`);

// Defense-in-depth CSP backstop for hosted/CDN-served user files. A user-supplied file
// (an SVG or HTML uploaded as e.g. a profile photo) opened directly at its CDN URL must not
// execute script. SST v4's lazy Router serves every route through ONE routing CloudFront
// Function (viewer-request) plus ONE viewer-response function, with no per-route cache
// behaviors or ResponseHeadersPolicy to attach to. The catch: SST rewrites event.request.uri
// INSIDE the viewer-request function (verified against the SST 4.17.1 Router source), so by
// the viewer-response stage the URI is the rewritten S3 key (e.g. /generated/x -> /x), not
// the public prefix. Matching prefixes at response time would therefore silently miss the
// three rewritten prefixes (/generated, /admin-logos, /org-files) - the very case
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
  delete event.request.headers["${USER_FILE_MARKER_HEADER}"];
  var __ufUri = event.request.uri;
  var __ufPrefixes = ${JSON.stringify(userFileCdnPrefixes)};
  for (var __ufI = 0; __ufI < __ufPrefixes.length; __ufI++) {
    if (__ufUri.indexOf(__ufPrefixes[__ufI]) === 0) {
      event.request.headers["${USER_FILE_MARKER_HEADER}"] = { value: "1" };
      break;
    }
  }
`;

// Shared secret proving a request came through this distribution: the server function URL and the
// ChatCompletion ALB are public, so apps/client/proxy.ts and
// apps/client/server/chatCompletion/originVerify.ts 403 any request without it (deployed stages
// only, via ORIGIN_VERIFY_SECRET in infra/web.ts and infra/chatCompletion.ts). The assignment
// replaces any inbound value (CloudFront lowercases viewer header names), so a forged header is
// never trusted. The header name must stay in sync with both of those files.
export const ORIGIN_VERIFY_HEADER = 'x-b4m-origin-verify';
// special: false keeps the value alphanumeric, so it is safe inside the JS string literal below.
export const originVerifySecret = new random.RandomPassword('OriginVerifySecret', { length: 48, special: false });
const originVerifyInjection = $interpolate`
  // Drops a viewer-forged copy. AWS docs show computed cloudfront-viewer-* headers already present here,
  // so this may also drop the real JA4: remove it before adding JA4 to the origin request policy.
  delete event.request.headers["${CLOUDFRONT_VIEWER_JA4_HEADER}"];
  event.request.headers["${ORIGIN_VERIFY_HEADER}"] = { value: "${originVerifySecret.result}" };
`;

// Runs before SST routing AND cache lookup, including S3/static and cached SPA responses.
const usercontentGateInjection = `
  var __allowsUsercontentRequest = ${allowsUsercontentRequest.toString()};
  if (!__allowsUsercontentRequest(event.request.headers.host.value, event.request.uri, event.request.method, ${JSON.stringify(domain ?? '')})) {
    return { statusCode: 404, statusDescription: "Not Found", headers: { "cache-control": { value: "no-store" } } };
  }
`;

// Applied ONLY to user-file responses so the SPA (default behavior) and the ALB API routes
// (/api/ai/v1/completions, ...) are left untouched.
const userFileCspInjection = userFileCspInjectionFor(userFileCdnPrefixes);

// Dev-only permissive CORS on every path (unchanged behavior; deployed stages rely on
// per-bucket CORS config instead).
const devCorsInjection = `
  event.response.headers["access-control-allow-origin"] = { value: "*" };
  event.response.headers["access-control-allow-methods"] = { value: "GET, HEAD, OPTIONS, POST, PUT" };
  event.response.headers["access-control-allow-headers"] = { value: "*" };
`;

// SST leaves parts of its generated routing function unminified. With the boundary gates,
// that exceeds CloudFront's 10 KB limit. Transform only this Router's generated request code.
$transform(aws.cloudfront.Function, (args, _opts, name) => {
  if (name !== 'RouterCloudfrontFunctionRequest') return;
  args.code = $output(args.code).apply(minifyRouterFunction);
});

// CloudFront caps functions per account, and every preview's viewer-response code is the same
// (sharedPreviewResponseFunctionCode in routerFunctionCode.ts), so previews attach one
// account-level function the deployer points at instead of each creating its own. Unset keeps
// today's per-stage function; the shared one is never created or deleted by a stage.
const sharedResponseFunctionArn =
  isPreviewStage && !$dev ? process.env.PREVIEW_SHARED_RESPONSE_FUNCTION_ARN || undefined : undefined;

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
      // shared-dev). The viewer-request function stamps the origin-verify secret and the
      // user-file marker BEFORE SST's URI rewrite; the viewer-response function reads the
      // marker to apply the CSP backstop, adds x-robots-tag noindex on every non-production
      // stage, and additionally injects permissive CORS on personal `sst dev` stages.
      // Previews on the shared response function get it attached in transform.cdn below.
      edge: {
        viewerRequest: {
          injection: $interpolate`${usercontentGateInjection}${originVerifyInjection}${userFileMarkerInjection}`,
        },
        ...(sharedResponseFunctionArn
          ? {}
          : {
              viewerResponse: {
                injection: userFileCspInjection + noindexResponseInjection($app.stage) + ($dev ? devCorsInjection : ''),
              },
            }),
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

          // With edge.viewerResponse absent SST emits only the viewer-request association;
          // append the shared function rather than replacing the list.
          if (sharedResponseFunctionArn && args.defaultCacheBehavior) {
            const behavior = args.defaultCacheBehavior as aws.types.input.cloudfront.DistributionDefaultCacheBehavior;
            args.defaultCacheBehavior = {
              ...behavior,
              functionAssociations: $output(behavior.functionAssociations ?? []).apply(associations => [
                ...associations,
                { eventType: 'viewer-response', functionArn: sharedResponseFunctionArn },
              ]),
            };
          }

          // Attach the WAF if enabled (ENABLE_WAF=true): the stage-owned ACL, or the
          // externally managed one looked up by name.
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
 * packages/server-utils/src/utils/appFileProxy.ts - kept in sync so the
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
 * Normalizing once here keeps every injection site agreeing on one value, rather
 * than each deciding for itself.
 */
export function appUrlForLambdaEnv() {
  return bareOrigin(routerInstance.url);
}

// Explicitly expose the CloudFront distribution ID for backend discovery
// The backend (apps/client/server/security/wafLogsInsights.ts) needs this to query WAF logs
// When using Router.get() (shared dev router), we already know the distribution ID
// When creating a new Router, use SST v4's built-in distributionID property
export const routerDistributionId = new sst.Linkable('RouterDistributionId', {
  properties: {
    id: shouldUseSharedRouter ? process.env.DEV_ROUTER_DISTRIBUTION_ID! : router.distributionID,
  },
});
