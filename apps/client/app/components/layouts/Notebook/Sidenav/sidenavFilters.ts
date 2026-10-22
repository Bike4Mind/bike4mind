import type { SessionListFilters } from '@bike4mind/common';

export type NotebookContentFilter = 'all' | 'chats' | 'images';
export type NotebookOriginFilter = 'all' | 'hideApi' | 'onlyApi';

/**
 * Maps the sidebar's Content / Origin choices to the server-side list filters of GET /api/sessions
 * and /api/sessions/shared, so paginated pages are filtered by the server, never trimmed client-side.
 * Returns undefined when neither is set, keeping the default request (and its query key) unchanged.
 */
export function toSessionListFilters(
  content: NotebookContentFilter,
  origin: NotebookOriginFilter
): SessionListFilters | undefined {
  const filters: SessionListFilters = {
    ...(content === 'images' ? { hasImages: true } : content === 'chats' ? { hasImages: false } : {}),
    ...(origin === 'onlyApi' ? { origin: 'api' } : origin === 'hideApi' ? { excludeOrigin: 'api' } : {}),
  };
  return Object.keys(filters).length ? filters : undefined;
}

/**
 * True when the choice selects a subset of notebooks that projects and agents cannot belong to
 * (they carry no origin or images), so those rows should be hidden. "Hide API" keeps them.
 */
export function narrowsToNotebooks(content: NotebookContentFilter, origin: NotebookOriginFilter): boolean {
  return content !== 'all' || origin === 'onlyApi';
}
