/**
 * The single registry for every fab-file react-query key. Mirrors dataLakeKeys.ts:
 * the fab-file cache had ~30 inline `['fabFiles', ...]` literals inside fabFiles.ts and
 * ~28 more across 15 other files; invalidations only cohere when every producer and
 * consumer names keys through here. Never write a fab-file query key as a literal
 * outside this file (the parity test is the one exception).
 *
 * Key relationships (react-query prefix matching):
 * - `all` is the bare prefix: it covers every list, search, and per-doc entry below.
 * - `own` prefixes `ownList`/`ownBySession`, so invalidating it refreshes both the
 *   paged file browser and per-session attachment lists.
 * - `doc(id)` is the per-document cache entry - list and search hooks seed it via
 *   seedFabFileDocCache (fabFileQueries.ts) - and a prefix of `content(id)`.
 */
// Type-only: keeps this module runtime-free (no cycle with the fabFiles barrel, whose
// modules value-import us).
import type { ISearchFabFilesParams } from '@client/app/hooks/data/fabFiles';

/** Filters accepted by the paged own-files list (GET /api/files). */
export interface FabFileListFilters {
  tags?: string;
  type?: 'text' | 'pdf' | 'url' | 'image' | 'excel' | 'word' | 'json' | 'csv' | 'markdown' | 'code' | 'audio';
  shared?: boolean;
  projectId?: string;
}

export const fabFileKeys = {
  all: ['fabFiles'] as const,
  /** Per-document cache entry. `null`/`undefined` ids stay in the key for parity with
   *  the pre-registry literals (those hooks are `enabled`-gated, never fetched). */
  doc: (id: string | null | undefined) => ['fabFiles', id] as const,
  content: (id: string | undefined) => ['fabFiles', id, 'content'] as const,
  name: (id: string) => ['fabFiles', 'name', id] as const,
  /** Invalidation prefix covering ownList and ownBySession. */
  own: ['fabFiles', 'own'] as const,
  ownList: (params: { search: string; filters: FabFileListFilters; sort: string; sortField: string }) =>
    ['fabFiles', 'own', params] as const,
  ownBySession: (sessionId: string) => ['fabFiles', 'own', { sessionId }] as const,
  quest: (questId: string) => ['fabFiles', 'quest', questId] as const,
  combined: (params: {
    searchTerm: string;
    filters: { type?: 'text' | 'pdf' | 'url' | 'image'; shared?: boolean };
    sort: string;
    sortField: string;
    page: number;
  }) => ['fabFiles', 'combined', params] as const,
  search: (params?: ISearchFabFilesParams) => ['fabFiles', 'search', params] as const,
  searchInfinite: (params?: ISearchFabFilesParams) => ['fabFiles', 'search', 'infinite', params] as const,
  searchPaginated: (params: ISearchFabFilesParams & { page: number }) =>
    ['fabFiles', 'search', 'paginated', params] as const,
};
