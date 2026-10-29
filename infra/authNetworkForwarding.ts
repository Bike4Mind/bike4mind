import { CLOUDFRONT_VIEWER_JA4_HEADER } from '../packages/server-utils/src/utils/trustedClientIpHeaders';

export const AUTH_NETWORK_PATHS = ['/api/auth/*', '/api/otc/*', '/api/oauth/*'] as const;

export const AUTH_NETWORK_HEADERS = [
  'CloudFront-Viewer-Address',
  'CloudFront-Viewer-ASN',
  'CloudFront-Viewer-Country',
  CLOUDFRONT_VIEWER_JA4_HEADER,
];

export function authNetworkCacheBehaviors<Behavior extends object, Policy>(
  defaultBehavior: Behavior,
  originRequestPolicyId: Policy
) {
  return AUTH_NETWORK_PATHS.map(pathPattern => ({ ...defaultBehavior, pathPattern, originRequestPolicyId }));
}
