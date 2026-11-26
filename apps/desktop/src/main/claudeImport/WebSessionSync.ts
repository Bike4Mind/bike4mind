import { isAxiosError } from 'axios';
import { z } from 'zod';
import type { ChatSession } from '@shared/chat';
import type { ClaudeImportCounts } from '@shared/claudeImport';
import { deriveTitle, isForkedImport, type SessionStore } from '../chat/SessionStore';
import type { WebNotebookCursor } from './ImportStateStore';
import {
  mapQuests,
  readChangeStamp,
  readNotebook,
  sourceIdOf,
  WEB_VERSION_PREFIX,
  type WebNotebook,
} from './webSessionMapper';

const LIST_PATH = '/api/sessions';
/** Keyset-paged by `_id`, newest created first: a deep page costs the same as the first. */
const NOTEBOOK_LIST_PATH = '/api/v1/sessions';
const COUNT_PATH = '/api/sessions/count';
/** The v1 list's maximum `limit`. */
const LIST_PAGE_SIZE = 100;
/**
 * A runaway guard, not a product limit: 50,000 notebooks. Past it the list is partial, so nothing is
 * pruned for having gone missing, and the run says how far it got.
 */
const MAX_LIST_PAGES = 500;
/** Waits before retrying a list page that failed in a way a retry can fix (ms). */
const LIST_RETRY_DELAYS_MS = [1_000, 4_000];
/**
 * How far before the mark a change listing starts (ms). `updatedAt` is stamped by whichever app server
 * made the write, so clock skew, or a write that commits after a later one, can land a change just
 * behind a mark already taken. Re-reading the overlap is cheap: an unchanged notebook is skipped.
 */
export const CHANGE_OVERLAP_MS = 5 * 60_000;
const CHAT_PAGE_SIZE = 100;
const MAX_CHAT_PAGES = 100;

/** The authenticated client's one read this needs; the access token stays inside it. */
export interface WebApi {
  get<T>(url: string): Promise<T>;
}

export interface WebSyncDeps {
  api: WebApi;
  store: Pick<SessionStore, 'getImported' | 'putImported'>;
  deleteImported: (id: string, scopeKey: string) => Promise<'removed' | 'forked' | 'missing'>;
  /** The account the run started under; a switch mid-run makes the store refuse the write. */
  scopeKey: string;
  pickModel: () => Promise<string | undefined>;
  now?: () => Date;
}

const pageSchema = z.union([
  z.array(z.unknown()).transform(data => ({ data, hasMore: false })),
  z.object({ data: z.array(z.unknown()), hasMore: z.boolean() }),
]);

function pageOf(result: unknown): z.infer<typeof pageSchema> {
  return pageSchema.parse(result);
}

const notebookPageSchema = z.object({ data: z.array(z.unknown()), next_cursor: z.string().min(1).nullable() });

/** A failed list page worth retrying within the run: the network, a timeout, throttling or a server fault. */
function isTransient(error: unknown): boolean {
  if (!isAxiosError(error)) return false;
  const status = error.response?.status;
  return status === undefined || status === 429 || status >= 500;
}

/** A short, log-safe reason for a failed read: the HTTP status or the client's error code. */
export function describeWebError(error: unknown): string {
  if (isAxiosError(error)) {
    if (error.response) return `HTTP ${error.response.status}`;
    if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') return 'timed out';
    if (error.code) return error.code;
  }
  // A ZodError's message is a multi-line JSON dump; the full text stays in the log.
  if (error instanceof z.ZodError) return 'unexpected response';
  const message = error instanceof Error ? error.message : String(error);
  const firstLine = message.split('\n', 1)[0].trim();
  return firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine || 'unknown error';
}

/** A listed id the list did not return; kept as a safety net before deleting a local copy. */
export async function webNotebookWasDeleted(api: WebApi, notebookId: string): Promise<boolean> {
  try {
    await api.get(`${LIST_PATH}/${encodeURIComponent(notebookId)}`);
    return false;
  } catch (error) {
    if (isAxiosError(error) && error.response?.status === 404) return true;
    throw error;
  }
}

