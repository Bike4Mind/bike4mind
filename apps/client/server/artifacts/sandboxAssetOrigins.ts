import type { IncomingHttpHeaders } from 'http';
import { resolveDocOrigin } from '@bike4mind/server-utils/services/publish/viewerSecurity';
import { Logger } from '@bike4mind/observability';

const logger = new Logger({ metadata: { service: 'sandboxAssetOrigins' } });

/** Space-separated origins a sandbox may load images and media from: the app host plus the https CDN. */
export function buildSandboxAssetOrigins(headers: IncomingHttpHeaders): string {
  const assetOrigins = [resolveDocOrigin(headers.host, headers['x-forwarded-proto'])];
  const cdn = process.env.NEXT_PUBLIC_CDN_URL;
  if (cdn && !cdn.startsWith('/')) {
    try {
      const url = new URL(cdn);
      if (url.protocol === 'https:' && !/[\s;,'"*\\]/.test(url.origin)) assetOrigins.push(url.origin);
    } catch {
      logger.warn('Ignoring invalid CDN URL');
    }
  }
  return [...new Set(assetOrigins)].join(' ');
}
