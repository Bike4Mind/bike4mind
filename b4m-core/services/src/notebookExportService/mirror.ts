import { createHash } from 'node:crypto';
import { createNotebookBundle } from './bundle';
import type { BundleWrite, NotebookBundleOptions } from './bundle';
import type { ExportBundleManifest } from './bundle';
import type { ExportedNotebook } from './types';

/**
 * Pull-based mirror feed. The server returns notebooks changed since a cursor; the client keeps the
 * state and the chain head. Every entry is chained to its predecessor (like the memory ledger), so a
 * client can prove the pages it applied were complete, in order and untampered.
 */

export interface MirrorCursor {
  /** `lastUpdated` (epoch ms) of the last notebook delivered. */
  at: number;
  /** Id of the last notebook delivered; breaks ties between notebooks sharing `at`. */
  id: string;
  /** Chain head after the last delivered entry; null before the first. */
  head: string | null;
}

export const MIRROR_GENESIS_CURSOR: MirrorCursor = { at: 0, id: '', head: null };

export interface MirrorEntry {
  notebookId: string;
  updatedAt: number;
  /** sha256 of the canonical notebook snapshot. */
  contentHash: string;
  /** sha256 over the previous link, the id, the timestamp and the content hash. */
  link: string;
  notebook: ExportedNotebook;
}

export interface MirrorPage {
  entries: MirrorEntry[];
  cursor: string;
  hasMore: boolean;
  /**
   * Every live notebook id, present only on the final page. The client prunes anything not listed,
   * which is how deletions propagate without tombstones.
   */
  liveIds?: string[];
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)))
      : v
  );

export const hashNotebook = (notebook: ExportedNotebook): string => sha256(canonical(notebook));

export const chainLink = (prev: string | null, notebookId: string, updatedAt: number, contentHash: string): string =>
  sha256(JSON.stringify([prev, notebookId, updatedAt, contentHash]));

export const encodeMirrorCursor = (cursor: MirrorCursor): string =>
  Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');

export function decodeMirrorCursor(token: string | undefined): MirrorCursor {
  if (!token) return MIRROR_GENESIS_CURSOR;
  try {
    const parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as Partial<MirrorCursor>;
    if (
      typeof parsed.at === 'number' &&
      Number.isFinite(parsed.at) &&
      typeof parsed.id === 'string' &&
      (parsed.head === null || (typeof parsed.head === 'string' && /^[a-f0-9]{64}$/.test(parsed.head)))
    ) {
      return { at: parsed.at, id: parsed.id, head: parsed.head };
    }
  } catch {
    // fall through
  }
  throw new Error('Invalid mirror cursor');
}

/** Builds a page's entries and the cursor that follows them. `notebooks` must be in feed order. */
export function sealMirrorEntries(
  from: MirrorCursor,
  notebooks: ExportedNotebook[]
): { entries: MirrorEntry[]; next: MirrorCursor } {
  let head = from.head;
  let at = from.at;
  let id = from.id;
  const entries = notebooks.map(notebook => {
    const updatedAt = Date.parse(notebook.lastUpdated);
    const contentHash = hashNotebook(notebook);
    const link = chainLink(head, notebook.id, updatedAt, contentHash);
    head = link;
    at = updatedAt;
    id = notebook.id;
    return { notebookId: notebook.id, updatedAt, contentHash, link, notebook };
  });
  return { entries, next: { at, id, head } };
}

/** Throws unless the page continues the chain from `cursor` and every snapshot matches its hash. */
export function verifyMirrorPage(cursor: MirrorCursor, page: MirrorPage): MirrorCursor {
  let head = cursor.head;
  for (const entry of page.entries) {
    if (entry.notebook.id !== entry.notebookId || hashNotebook(entry.notebook) !== entry.contentHash) {
      throw new Error(`Mirror content hash mismatch: ${entry.notebookId}`);
    }
    if (chainLink(head, entry.notebookId, entry.updatedAt, entry.contentHash) !== entry.link) {
      throw new Error(`Mirror chain broken at: ${entry.notebookId}`);
    }
    head = entry.link;
  }
  const next = decodeMirrorCursor(page.cursor);
  if (next.head !== head) throw new Error('Mirror cursor does not match the chain');
  return next;
}

/** Client-side mirror state: the latest snapshot of each notebook. */
export type MirrorState = Map<string, ExportedNotebook>;

/** Verifies and applies one page in place; returns the cursor to resume from. */
export function applyMirrorPage(state: MirrorState, cursor: MirrorCursor, page: MirrorPage): MirrorCursor {
  const next = verifyMirrorPage(cursor, page);
  for (const entry of page.entries) state.set(entry.notebookId, entry.notebook);
  if (!page.hasMore && page.liveIds) {
    const live = new Set(page.liveIds);
    for (const id of [...state.keys()]) if (!live.has(id)) state.delete(id);
  }
  return next;
}

/** Writes the state as a v2 bundle, sorted by id so output is independent of arrival order. */
export function mirrorStateToBundle(
  state: MirrorState,
  write: BundleWrite,
  metadata: NotebookBundleOptions = {}
): Promise<ExportBundleManifest> {
  const notebooks = [...state.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return createNotebookBundle(notebooks, write, metadata);
}
