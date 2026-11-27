import { SCOPE_URL_PREFIX, SlugSchema } from '@bike4mind/common';
import { z } from 'zod';

// Mirrors publishGateToken's SAFE_PUBLIC_ID in packages/server-utils; keep in sync.
const PUBLIC_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const OBJECT_ID_RE = /^[0-9a-f]{24}$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isPublicId = (value: unknown): value is string => typeof value === 'string' && PUBLIC_ID_RE.test(value);
export const isObjectId = (value: unknown): value is string => typeof value === 'string' && OBJECT_ID_RE.test(value);
export const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID_RE.test(value);
export const isSlug = (value: unknown): value is string => SlugSchema.safeParse(value).success;

export const publicIdSchema = z.string().regex(PUBLIC_ID_RE, 'not a valid public id');
export const objectIdSchema = z.string().regex(OBJECT_ID_RE, 'not a valid 24-character object id');
export const uuidSchema = z.string().regex(UUID_RE, 'not a valid UUID');
export const slugSchema = SlugSchema;

export type PublishTier = 'user' | 'project' | 'organization';

// A Map, so inherited keys such as `constructor` never resolve to a tier.
const TIER_BY_PREFIX = new Map<string, PublishTier>(
  Object.entries(SCOPE_URL_PREFIX).map(([tier, prefix]) => [prefix.split('/').pop()!, tier as PublishTier])
);

export type LiveArtifactRef =
  | {
      kind: 'publicId';
      value: string;
      /** `r` (published reply) or `f` (fabfile) when the input was a `/p/r/` or `/p/f/` URL. */
      tierPath?: 'r' | 'f';
    }
  | { kind: 'bundle'; tier: PublishTier; scopeId: string; slug: string };

/**
 * Accepts the viewer URLs a user pastes (absolute or path-only, any host; only the path is read, the host is never
 * contacted) or a bare publicId. Forms, as in parsePublishPath: `/p/r/{publicId}`, `/p/f/{publicId}` and
 * `/p/u|pj|o/{scopeId}/{slug}[/asset]`. A bare slug is not accepted: slugs are unique only per tier and scope, and
 * every minted publicId is also slug-shaped, so a bare value is always read as a publicId. `/a/{shareToken}` links
 * are refused: a share token grants no-sign-in access and is not a Live Artifact reference. Anything else is null.
 */
export function parseLiveArtifactRef(input: string): LiveArtifactRef | null {
  const text = input.trim();
  if (!/^https?:\/\//i.test(text) && !text.startsWith('/'))
    return isPublicId(text) ? { kind: 'publicId', value: text } : null;

  let pathname: string;
  try {
    pathname = new URL(text, 'http://placeholder.invalid').pathname;
  } catch {
    return null;
  }
  const [root, head, ...rest] = pathname.split('/').slice(1);
  if (root !== 'p' || !head) return null;
  if (head === 'r' || head === 'f') {
    const [id, ...extra] = rest;
    return isPublicId(id) && extra.every(s => s === '') ? { kind: 'publicId', value: id, tierPath: head } : null;
  }
  const tier = TIER_BY_PREFIX.get(head);
  const [scopeId, slug] = rest;
  return tier && isPublicId(scopeId) && isSlug(slug) ? { kind: 'bundle', tier, scopeId, slug } : null;
}

/** Zod form of {@link parseLiveArtifactRef}, so a tool rejects a bad ref before any transport call. */
export const liveArtifactRefSchema = z
  .string()
  .max(2048)
  .refine(value => parseLiveArtifactRef(value) !== null, 'not a /p/ URL or public id');
