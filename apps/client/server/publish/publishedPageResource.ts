import type { PublishedPageResource } from '@bike4mind/common';
import { buildPublishUrlPath } from '@bike4mind/server-utils/services/publish/paths';
import { absolutePublishUrl } from '@server/services/publish/publishStoredArtifact';

type PageDoc = Record<string, unknown>;

const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : typeof v === 'string' ? v : null);

/** The SPA-shaped page document (as the manage services return it) as the public snake_case resource. */
export function toPublishedPageResource(doc: PageDoc): PublishedPageResource {
  const tier = doc.tier as PublishedPageResource['tier'];
  const gate = doc.accessGate as { kind?: 'passphrase' | 'domain' } | null | undefined;
  const size = (doc.size ?? {}) as { totalBytes?: number; fileCount?: number };
  return {
    public_id: String(doc.publicId),
    url: absolutePublishUrl(buildPublishUrlPath(tier, String(doc.scopeId), String(doc.slug))),
    tier,
    scope_id: String(doc.scopeId),
    slug: String(doc.slug),
    title: String(doc.title),
    description: typeof doc.description === 'string' ? doc.description : null,
    tags: Array.isArray(doc.tags) ? (doc.tags as string[]) : [],
    visibility: doc.visibility as PublishedPageResource['visibility'],
    comment_policy: (doc.commentPolicy as PublishedPageResource['comment_policy']) ?? 'none',
    discoverable: doc.discoverable === true,
    embed_origins: Array.isArray(doc.embedOrigins) ? (doc.embedOrigins as string[]) : [],
    access_gate: gate?.kind ? { kind: gate.kind } : null,
    size_bytes: size.totalBytes ?? 0,
    file_count: size.fileCount ?? 0,
    published_at: iso(doc.publishedAt) ?? '',
    updated_at: iso(doc.updatedAt) ?? iso(doc.publishedAt) ?? '',
  };
}