function pagedUrl(path: string, page: number, limit: number, extra: Record<string, string> = {}): string {
  const query = new URLSearchParams({
    ...extra,
    'pagination[page]': String(page),
    'pagination[limit]': String(limit),
  });
  return `${path}?${query.toString()}`;
}

/** One request, for the sidebar hint: how many notebooks the account has on the web. */
export async function countWebNotebooks(api: WebApi): Promise<number> {
  return z.object({ count: z.number().int().nonnegative() }).parse(await api.get(COUNT_PATH)).count;
}

export function webSessionId(notebookId: string, scopeTag: string): string {
  return `bw-${scopeTag}-${notebookId}`;
}

export interface WebNotebookList {
  /** Newest created first (the list pages by `_id`), so a partial list keeps the recent notebooks. */
  notebooks: WebNotebook[];
  /** False when the list stopped early; a partial list must never drive pruning. */
  complete: boolean;
  /** Why a partial list stopped: a page that kept failing, or the page guard. */
  stopReason?: string;
  /**
   * The latest `updatedAt` in a complete list: the mark the next change listing starts from. Null
   * when the list is partial or no row has an `updatedAt` (the server has no change feed either).
   * Rows without one are skipped: a session not written since the field existed cannot match
   * `updated_since`, and its next write gives it one, so the feed sees it then.
   */
  latestChange: string | null;
}

export interface WebNotebookChanges {
  /** Notebooks changed since the mark and still there, oldest change first. */
  notebooks: WebNotebook[];
  /** Notebooks deleted on the web since the mark. */
  deletedIds: string[];
  /**
   * The latest `updatedAt` read. The listing is oldest change first, so even a partial one has seen
   * every change up to here. Null when nothing came back.
   */
  latestChange: string | null;
  complete: boolean;
  stopReason?: string;
}

export interface ListOptions {
  sleep?: (ms: number) => Promise<void>;
  retryDelaysMs?: readonly number[];
}

const realSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function readListPage(
  api: WebApi,
  url: string,
  options: ListOptions
): Promise<z.infer<typeof notebookPageSchema>> {
  const delays = options.retryDelaysMs ?? LIST_RETRY_DELAYS_MS;
  const sleep = options.sleep ?? realSleep;
  for (let attempt = 0; ; attempt++) {
    try {
      return notebookPageSchema.parse(await api.get(url));
    } catch (error) {
      if (attempt >= delays.length || !isTransient(error)) throw error;
      await sleep(delays[attempt]);
    }
  }
}

/**
 * Every notebook the account owns on the web, newest created first. A failed first page throws; a page
 * that fails later ends the list early with what was read, so one bad page late in a large account
 * does not cost the user every notebook before it.
 */
export async function listWebNotebooks(api: WebApi, options: ListOptions = {}): Promise<WebNotebookList> {
  const notebooks = new Map<string, WebNotebook>();
  const partial = (stopReason: string): WebNotebookList => ({
    notebooks: [...notebooks.values()],
    complete: false,
    stopReason,
    latestChange: null,
  });
  let cursor: string | null = null;
  let skippedRows = 0;
  let latestChange: string | null = null;
  for (let page = 1; page <= MAX_LIST_PAGES; page++) {
    const query = new URLSearchParams({ limit: String(LIST_PAGE_SIZE) });
    if (cursor) query.set('cursor', cursor);
    let result: z.infer<typeof notebookPageSchema>;
    try {
      result = await readListPage(api, `${NOTEBOOK_LIST_PATH}?${query.toString()}`, options);
    } catch (error) {
      if (page === 1) throw error;
      return partial(`stopped after ${notebooks.size} notebooks: ${describeWebError(error)}`);
    }
    for (const row of result.data) {
      const stamp = readChangeStamp(row);
      if (stamp && (!latestChange || stamp.changedAt > latestChange)) latestChange = stamp.changedAt;
      const notebook = readNotebook(row);
      if (!notebook) {
        skippedRows++;
        continue;
      }
      if (!notebooks.has(notebook.id)) notebooks.set(notebook.id, notebook);
    }
    cursor = result.next_cursor;
    if (!cursor) {
      // An unreadable row is one notebook we cannot vouch for, so its local copy must not be pruned.
      return skippedRows > 0
        ? partial(`${skippedRows} unreadable notebook${skippedRows === 1 ? '' : 's'} in the list`)
        : { notebooks: [...notebooks.values()], complete: true, latestChange };
    }
  }
  return partial(`stopped at the ${notebooks.size}-notebook limit`);
}

