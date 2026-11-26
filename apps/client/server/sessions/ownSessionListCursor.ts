import { isSessionListKeysetField, type SessionListKeyset } from '@bike4mind/common';
import { UnprocessableEntityError } from '@bike4mind/server-utils/utils/errors';
import { decodeCursor, decodeTimeIdCursor, encodeCursor, encodeTimeIdCursor } from '@server/utils/cursorPagination';

/**
 * Keyset cursors for the SPA's own-notebook list (GET /api/sessions), the opaque alternative to
 * `pagination[page]`. A cursor carries the last row served: its id, plus its lastUpdated when the
 * list is ordered by lastUpdated (searchByUserId breaks ties on _id).
 *
 * The scope names the order, so a cursor minted for one order cannot silently page another. A
 * notebook edited mid-walk moves to the top of a lastUpdated-desc list: it is never served twice,
 * and the client's page-1 refetch picks it up.
 */

const OBJECT_ID = /^[0-9a-f]{24}$/;

export type OwnSessionListOrder = { field: string; direction: 'asc' | 'desc' };

function cursorScope({ field, direction }: OwnSessionListOrder): string {
  return `own-sessions:${field}:${direction}`;
}

/** The keyset to resume after. Throws a 422 for a malformed cursor or one minted for another order. */
export function decodeOwnSessionListCursor(cursor: string, order: OwnSessionListOrder): SessionListKeyset {
  if (!isSessionListKeysetField(order.field)) {
    throw new UnprocessableEntityError('cursor paging needs orderBy[field] lastUpdated or _id');
  }
  const scope = cursorScope(order);
  if (order.field === 'lastUpdated') return decodeTimeIdCursor(cursor, scope);
  const id = decodeCursor(cursor, scope);
  if (!OBJECT_ID.test(id)) throw new UnprocessableEntityError('Invalid cursor');
  return { id };
}

/** The cursor for the page after `last`, or null when there is none to mint. */
export function encodeOwnSessionListCursor(
  last: SessionListKeyset | undefined,
  order: OwnSessionListOrder
): string | null {
  if (!last) return null;
  const scope = cursorScope(order);
  if (order.field === 'lastUpdated') return last.at ? encodeTimeIdCursor(scope, { at: last.at, id: last.id }) : null;
  return order.field === '_id' ? encodeCursor(scope, last.id) : null;
}
