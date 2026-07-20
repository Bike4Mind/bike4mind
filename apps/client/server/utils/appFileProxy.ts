/**
 * Maps a CDN request path (the part after `/api/app-files/serve/`) to the S3
 * bucket and key it should be read from.
 *
 * PARITY: this is the inverse of the `router.routeBucket(...)` rewrites in
 * infra/buckets.ts (and of toCdnPath in apps/client/app/utils/s3.ts). If a
 * rewrite is added/changed there, update this mapping in lockstep.
 * The allowlist below must mirror the routeBucket prefixes exactly - only
 * prefixes routed through CloudFront are reachable here.
 */

/**
 * The base URL path for the local dev file proxy.
 * Infra sets NEXT_PUBLIC_CDN_URL to this string for personal `sst dev` stages
 * (DEV_ROUTER_DISTRIBUTION_ID set). Must stay in sync with infra/router.ts
 * LOCAL_FILE_PROXY_BASE.
 */
export const LOCAL_FILE_PROXY_BASE = '/api/app-files/serve';

export type ProxyTarget = { bucket: 'appFiles' | 'generated'; key: string };

export function resolveProxyTarget(cdnPath: string): ProxyTarget | null {
  if (cdnPath.startsWith('generated/')) {
    // infra: generated -> generatedImagesBucket with `^/generated/(.*)$` -> `/$1`
    return { bucket: 'generated', key: cdnPath.slice('generated/'.length) };
  }
  if (cdnPath.startsWith('org-files/')) {
    // infra: org-files -> appFilesBucket with `^/org-files/(.*)$` -> `/organizations/$1`
    return { bucket: 'appFiles', key: `organizations/${cdnPath.slice('org-files/'.length)}` };
  }
  if (cdnPath.startsWith('proxied-images/')) {
    return { bucket: 'appFiles', key: cdnPath };
  }
  if (cdnPath.startsWith('admin-logos/')) {
    // infra: admin-logos -> appFilesBucket with `^/admin-logos/(.*)$` -> `/admin/logos/$1`
    return { bucket: 'appFiles', key: `admin/logos/${cdnPath.slice('admin-logos/'.length)}` };
  }
  if (cdnPath.startsWith('profile-photos/')) {
    return { bucket: 'appFiles', key: cdnPath };
  }
  if (cdnPath.startsWith('tavern-sounds/')) {
    return { bucket: 'appFiles', key: cdnPath };
  }
  if (cdnPath.startsWith('tavern-icons/')) {
    return { bucket: 'appFiles', key: cdnPath };
  }
  if (cdnPath.startsWith('app-config/')) {
    return { bucket: 'appFiles', key: cdnPath };
  }
  // `whats-new/` is intentionally NOT allowlisted: it routes to
  // whatsNewDistributionBucket (a separate distribution bucket), not
  // appFilesBucket, so the proxy cannot serve it.
  // Not an allowlisted prefix - block.
  return null;
}