/**
 * The notebooks changed since `mark` (an `updatedAt` from an earlier listing), deletes included, oldest
 * change first. Null when the server ignores `updated_since`, so the caller falls back to the full list.
 * A failed first page throws; a later one ends the listing early with what was read.
 */
export async function listWebNotebookChanges(
  api: WebApi,
  mark: string,
  options: ListOptions = {}
): Promise<WebNotebookChanges | null> {
  // Last row wins: a notebook edited mid-listing moves ahead of the cursor and comes back later.
  const changed = new Map<string, WebNotebook | 'deleted'>();
  let latestChange: string | null = null;
  const result = (complete: boolean, stopReason?: string): WebNotebookChanges => {
    const notebooks: WebNotebook[] = [];
    const deletedIds: string[] = [];
    for (const [id, change] of changed) {
      if (change === 'deleted') deletedIds.push(id);
      else notebooks.push(change);
    }
    return { notebooks, deletedIds, latestChange, complete, ...(stopReason ? { stopReason } : {}) };
  };
  const since = new Date(Date.parse(mark) - CHANGE_OVERLAP_MS).toISOString();
  let cursor: string | null = null;
  for (let page = 1; page <= MAX_LIST_PAGES; page++) {
    const query = new URLSearchParams({ limit: String(LIST_PAGE_SIZE), updated_since: since });
    if (cursor) query.set('cursor', cursor);
    let pageResult: z.infer<typeof notebookPageSchema>;
    try {
      pageResult = await readListPage(api, `${NOTEBOOK_LIST_PATH}?${query.toString()}`, options);
    } catch (error) {
      if (page === 1) throw error;
      return result(false, `stopped after ${changed.size} changes: ${describeWebError(error)}`);
    }
    for (const row of pageResult.data) {
      const stamp = readChangeStamp(row);
      // An older server drops the unknown filter and answers with the full list: no `updatedAt`, and
      // not in change order. Either one means this is not a change feed.
      if (!stamp || (latestChange !== null && stamp.changedAt < latestChange)) return null;
      latestChange = stamp.changedAt;
      // A row this importer cannot read was never imported, so it has nothing to update or drop.
      const id = sourceIdOf(row);
      if (!id) continue;
      changed.delete(id);
      if (stamp.deleted) changed.set(id, 'deleted');
      else {
        const notebook = readNotebook(row);
        if (notebook) changed.set(id, notebook);
      }
    }
    cursor = pageResult.next_cursor;
    if (!cursor) return result(true);
  }
  return result(false, `stopped at the ${changed.size}-change limit`);
}

/** One notebook by id, for retrying a failed read between full lists; 'deleted' when it is gone. */
export async function fetchWebNotebook(api: WebApi, notebookId: string): Promise<WebNotebook | 'deleted'> {
  let row: unknown;
  try {
    row = await api.get(`${LIST_PATH}/${encodeURIComponent(notebookId)}`);
  } catch (error) {
    if (isAxiosError(error) && error.response?.status === 404) return 'deleted';
    throw error;
  }
  const notebook = readNotebook(row);
  if (!notebook || notebook.id !== notebookId) throw new Error('Invalid notebook in web sync response');
  return notebook;
}

/** `truncated` is true when the page cap was hit with more still to read. */
export async function fetchQuests(api: WebApi, notebookId: string): Promise<{ quests: unknown[]; truncated: boolean }> {
  const quests: unknown[] = [];
  let truncated = false;
  const path = `${LIST_PATH}/${encodeURIComponent(notebookId)}/chat`;
  for (let page = 1; page <= MAX_CHAT_PAGES; page++) {
    const result = pageOf(await api.get(pagedUrl(path, page, CHAT_PAGE_SIZE, { sort: 'asc' })));
    if (result.data.some(row => !sourceIdOf(row))) throw new Error('Invalid quest in web sync response');
    quests.push(...result.data);
    if (!result.hasMore) break;
    if (page === MAX_CHAT_PAGES) truncated = true;
  }
  return { quests, truncated };
}

