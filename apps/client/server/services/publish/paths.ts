import { SCOPE_URL_PREFIX, type PublishScopeTier } from '@bike4mind/common';

/**
 * Canonical S3 key prefix for a published bundle: `{tier}/{scopeId}/{slug}/`.
 * Drafts live under `drafts/{draftId}/` until finalize promotes them here.
 */
export function buildPublishS3KeyPrefix(tier: PublishScopeTier, scopeId: string, slug: string): string {
  return `${tier}/${scopeId}/${slug}/`;
}

/** Public URL path for a bundle artifact, e.g. `/p/u/{scopeId}/{slug}`. */
export function buildPublishUrlPath(tier: PublishScopeTier, scopeId: string, slug: string): string {
  return `${SCOPE_URL_PREFIX[tier]}/${scopeId}/${slug}`;
}
