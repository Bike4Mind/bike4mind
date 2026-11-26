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
}

export const NO_PAGING: SessionPaging = { loaded: 0, nextCursor: null, total: 0 };

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
