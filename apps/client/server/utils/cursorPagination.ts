import { z } from 'zod';
import { UnprocessableEntityError } from '@server/utils/errors';

/**
 * Server half of the public-API pagination convention (b4m-core/common/src/api-contract/CONVENTIONS.md,
 * section 8): an opaque `cursor` in, a `next_cursor` out, `null` on the last page.
 *
 * The cursor is base64url JSON carrying a format version, the scope it was issued for and the last
 * id served. The scope stops a cursor minted by one endpoint (or for one lake) from silently paging
 * another; the version lets the format change later without misreading cursors already handed out.
 * Items are ordered by `id` with a plain string compare, which is stable for ObjectId hex and for
 * the built-in lakes' string ids alike.
 */

const CURSOR_VERSION = 1;

const CursorPayloadSchema = z.object({
  v: z.literal(CURSOR_VERSION),
  s: z.string(),
  after: z.string().min(1),
});

export function encodeCursor(scope: string, afterId: string): string {
  return Buffer.from(JSON.stringify({ v: CURSOR_VERSION, s: scope, after: afterId }), 'utf8').toString('base64url');
}

/** The id to resume after. Throws a 422 for a cursor that is malformed or was issued for another scope. */
export function decodeCursor(cursor: string, scope: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new UnprocessableEntityError('Invalid cursor');
  }
  const payload = CursorPayloadSchema.safeParse(parsed);
  if (!payload.success || payload.data.s !== scope) throw new UnprocessableEntityError('Invalid cursor');
  return payload.data.after;
}

export type CursorPage<T> = { items: T[]; nextCursor: string | null };

/** One page of `items`, ordered by `id`, starting after the id carried by `cursor`. */
export function paginateById<T extends { id: string }>(
  items: readonly T[],
  { limit, cursor, scope }: { limit: number; cursor?: string; scope: string }
): CursorPage<T> {
  const afterId = cursor === undefined ? undefined : decodeCursor(cursor, scope);
  const ordered = [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const remaining = afterId === undefined ? ordered : ordered.filter(item => item.id > afterId);
  const page = remaining.slice(0, limit);
  const hasMore = remaining.length > limit;
  return { items: page, nextCursor: hasMore ? encodeCursor(scope, page[page.length - 1].id) : null };
}
