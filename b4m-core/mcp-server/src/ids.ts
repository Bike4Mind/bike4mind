import { SlugSchema } from '@bike4mind/common';
import { z } from 'zod';

// Mirrors publishGateToken's PUBLIC_ID_RE in packages/server-utils; keep in sync.
const PUBLIC_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const OBJECT_ID_RE = /^[0-9a-f]{24}$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// `/p/r/{publicId}` and `/p/f/{publicId}` (published artifact short URLs), or `/p/{slug}`.
const LIVE_ARTIFACT_PATH_RE = /^\/p\/(?:([rf])\/)?([^/]+)\/?$/;

export const isPublicId = (value: unknown): value is string => typeof value === 'string' && PUBLIC_ID_RE.test(value);
export const isObjectId = (value: unknown): value is string => typeof value === 'string' && OBJECT_ID_RE.test(value);
export const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID_RE.test(value);
export const isSlug = (value: unknown): value is string => SlugSchema.safeParse(value).success;

export const publicIdSchema = z.string().regex(PUBLIC_ID_RE, 'not a valid public id');
export const objectIdSchema = z.string().regex(OBJECT_ID_RE, 'not a valid 24-character object id');
export const uuidSchema = z.string().regex(UUID_RE, 'not a valid UUID');
export const slugSchema = SlugSchema;

export interface LiveArtifactRef {
  kind: 'publicId' | 'slug';
  value: string;
  /** `r` (rendered) or `f` (file) when the input was a `/p/r/` or `/p/f/` URL. */
  tierPath?: 'r' | 'f';
}

/**
 * Accepts a `/p/...` URL (absolute or path-only, any host), a slug or a publicId. Only the path is read: the host is
 * never contacted. A bare value that is a valid slug is a slug, otherwise a publicId. Anything else returns null.
 */
export function parseLiveArtifactRef(input: string): LiveArtifactRef | null {
  const text = input.trim();
  if (/^https?:\/\//i.test(text) || text.startsWith('/')) {
    let pathname: string;
    try {
      pathname = new URL(text, 'http://placeholder.invalid').pathname;
    } catch {
      return null;
    }
    const match = LIVE_ARTIFACT_PATH_RE.exec(pathname);
    if (!match) return null;
    const [, tier, id] = match;
    if (tier) return isPublicId(id) ? { kind: 'publicId', value: id, tierPath: tier as 'r' | 'f' } : null;
    return isSlug(id) ? { kind: 'slug', value: id } : null;
  }
  if (isSlug(text)) return { kind: 'slug', value: text };
  if (isPublicId(text)) return { kind: 'publicId', value: text };
  return null;
}

/** Zod form of {@link parseLiveArtifactRef}, so a tool rejects a bad ref before any transport call. */
export const liveArtifactRefSchema = z
  .string()
  .max(2048)
  .refine(value => parseLiveArtifactRef(value) !== null, 'not a /p/ URL, slug or public id');
