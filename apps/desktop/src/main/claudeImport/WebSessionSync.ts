import type { ChatSession } from '@shared/chat';
import type { ClaudeImportCounts } from '@shared/claudeImport';
import { deriveTitle, isForkedImport, type SessionStore } from '../chat/SessionStore';
import type { WebNotebookCursor } from './ImportStateStore';
import { mapQuests, readNotebook, type WebNotebook } from './webSessionMapper';

const LIST_PATH = '/api/sessions';
const LIST_PAGE_SIZE = 100;
/** Past this the list is treated as partial, and nothing is pruned for having gone missing. */
const MAX_LIST_PAGES = 50;
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

interface Page {
  data: unknown[];
  hasMore: boolean;
}

function pageOf(result: unknown): Page {
  if (Array.isArray(result)) return { data: result, hasMore: false };
  const envelope = (result && typeof result === 'object' ? result : {}) as { data?: unknown; hasMore?: unknown };
  return { data: Array.isArray(envelope.data) ? envelope.data : [], hasMore: envelope.hasMore === true };
}

function pagedUrl(path: string, page: number, limit: number, extra: Record<string, string> = {}): string {
  const query = new URLSearchParams({
    ...extra,
    'pagination[page]': String(page),
    'pagination[limit]': String(limit),
  });
  return `${path}?${query.toString()}`;
}

export function webSessionId(notebookId: string, scopeTag: string): string {
  return `bw-${scopeTag}-${notebookId}`;
}

/** Every notebook the account owns on the web; `complete` is false when the list was cut short. */
export async function listWebNotebooks(api: WebApi): Promise<{ notebooks: WebNotebook[]; complete: boolean }> {
  const notebooks = new Map<string, WebNotebook>();
  for (let page = 1; page <= MAX_LIST_PAGES; page++) {
    const result = pageOf(
      await api.get(
        pagedUrl(LIST_PATH, page, LIST_PAGE_SIZE, { 'orderBy[field]': 'lastUpdated', 'orderBy[direction]': 'desc' })
      )
    );
    for (const row of result.data) {
      const notebook = readNotebook(row);
      if (notebook && !notebooks.has(notebook.id)) notebooks.set(notebook.id, notebook);
    }
    if (!result.hasMore) return { notebooks: [...notebooks.values()], complete: true };
  }
  return { notebooks: [...notebooks.values()], complete: false };
}

export async function fetchQuests(api: WebApi, notebookId: string): Promise<unknown[]> {
  const quests: unknown[] = [];
  const path = `${LIST_PATH}/${encodeURIComponent(notebookId)}/chat`;
  for (let page = 1; page <= MAX_CHAT_PAGES; page++) {
    const result = pageOf(await api.get(pagedUrl(path, page, CHAT_PAGE_SIZE, { sort: 'asc' })));
    quests.push(...result.data);
    if (!result.hasMore) break;
  }
  return quests;
}

/** True when the notebook changed since it was read, or the last read failed, and the copy is still ours. */
export function needsWebImport(notebook: WebNotebook, cursor: WebNotebookCursor | undefined): boolean {
  if (!cursor || cursor.status === 'failed') return true;
  if (cursor.status === 'forked' || cursor.status === 'removed') return false;
  return cursor.version !== notebook.version;
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
  if (previous?.status === 'imported' && !existing) return { ...previous, status: 'removed' };

  const { messages, settled } = mapQuests(await fetchQuests(deps.api, notebook.id), notebook.updatedAt);
  const version = settled ? notebook.version : '';
  if (messages.length === 0) {
    // Emptied on the web: drop the untouched copy so it does not keep stale messages.
    if (existing) await deps.deleteImported(sessionId, deps.scopeKey);
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
