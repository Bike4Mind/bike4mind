import { randomUUID } from 'crypto';
import { CloudFrontClient, CreateInvalidationCommand } from '@aws-sdk/client-cloudfront';
import { resolveRouterDistributionId } from '../../security/wafSharedHelpers';
import { appFileKeyToCdnPath, resolveProxyTarget } from '../../utils/appFileProxy';
import type { MinimalLogger } from '../publish/minimalLogger';

/**
 * CloudFront invalidation on the Router distribution, which serves `/p/*`, `/generated/*` and the
 * app-file prefixes. Best-effort throughout: a failed invalidation is logged and never thrown, so
 * it cannot fail the delete that triggered it. The frontend lambda and the account-deletion sweep
 * already hold `cloudfront:CreateInvalidation` on this distribution (infra/web.ts, infra/cron.ts).
 */

const cfClient = new CloudFrontClient({});

// CloudFront takes at most 1,000 paths per request and 3,000 exact paths in flight per
// distribution across all callers (publish takedowns included), and its rejection
// (TooManyInvalidationsInProgress) is only logged here. One request stays at a third of that; a
// larger set is coalesced into per-prefix wildcards instead (see invalidateRouterPaths).
export const MAX_PATHS_PER_BATCH = 1000;
const MAX_LOGGED_PATHS = 10;

export interface InvalidationLogOptions {
  /** Log prefix, e.g. `[PUBLISH]`. */
  logTag: string;
  /** CallerReference prefix; must keep requests from different callers distinct. */
  referencePrefix: string;
  logger?: MinimalLogger;
}

/**
 * The Router distribution id, or undefined when the resource isn't linked (local/test) so
 * invalidation no-ops. A malformed id also lands here, so warn rather than swallow silently.
 */
export function getRouterDistributionId(logTag: string, logger?: MinimalLogger): string | undefined {
  try {
    return resolveRouterDistributionId();
  } catch (err) {
    logger?.warn(`${logTag} CDN invalidation skipped - ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

export async function sendInvalidation(
  distributionId: string,
  label: string,
  paths: string[],
  { logTag, referencePrefix, logger }: InvalidationLogOptions
): Promise<boolean> {
  try {
    await cfClient.send(
      new CreateInvalidationCommand({
        DistributionId: distributionId,
        InvalidationBatch: {
          CallerReference: `${referencePrefix}-${label}-${Date.now()}-${randomUUID()}`,
          Paths: { Quantity: paths.length, Items: paths },
        },
      })
    );
    const detail = paths.length <= MAX_LOGGED_PATHS ? paths.join(', ') : `${paths.length} paths`;
    logger?.info(`${logTag} CDN invalidation issued for ${label}: ${detail}`);
    return true;
  } catch (err) {
    logger?.warn(`${logTag} CDN invalidation failed for ${label}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/**
 * Invalidate exact Router paths in one request. Caller wildcards are dropped: CloudFront allows only
 * a handful in flight per distribution, shared with publish takedowns. A set over
 * MAX_PATHS_PER_BATCH becomes one `/<first segment>/*` wildcard per prefix, so a large purge spends
 * a few wildcard slots rather than the shared exact-path quota; callers that need exact paths keep
 * each flush within MAX_PATHS_PER_BATCH. Never throws.
 */
export async function invalidateRouterPaths(
  paths: string[],
  { label, logger }: { label: string; logger?: MinimalLogger }
): Promise<void> {
  const exact = [...new Set(paths.filter(p => p.startsWith('/') && !p.includes('*')))];
  if (exact.length === 0) return;
  const logTag = '[CDN]';
  const distributionId = getRouterDistributionId(logTag, logger);
  if (!distributionId) return;
  let batch = exact;
  if (exact.length > MAX_PATHS_PER_BATCH) {
    batch = [...new Set(exact.map(p => `/${p.split('/')[1]}/*`))];
    logger?.warn(
      `${logTag} ${exact.length} paths exceed one ${MAX_PATHS_PER_BATCH}-path request for ${label}; invalidating ${batch.join(', ')}`
    );
  }
  await sendInvalidation(distributionId, label, batch, { logTag, referencePrefix: 'media', logger });
}

export interface CdnInvalidationBatch {
  add: (path: string | null | undefined) => void;
  flush: () => Promise<void>;
}

/** Collects paths across a bulk delete so they go out in as few CreateInvalidation requests as possible. */
export function createCdnInvalidationBatch(label: string, logger?: MinimalLogger): CdnInvalidationBatch {
  const paths = new Set<string>();
  return {
    add: path => {
      if (path) paths.add(path);
    },
    flush: async () => {
      const pending = [...paths];
      paths.clear();
      await invalidateRouterPaths(pending, { label, logger });
    },
  };
}

/** CDN path of a generated-images bucket object (served at `/generated/<key>`). */
export function generatedCdnPath(key: string): string {
  return `/generated/${encodeURI(key)}`;
}

/**
 * CDN path of an app-files bucket object, or null when the key is not served through a Router
 * prefix (e.g. bare-uuid file keys, which are only reachable through signed URLs).
 */
export function appFileCdnPath(key: string): string | null {
  const cdnPath = appFileKeyToCdnPath(key);
  const target = resolveProxyTarget(cdnPath);
  if (!target || target.bucket !== 'appFiles' || target.key !== key) return null;
  return `/${encodeURI(cdnPath)}`;
}
