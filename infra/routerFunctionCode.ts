import { transformSync } from 'esbuild';

const CLOUDFRONT_FUNCTION_MAX_BYTES = 10_240;

export function minifyRouterFunction(code: string): string {
  // Preserve CloudFront's handler name and SST's identifiers; remove formatting and comments.
  const minified = transformSync(code, {
    minifyWhitespace: true,
    minifySyntax: true,
    minifyIdentifiers: false,
    legalComments: 'none',
    // Match SST's compiler target so minification cannot introduce unsupported edge syntax.
    target: 'es2018',
  }).code;
  const size = Buffer.byteLength(minified, 'utf8');
  if (size > CLOUDFRONT_FUNCTION_MAX_BYTES) {
    throw new Error(`Router CloudFront function is ${size} bytes; maximum is ${CLOUDFRONT_FUNCTION_MAX_BYTES}`);
  }
  return minified;
}

export const NOINDEX_HEADER_VALUE = 'noindex, nofollow';

// CloudFront skips viewer-response functions for origin errors and viewer-request responses.
// Empty on production so its generated function stays byte-identical.
export function noindexResponseInjection(stage: string): string {
  if (stage === 'production') return '';
  return `
  event.response.headers["x-robots-tag"] = { value: "${NOINDEX_HEADER_VALUE}" };
`;
}

// Public CDN path prefixes that serve user-uploaded or user-influenced files from S3.
// The list must mirror resolveProxyTarget in appFileProxy.ts (the allowlist of prefixes
// routed through CloudFront) - i.e. the router.routeBucket(...) registrations in
// infra/buckets.ts PLUS the tavern overlay's /tavern-sounds + /tavern-icons routes
// (contributed via contributeTavernInfra, sst.config.ts).
// KEEP IN SYNC with both; packages/scripts/src/checkUserFileCdnPrefixes.test.ts is the guard.
// Bare prefixes: router.ts bakes routePrefix in per stage.
export const userFileCdnPrefixes = [
  '/generated/',
  '/proxied-images/',
  '/admin-logos/',
  '/profile-photos/',
  '/org-files/',
  '/tavern-sounds/',
  '/tavern-icons/',
  '/app-config/',
];

// Same inert-document CSP the self-host proxy sets (apps/client/pages/api/app-files/serve/
// [...key].ts). KEEP THE TWO IN SYNC - both serve these prefixes same-origin with the app.
// allow-downloads keeps legitimate downloads of non-executable generated files (PDF, xlsx)
// working; it grants no script/form/same-origin/popup capability, so the inertness the
// backstop exists for is unchanged.
export const USER_FILE_CSP = "default-src 'none'; sandbox allow-downloads";
// Request header stamped in the viewer-REQUEST function to mark a user-file request; read
// back in the viewer-response function. Any inbound value is cleared before the prefix check
// so the marker stays function-owned, not client-settable.
export const USER_FILE_MARKER_HEADER = 'x-b4m-user-file';

// Applied ONLY to user-file responses so the SPA (default behavior) and the ALB API routes
// (/api/ai/v1/completions, ...) are left untouched. `prefixes` are the literal URIs the
// viewer requests on the stage (routePrefix already applied).
export function userFileCspInjection(prefixes: string[]): string {
  return `
  var __cspHit = event.request.headers["${USER_FILE_MARKER_HEADER}"] !== undefined;
  if (!__cspHit) {
    var __cspUri = event.request.uri;
    var __cspPrefixes = ${JSON.stringify(prefixes)};
    for (var __cspI = 0; __cspI < __cspPrefixes.length; __cspI++) {
      if (__cspUri.indexOf(__cspPrefixes[__cspI]) === 0) { __cspHit = true; break; }
    }
  }
  if (__cspHit) {
    event.response.headers["content-security-policy"] = { value: "${USER_FILE_CSP}" };
    event.response.headers["x-content-type-options"] = { value: "nosniff" };
  }
`;
}

// The same wrapper SST's Router puts around `edge.viewerResponse.injection` (cloudfront-js-2.0).
export function responseFunctionCode(injection: string): string {
  return `
import cf from "cloudfront";
async function handler(event) {
  ${injection}
  return event.response;
}`;
}

// Code of the one viewer-response function every preview stage in an account shares instead of
// creating its own (CloudFront caps functions per account). It must equal what a preview's own
// function would hold: the CSP backstop with bare prefixes (routePrefix is '' on deployed stages)
// plus noindex, which is the same on every non-production stage. The function itself is owned by
// OpenTofu in the infrastructure repo, which vendors this output; regenerate it whenever this changes.
export function sharedPreviewResponseFunctionCode(): string {
  return responseFunctionCode(userFileCspInjection(userFileCdnPrefixes) + noindexResponseInjection('preview'));
}
