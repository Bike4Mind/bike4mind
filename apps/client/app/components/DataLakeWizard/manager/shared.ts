import { useGetDataLakes } from '@client/app/hooks/data/dataLakes';

export type ManagerLake = NonNullable<ReturnType<typeof useGetDataLakes>['data']>[number];

// Re-exported so the manager and any future orchestrator share TreeView's constant rather than
// keeping a second copy of the same synthetic bucket key.
export { UNCATEGORIZED_KEY } from '@client/app/components/datalake/DataLakeTreeView';

export const normalizePrefix = (fileTagPrefix: string) =>
  fileTagPrefix.endsWith(':') ? fileTagPrefix : `${fileTagPrefix}:`;

/** The prefix's namespace segments, e.g. 'books' -> ['books']. Lake navigation seeds the
 *  path past these so clicking a lake lands directly on its categories. */
export const prefixSegments = (fileTagPrefix: string) => fileTagPrefix.replace(/:+$/, '').split(':').filter(Boolean);
