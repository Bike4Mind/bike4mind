import { randomUUID } from 'crypto';
import { CloudFrontClient, CreateInvalidationCommand } from '@aws-sdk/client-cloudfront';
import { resolveRouterDistributionId } from '@bike4mind/server-utils/security/wafSharedHelpers';
import { appFileKeyToCdnPath, resolveProxyTarget } from '@bike4mind/server-utils/utils/appFileProxy';
import type { MinimalLogger } from '../publish/minimalLogger';

/**
 * CloudFront invalidation on the Router distribution, which serves `/p/*`, `/generated/*` and the
 * app-file prefixes. Best-effort throughout: a failed invalidation is logged and never thrown, so
 * it cannot fail the delete that triggered it. The frontend lambda and the account-deletion sweep
 * already hold `cloudfront:CreateInvalidation` on this distribution (infra/web.ts, infra/cron.ts).
 */

const cfClient = new CloudFrontClient({});

// CloudFront takes at most 1,000 paths per request and 3,000 exact paths in flight per
// distribution across all callers; its rejection (TooManyInvalidationsInProgress) is only logged.
export const MAX_PATHS_PER_BATCH = 1000;
export const MAX_IN_PROGRESS_EXACT_PATHS = 3000;
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
 * Invalidate exact Router paths, MAX_PATHS_PER_BATCH per request, sent in sequence. Caller wildcards
 * are dropped: CloudFront allows only a handful in flight per distribution, shared with publish
 * takedowns. Only a set larger than the whole in-flight exact-path quota is coalesced into one
 * `/<first segment>/*` wildcard per prefix. A failed request is logged and the rest still go out.
 * Never throws.
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
  const options = { logTag, referencePrefix: 'media', logger };
  if (exact.length > MAX_IN_PROGRESS_EXACT_PATHS) {
    const wildcards = [...new Set(exact.map(p => `/${p.split('/')[1]}/*`))];
    logger?.warn(
      `${logTag} ${exact.length} paths exceed the ${MAX_IN_PROGRESS_EXACT_PATHS} exact-path quota for ${label}; invalidating ${wildcards.join(', ')}`
    );
    await sendInvalidation(distributionId, label, wildcards, options);
    return;
  }
  const chunks = Math.ceil(exact.length / MAX_PATHS_PER_BATCH);
  for (let i = 0; i < chunks; i++) {
    const chunk = exact.slice(i * MAX_PATHS_PER_BATCH, (i + 1) * MAX_PATHS_PER_BATCH);
    await sendInvalidation(distributionId, chunks === 1 ? label : `${label}-${i + 1}of${chunks}`, chunk, options);
  }
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
