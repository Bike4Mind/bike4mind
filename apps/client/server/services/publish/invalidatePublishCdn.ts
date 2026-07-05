import { CloudFrontClient, CreateInvalidationCommand } from '@aws-sdk/client-cloudfront';
import type { PublishScopeTier, PublishSourceKind } from '@bike4mind/common';
import { resolveRouterDistributionId } from '@server/security/wafSharedHelpers';
import { buildPublishUrlPath } from './paths';

/**
 * CloudFront invalidation for published `/p/...` pages.
 *
 * Public pages are cacheable for performance, so when a page is REMOVED (admin
 * takedown or owner delete) the cached 200 can keep serving for the duration of
 * its TTL even though the origin now 404s. For an abuse/takedown surface that
 * delay is unacceptable, so we proactively invalidate the page's paths on the
 * Router distribution (the same CDN that serves `/p/*`). The shortened
 * `Cache-Control` (see serve route) is the backstop for any path this misses.
 *
 * Best-effort: the frontend lambda already holds `cloudfront:CreateInvalidation`
 * scoped to the Router distribution (infra/web.ts), but we never throw - a failed
 * invalidation must not fail the takedown; the short TTL still bounds exposure.
 */

const cfClient = new CloudFrontClient({});

export interface PublishCacheTarget {
  publicId: string;
  tier: PublishScopeTier;
  scopeId: string;
  slug: string;
  sourceKind: PublishSourceKind;
}

/** Project a PublishedArtifact (doc or lean) into the cache target - one place so
 *  the call sites can't drift on which fields the invalidation needs. */
export function toCacheTarget(a: {
  publicId: string;
  tier: PublishScopeTier;
  scopeId: string;
  slug: string;
  source: { kind: PublishSourceKind };
}): PublishCacheTarget {
  return { publicId: a.publicId, tier: a.tier, scopeId: a.scopeId, slug: a.slug, sourceKind: a.source.kind };
}

/** The paths that serve an artifact - index + asset glob for bundles. Bundles also
 *  include the Approach B isolated-origin `/uc/...` paths: a public bundle is
 *  cached on BOTH the app-origin wrapper (`/p/...`) and the per-artifact usercontent
 *  origin (`/uc/...`), so a takedown must invalidate both or the removed bundle keeps
 *  serving from the isolated origin for its full s-maxage. CloudFront invalidation
 *  matches by path across all host variants, so listing `/uc/...` clears it regardless
 *  of whether the cache policy keys on Host. */
export function publishCachePaths(t: PublishCacheTarget): string[] {
  if (t.sourceKind === 'reply') return [`/p/r/${t.publicId}`];
  if (t.sourceKind === 'fabfile') return [`/p/f/${t.publicId}`];
  const base = buildPublishUrlPath(t.tier, t.scopeId, t.slug); // /p/{prefix}/{scopeId}/{slug}
  const ucBase = base.replace(/^\/p\b/, '/uc'); // isolated-origin path (mirrors the serve handler)
  return [base, `${base}/*`, ucBase, `${ucBase}/*`]; // /p + /uc, index + every asset under each
}

/**
 * The Router CloudFront distribution id, via the canonical resolver (which reads
 * the `RouterDistributionId` Linkable's `.id` - NOT `.value`; only the separate
 * `whatsNewDistributionId` Linkable uses `.value`). Returns undefined when the
 * resource isn't linked (local/test) so invalidation cleanly no-ops rather than
 * throwing - this is a best-effort path.
 */
function getRouterDistributionId(logger?: MinimalLogger): string | undefined {
  try {
    return resolveRouterDistributionId();
  } catch (err) {
    // resolveRouterDistributionId throws for TWO reasons: the Linkable is absent
    // (legitimate local/test no-op) OR the id is malformed (e.g. a bad
    // DEV_ROUTER_DISTRIBUTION_ID). Both skip invalidation, but we WARN with the
    // message rather than swallow silently - otherwise a malformed env var would
    // disable takedown immediacy on the shared dev router with no operator signal.
    logger?.warn(`[PUBLISH] CDN invalidation skipped — ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

interface MinimalLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
}

/** Invalidate a published page's CDN paths so a removed page stops serving immediately. Never throws. */
export async function invalidatePublishCdn(target: PublishCacheTarget, logger?: MinimalLogger): Promise<void> {
  const distributionId = getRouterDistributionId(logger);
  if (!distributionId) return; // getRouterDistributionId already logged why
  const paths = publishCachePaths(target);
  try {
    await cfClient.send(
      new CreateInvalidationCommand({
        DistributionId: distributionId,
        InvalidationBatch: {
          CallerReference: `publish-${target.publicId}-${Date.now()}`,
          Paths: { Quantity: paths.length, Items: paths },
        },
      })
    );
    logger?.info(`[PUBLISH] CDN invalidation issued for ${target.publicId}: ${paths.join(', ')}`);
  } catch (err) {
    logger?.warn(
      `[PUBLISH] CDN invalidation failed for ${target.publicId}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
