import { useConfig } from '@client/app/hooks/data/settings';
import { useCallback } from 'react';

export { getS3Url } from './s3Url';

/**
 * Map S3 key prefixes to CloudFront URL prefixes where they differ.
 * The /organizations bucket route was renamed to /org-files to avoid
 * collision with the /organizations SPA route in Tanstack Router.
 * The /admin/logos bucket route was renamed to /admin-logos to avoid
 * collision with the /admin SPA route in Tanstack Router.
 */
export function toCdnPath(key: string): string {
  // Prefix mapping: if you add/change a prefix here, also update
  // infra/buckets.ts routeBucket and packages/server-utils/src/utils/appFileProxy.ts (resolveProxyTarget allowlist).
  if (key.startsWith('organizations/')) {
    return `org-files/${key.slice('organizations/'.length)}`;
  }
  if (key.startsWith('admin/logos/')) {
    return `admin-logos/${key.slice('admin/logos/'.length)}`;
  }
  return key;
}

/**
 * @deprecated Use useGetAppFileUrl hook instead for runtime config support
 */
export function getAppFileUrl({ key }: { key: string }) {
  return `${process.env.NEXT_PUBLIC_CDN_URL}/${toCdnPath(key)}`;
}

/**
 * Hook that returns a function to get app file URLs using runtime CDN URL
 */
export function useGetAppFileUrl() {
  const { data: config } = useConfig();
  const cdnUrl = config?.cdnUrl || process.env.NEXT_PUBLIC_CDN_URL || '';

  return useCallback(
    ({ key }: { key: string }) => {
      return `${cdnUrl}/${toCdnPath(key)}`;
    },
    [cdnUrl]
  );
}
