import type { FabFileTypeFilter } from '@bike4mind/common';
import type { ISearchFabFilesParams } from '@client/app/hooks/data/fabFileSearch';
import { FILE_TYPE_OPTIONS } from './constants';

export type FileSourceFilter = 'generated' | 'uploaded';

/**
 * The typed filters a caller can start the file browser with or lock it to. A locked filter is ANDed into every
 * query and shown as a chip the user cannot remove; an initial one is only where the user starts.
 * New keys (e.g. a production) extend this type and `toSearchFilters` together.
 */
export type FileBrowserFilters = {
  source?: FileSourceFilter;
  type?: FabFileTypeFilter;
  /** Exact generation model id, as `saveGeneratedAsset` stamps it in `sourceMetadata.generation.modelId`. */
  model?: string;
  starred?: boolean;
};

export type FileBrowserFilterKey = keyof FileBrowserFilters;

type SearchFilters = NonNullable<ISearchFabFilesParams['filters']>;

/** The wire filters for a set of typed filters. Unset keys are omitted, never sent as `false`. */
export const toSearchFilters = (filters: FileBrowserFilters | undefined): SearchFilters => ({
  ...(filters?.source === 'generated' && { generated: true }),
  ...(filters?.source === 'uploaded' && { uploaded: true }),
  ...(filters?.type && { type: filters.type }),
  ...(filters?.model && { model: filters.model }),
  ...(filters?.starred && { starred: true }),
});

/** `params` with the locked filters laid over the user's, so a locked filter always wins. */
export const withLockedFilters = (
  params: ISearchFabFilesParams,
  locked: FileBrowserFilters | undefined
): ISearchFabFilesParams => {
  const lockedFilters = toSearchFilters(locked);
  if (Object.keys(lockedFilters).length === 0) return params;
  // A locked source excludes the other source, whatever the user's own filter says.
  const sourceOverride: SearchFilters = locked?.source ? { generated: undefined, uploaded: undefined } : {};
  return { ...params, filters: { ...params.filters, ...sourceOverride, ...lockedFilters } };
};

/** True when the user's own (unlocked) filters narrow the list. */
export const hasUserFilters = (params: ISearchFabFilesParams): boolean =>
  Boolean(
    params.search ||
    params.filters?.tags?.length ||
    params.filters?.type ||
    params.filters?.generated ||
    params.filters?.uploaded ||
    params.filters?.model ||
    params.filters?.starred
  );

export const isFilterLocked = (locked: FileBrowserFilters | undefined, key: FileBrowserFilterKey): boolean =>
  locked?.[key] !== undefined && locked[key] !== false;

const SOURCE_LABELS: Record<FileSourceFilter, string> = { generated: 'Generated', uploaded: 'Uploaded' };

const typeLabel = (type: FabFileTypeFilter): string =>
  FILE_TYPE_OPTIONS.find(option => option.value === type)?.label ?? type;

/** One label per locked filter, in a stable order, for the non-removable chips. */
export const lockedFilterLabels = (
  locked: FileBrowserFilters | undefined
): { key: FileBrowserFilterKey; label: string }[] => {
  if (!locked) return [];
  const labels: { key: FileBrowserFilterKey; label: string }[] = [];
  if (locked.source) labels.push({ key: 'source', label: SOURCE_LABELS[locked.source] });
  if (locked.type) labels.push({ key: 'type', label: typeLabel(locked.type) });
  if (locked.model) labels.push({ key: 'model', label: locked.model });
  if (locked.starred) labels.push({ key: 'starred', label: 'Starred' });
  return labels;
};
