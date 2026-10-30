// The origin of a configured URL, or '' when it is unset or unsafe to place in a CSP source list.
function cspSafeOrigin(raw: string | undefined, name: string, protocols: readonly string[]): string {
  const configured = raw?.trim();
  if (!configured) return '';
  try {
    if (
      /[\s;]/.test(configured) ||
      [...configured].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    ) {
      throw new Error('Invalid endpoint');
    }
    const url = new URL(configured);
    if (!protocols.includes(url.protocol)) throw new Error('Unsupported protocol');
    if (/[\s;,'"*\\]/.test(url.origin)) throw new Error('Invalid origin');
    return url.origin;
  } catch {
    console.warn(`[csp] ignoring invalid ${name}`);
    return '';
  }
}

/**
 * The browser-reachable origin of the S3-compatible object store (self-host MinIO), or '' when
 * S3_PRESIGN_ENDPOINT is unset or unsafe to place in a CSP source list.
 */
export function resolveObjectStoreOrigin(raw: string | undefined): string {
  return cspSafeOrigin(raw, 'S3_PRESIGN_ENDPOINT', ['http:', 'https:']);
}

/**
 * The origin of the upstream What's New feed (WHATS_NEW_FEED_URL), whose notes' uploaded videos play from
 * its media route (server/releaseNotes/publicMedia.ts); '' when unset, not https, or unsafe.
 */
export function resolveWhatsNewUpstreamOrigin(raw: string | undefined): string {
  return cspSafeOrigin(raw, 'WHATS_NEW_FEED_URL', ['https:']);
}

/** The deployment's own files subdomain, derived from SERVER_DOMAIN; '' when unconfigured. */
export function resolveFilesOrigin(serverDomain: string | undefined): string {
  return serverDomain ? `https://files.dev.${serverDomain}` : '';
}

/**
 * Deployment-specific media origins the CSP in apps/client/proxy.ts adds to media-src and img-src.
 * Modal video validation accepts the same ones so a self-host store URL is not rejected.
 */
export function deploymentMediaOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  return [resolveObjectStoreOrigin(env.S3_PRESIGN_ENDPOINT), resolveFilesOrigin(env.SERVER_DOMAIN)].filter(Boolean);
}
