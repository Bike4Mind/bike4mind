import { z } from 'zod';
import type { ChatSessionSummary } from './chat';

/**
 * Paging for the sidebar's session list (host method `session/page`).
 *
 * Keyset rather than offset: a session created or updated while the user scrolls moves to the
 * top, which would shift every offset and repeat or skip rows; a cursor names the last row seen,
 * so the next page starts right after it whatever moved above. Ordering is newest `updatedAt`
 * first with the id breaking ties, the same order SessionStore.list returns.
 *
 * Full-list consumers (attention monitor, watch, import, host tools) keep using `session/list`.
 */

/** Rows per sidebar page: several viewports of rows, small enough to render in one frame. */
export const SESSION_PAGE_SIZE = 100;
/** A reload re-reads every page loaded so far in one request, so it gets a larger ceiling. */
export const SESSION_PAGE_MAX_LIMIT = 5000;
/** Title matches returned for a search; the result says how many more there were. */
export const SESSION_SEARCH_LIMIT = 100;
/** Ids a client may ask to have carried along (the open session, the one to restore). */
const MAX_INCLUDE_IDS = 50;

export const sessionPageRequestSchema = z.object({
  limit: z.number().int().min(0).max(SESSION_PAGE_MAX_LIMIT),
  /** The `nextCursor` of the previous page; absent or null for the first. */
  cursor: z.string().nullish(),
  /** Case-insensitive title filter. Set, `related` stays empty: a search returns matches only. */
  query: z.string().max(500).optional(),
  /** Sessions to return in `related` whether or not they fall on this page. */
  include: z.array(z.string()).max(MAX_INCLUDE_IDS).optional(),
});

export type SessionPageRequest = z.infer<typeof sessionPageRequestSchema>;

export interface SessionPage {
  /** This page's slice, in list order. */
  sessions: ChatSessionSummary[];
  /**
   * Sessions the client needs alongside the slice but that may sit on other pages: the spawn
   * family of every row in the slice (so nesting and "delete with its sub-sessions" see the
   * whole family), the requested `include` ids, and - on a first page - every pinned and every
   * live session. Never repeats a row in `sessions`.
   */
  related: ChatSessionSummary[];
  /** Null when this page reached the end of the list (or of the matches, for a search). */
  nextCursor: string | null;
  /** Sessions in the whole list, or matches for a search. */
  total: number;
}

const cursorSchema = z.tuple([z.string(), z.string()]);

export function encodeSessionCursor(session: Pick<ChatSessionSummary, 'updatedAt' | 'id'>): string {
  return JSON.stringify([session.updatedAt, session.id]);
}

/** Null for a cursor this build did not write; the caller then starts from the top. */
export function decodeSessionCursor(cursor: string): { updatedAt: string; id: string } | null {
  try {
    const parsed = cursorSchema.safeParse(JSON.parse(cursor));
    return parsed.success ? { updatedAt: parsed.data[0], id: parsed.data[1] } : null;
  } catch {
    return null;
  }
}

/** Newest first, id ascending among equal timestamps: a total order, which a keyset needs. */
export function compareSessionsForPage(
  a: Pick<ChatSessionSummary, 'updatedAt' | 'id'>,
  b: Pick<ChatSessionSummary, 'updatedAt' | 'id'>
): number {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

export function titleMatches(session: Pick<ChatSessionSummary, 'title'>, query: string): boolean {
  const needle = query.trim().toLowerCase();
  return needle === '' || session.title.toLowerCase().includes(needle);
}

export interface PageContext {
  /** Sessions with a turn running or waiting on the user; carried on a first page. */
  liveIds?: ReadonlySet<string>;
}

/**
 * One page of `sessions`, which must already be in compareSessionsForPage order. Pure and linear
 * in the list size: at ten thousand summaries that is well under a millisecond, far less than
 * the IPC copy of the rows it saves.
 */
export function pageSessions(
  sessions: readonly ChatSessionSummary[],
  request: SessionPageRequest,
  context: PageContext = {}
): SessionPage {
  const query = request.query?.trim() ?? '';
  const searching = query !== '';
  const candidates = searching ? sessions.filter(session => titleMatches(session, query)) : sessions;

  const after = request.cursor ? decodeSessionCursor(request.cursor) : null;
  const start = after ? candidates.findIndex(session => compareSessionsForPage(session, after) > 0) : 0;
  const from = start === -1 ? candidates.length : start;
  const slice = candidates.slice(from, from + request.limit);
  const end = from + slice.length;
  const last = slice.at(-1);
  const nextCursor = end < candidates.length && last ? encodeSessionCursor(last) : null;

  const related = searching ? [] : relatedTo(sessions, slice, request, !request.cursor, context);
  return { sessions: slice, related, nextCursor, total: candidates.length };
}

function relatedTo(
  sessions: readonly ChatSessionSummary[],
  slice: readonly ChatSessionSummary[],
  request: SessionPageRequest,
  firstPage: boolean,
  context: PageContext
): ChatSessionSummary[] {
  const byId = new Map(sessions.map(session => [session.id, session]));
  const childrenOf = new Map<string, ChatSessionSummary[]>();
  for (const session of sessions) {
    const parentId = session.origin?.parentSessionId;
    if (!parentId) continue;
    const siblings = childrenOf.get(parentId);
    if (siblings) siblings.push(session);
    else childrenOf.set(parentId, [session]);
  }

  const inSlice = new Set(slice.map(session => session.id));
  const wanted = new Set<string>();
  const want = (id: string) => {
    if (!inSlice.has(id) && byId.has(id)) wanted.add(id);
  };

  for (const id of request.include ?? []) want(id);
  if (firstPage) {
    for (const session of sessions) {
      if (session.pinned || context.liveIds?.has(session.id)) want(session.id);
    }
  }

  // The spawn family of everything returned so far: walk up to the root, then down from it.
  const seeds = [...slice.map(session => session.id), ...wanted];
  const visited = new Set<string>();
  for (const seed of seeds) {
    let root = seed;
    const climbed = new Set<string>([root]);
    for (let parent = byId.get(root)?.origin?.parentSessionId; parent && byId.has(parent);) {
      if (climbed.has(parent)) break; // A cycle in hand-edited files must not hang the host.
      climbed.add(parent);
      root = parent;
      parent = byId.get(root)?.origin?.parentSessionId;
    }
    const stack = [root];
    for (let id = stack.pop(); id !== undefined; id = stack.pop()) {
      if (visited.has(id)) continue;
      visited.add(id);
      want(id);
      for (const child of childrenOf.get(id) ?? []) stack.push(child.id);
    }
  }

  return sessions.filter(session => wanted.has(session.id));
}
