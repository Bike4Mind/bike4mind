import type { ChatSessionSummary } from '@shared/chat';
import type { SessionPage } from '@shared/sessionPage';

/** Mirrors the host's cap on `include`; past it the oldest asks are dropped. */
const MAX_KEEP_IDS = 50;

/** How far the renderer has paged through the list; see useSessions. */
export interface SessionPaging {
  /** Rows loaded through pages, not counting `related` rows; a reload re-reads this many. */
  loaded: number;
  nextCursor: string | null;
  /** Sessions in the whole list. */
  total: number;
  /** `updatedAt` of the oldest row loaded through pages; null before any. */
  oldest: string | null;
  /** The rows loaded through pages, as opposed to the `related` rows carried with them. */
  pageIds: ReadonlySet<string>;
}

export const NO_PAGING: SessionPaging = { loaded: 0, nextCursor: null, total: 0, oldest: null, pageIds: new Set() };

/** The paging after a page of `sessions` (newest first) was loaded on top of `before`. */
export function pagedThrough(
  before: SessionPaging,
  page: Pick<SessionPage, 'sessions' | 'nextCursor' | 'total'>
): SessionPaging {
  return {
    loaded: before.loaded + page.sessions.length,
    nextCursor: page.nextCursor,
    total: page.total,
    oldest: page.sessions.at(-1)?.updatedAt ?? before.oldest,
    pageIds: new Set([...before.pageIds, ...page.sessions.map(session => session.id)]),
  };
}

const EMPTY_LIST: ChatSessionSummary[] = [];

/**
 * How far back in time the merged list may show page rows: the newest of the oldest loaded rows
 * of the hosts that still have more pages. A host behind it would put its next page above rows
 * already shown. Null when no host has more, so nothing is held back.
 */
export function pagingWatermark(
  paging: ReadonlyMap<string, SessionPaging>,
  pagingHosts: readonly string[]
): string | null {
  let watermark: string | null = null;
  for (const hostId of pagingHosts) {
    const host = paging.get(hostId);
    if (!host?.nextCursor || host.oldest === null) continue;
    if (watermark === null || host.oldest > watermark) watermark = host.oldest;
  }
  return watermark;
}

/** The hosts whose next page moves the watermark: those at it, and any with more but no page yet. */
export function laggingHosts(paging: ReadonlyMap<string, SessionPaging>, pagingHosts: readonly string[]): string[] {
  const watermark = pagingWatermark(paging, pagingHosts);
  return pagingHosts.filter(hostId => {
    const host = paging.get(hostId);
    return !!host?.nextCursor && (host.oldest === null || host.oldest === watermark);
  });
}

/**
 * Every host's rows as one list, newest first. One host's rows are returned as they are, so with
 * only the local host the list is exactly the one it serves. Across several, page rows older than
 * the watermark are held back until the host behind it pages that far, so the list never has a
 * hole a later page would fill from the middle. Rows carried with a page (pinned, live, kept,
 * spawn family) are never held back, as with one host, and neither are `kept` ids (the open
 * session), which a host joining with a shallower first page would otherwise hide.
 */
export function mergeHostRows(
  byHost: ReadonlyMap<string, ChatSessionSummary[]>,
  paging: ReadonlyMap<string, SessionPaging>,
  pagingHosts: readonly string[],
  kept: ReadonlySet<string> = new Set()
): ChatSessionSummary[] {
  const lists = [...byHost.entries()].filter(([, rows]) => rows.length > 0);
  if (lists.length === 0) return EMPTY_LIST;
  if (lists.length === 1) return lists[0][1];
  const watermark = pagingWatermark(paging, pagingHosts);
  const shown = lists.flatMap(([hostId, rows]) => {
    const pageIds = paging.get(hostId)?.pageIds;
    if (watermark === null || !pageIds) return rows;
    return rows.filter(row => !pageIds.has(row.id) || row.updatedAt >= watermark || kept.has(row.id));
  });
  return shown.sort(byUpdatedDesc);
}

/** Newest first; a stable sort, so equal timestamps keep the order main sent them in. */
export const byUpdatedDesc = (a: ChatSessionSummary, b: ChatSessionSummary): number =>
  b.updatedAt.localeCompare(a.updatedAt);

/** A reload's result: the page and the rows carried with it, newest first. */
export function sessionsFromPage(page: Pick<SessionPage, 'sessions' | 'related'>): ChatSessionSummary[] {
  return withRows([], [...page.sessions, ...page.related]).sort(byUpdatedDesc);
}

/**
 * `current` with the rows of `incoming` it does not hold yet, appended. A row already held is
 * kept as is: it may carry a local edit (a pin, an optimistic title) the page was read before.
 */
export function withRows(current: ChatSessionSummary[], incoming: readonly ChatSessionSummary[]): ChatSessionSummary[] {
  const held = new Set(current.map(session => session.id));
  const added: ChatSessionSummary[] = [];
  for (const session of incoming) {
    if (held.has(session.id)) continue;
    held.add(session.id);
    added.push(session);
  }
  return added.length === 0 ? current : [...current, ...added];
}

/** Ids to send as `include`: unique, non-empty, and within the host's cap. */
export function keepRequest(ids: readonly string[]): string[] {
  return [...new Set(ids.filter(id => id !== ''))].slice(-MAX_KEEP_IDS);
}
