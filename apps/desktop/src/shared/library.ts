import { z } from 'zod';

/**
 * The Library place: the account's finished image and video generations, read from the public
 * `/api/v1/image-jobs` and `/api/v1/video-generations` lists (both take the desktop bearer token).
 * Each medium is its own cursor-paginated list; the renderer merges them for "All" (libraryFeed.ts).
 */
export const libraryMediumSchema = z.enum(['image', 'video']);
export type LibraryMedium = z.infer<typeof libraryMediumSchema>;

export type LibraryAvailability = 'ready' | 'pending_scan' | 'unavailable';

export interface LibraryItem {
  id: string;
  medium: LibraryMedium;
  prompt: string;
  model: string;
  /** ISO 8601. */
  createdAt: string;
  availability: LibraryAvailability;
  contentType: string;
  /** Video only. */
  durationSeconds?: number;
  aspectRatio?: string;
}

export interface LibraryPage {
  items: LibraryItem[];
  /** Null once the list is exhausted. */
  nextCursor: string | null;
}

/** Server job ids are Mongo ObjectIds today; the bound only keeps a renderer value sane. */
const libraryItemIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

export const libraryPageRequestSchema = z
  .object({
    medium: libraryMediumSchema,
    cursor: z.string().min(1).max(512).optional(),
  })
  .strict();
export type LibraryPageRequest = z.infer<typeof libraryPageRequestSchema>;

export const libraryItemRefSchema = z.object({ medium: libraryMediumSchema, id: libraryItemIdSchema }).strict();
export type LibraryItemRef = z.infer<typeof libraryItemRefSchema>;

export interface LibraryMedia {
  /** A `b4m-media:` URL; the renderer's CSP admits no remote origin. */
  url: string;
  mimeType: string;
}

export interface LibraryApi {
  page(request: LibraryPageRequest): Promise<LibraryPage>;
  /** Download one item's bytes into the media folder (cached for the app run). */
  media(ref: LibraryItemRef): Promise<LibraryMedia>;
  /** The local session a Studio Create of this item saved into, or null when it was made elsewhere. */
  locate(ref: LibraryItemRef): Promise<{ sessionId: string } | null>;
}
