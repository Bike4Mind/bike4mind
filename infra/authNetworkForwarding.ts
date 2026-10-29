import { CLOUDFRONT_VIEWER_JA4_HEADER } from '../packages/server-utils/src/utils/trustedClientIpHeaders';

export const AUTH_NETWORK_PATHS = ['/api/auth/*', '/api/otc/*', '/api/oauth/*'] as const;

export const AUTH_NETWORK_HEADERS = [
  'CloudFront-Viewer-Address',
  'CloudFront-Viewer-ASN',
  'CloudFront-Viewer-Country',
  CLOUDFRONT_VIEWER_JA4_HEADER,
];

// CloudFront overwrites supplied JA4 on these behaviors before invoking its request function.
// Ambiguous paths are excluded because CloudFront normalizes paths before selecting a behavior.
export const authNetworkJa4Injection = `
  const authNetworkUri = event.request.uri;
  const authNetworkPrefixes = ${JSON.stringify(AUTH_NETWORK_PATHS.map(path => path.slice(0, -1)))};
  if (authNetworkUri.indexOf('%') !== -1 || authNetworkUri.indexOf('..') !== -1 || authNetworkUri.indexOf('\\\\') !== -1 || !authNetworkPrefixes.some(function(prefix) { return authNetworkUri.indexOf(prefix) === 0; })) {
    delete event.request.headers["${CLOUDFRONT_VIEWER_JA4_HEADER}"];
  }
`;

export function authNetworkCacheBehaviors<Behavior extends object, Policy>(
  defaultBehavior: Behavior,
  originRequestPolicyId: Policy
) {
  return AUTH_NETWORK_PATHS.map(pathPattern => ({ ...defaultBehavior, pathPattern, originRequestPolicyId }));
}