/** True when the notebook changed since it was read, or the last read failed, and the copy is still ours. */
export function needsWebImport(notebook: WebNotebook, cursor: WebNotebookCursor | undefined): boolean {
  if (!cursor || cursor.status === 'failed') return true;
  if (cursor.status === 'forked' || cursor.status === 'removed') return false;
  // An empty version means the last read was unsettled or truncated: it never matches.
  if (!cursor.version || cursor.version.startsWith(WEB_VERSION_PREFIX)) return cursor.version !== notebook.version;
  return legacyLastUpdated(cursor.version) !== lastUpdatedOf(notebook.version);
}

/**
 * Cursors written before the v1 list stored `updatedAt|lastUpdated`. Comparing on `lastUpdated` keeps
 * existing imports from all re-reading at once after the switch; the old marker already caught any
 * rename that landed before it was written. The version stays on `lastUpdated` and the name rather
 * than `updatedAt`, which background writes (tagging, summaries) also move: the change feed uses
 * `updatedAt` to find candidates, and the version decides which of them are worth a full re-read.
 */
function legacyLastUpdated(version: string): string {
  const bar = version.indexOf('|');
  if (bar < 0) return version;
  return version.slice(bar + 1) || version.slice(0, bar);
}

/** The `lastUpdated` half of a current-form version (`v2|<lastUpdated>|<nameTag>`). */
function lastUpdatedOf(version: string): string {
  return version.slice(WEB_VERSION_PREFIX.length, version.lastIndexOf('|'));
}

/** Re-reads the whole notebook and replaces the desktop copy; quest ids keep message ids stable. */
export async function importNotebook(
  notebook: WebNotebook,
  sessionId: string,
  previous: WebNotebookCursor | undefined,
  deps: WebSyncDeps
): Promise<WebNotebookCursor> {
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const existing = await deps.store.getImported(sessionId, deps.scopeKey);
  if (existing && isForkedImport(existing)) return { sessionId, version: notebook.version, status: 'forked' };
  // Imported once and since deleted by the user: do not bring it back.
  if ((previous?.status === 'imported' || previous?.wasImported) && !existing)
    return { ...previous, status: 'removed' };

  const { quests, truncated } = await fetchQuests(deps.api, notebook.id);
  const { messages, settled } = mapQuests(quests, notebook.updatedAt);
  const version = settled && !truncated ? notebook.version : '';
  if (messages.length === 0) {
    // Emptied on the web: drop the untouched copy so it does not keep stale messages.
    if (existing) {
      const outcome = await deps.deleteImported(sessionId, deps.scopeKey);
      if (outcome === 'forked') return { sessionId, version, status: 'forked' };
    }
    return { sessionId, version, status: 'skipped' };
  }

  const session: ChatSession = {
    id: sessionId,
    title: deriveTitle(notebook.name),
    model: existing?.model ?? (await deps.pickModel()) ?? '',
    createdAt: notebook.createdAt,
    updatedAt: notebook.updatedAt,
    mode: 'chat',
    approvalMode: 'ask',
    reasoningEffort: 'default',
    importOrigin: {
      kind: 'b4m-web',
      sourceId: notebook.id,
      importedAt: existing?.importOrigin?.importedAt || now,
      sourceUpdatedAt: notebook.updatedAt,
      ...(settled ? {} : { running: true }),
    },
    messages,
  };
  const outcome = await deps.store.putImported(session, deps.scopeKey, { mustExist: !!existing });
  return { sessionId, version, status: outcome === 'written' ? 'imported' : outcome };
}

export function webCounts(notebooks: Record<string, WebNotebookCursor>): ClaudeImportCounts & { forked: number } {
  const counts = { found: 0, imported: 0, skipped: 0, failed: 0, forked: 0 };
  for (const cursor of Object.values(notebooks)) {
    if (cursor.status === 'removed') continue;
    counts.found++;
    if (cursor.status === 'imported') counts.imported++;
    else if (cursor.status === 'forked') {
      counts.imported++;
      counts.forked++;
    } else if (cursor.status === 'failed') counts.failed++;
    else counts.skipped++;
  }
  return counts;
}
