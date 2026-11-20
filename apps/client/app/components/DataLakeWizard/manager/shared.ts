import { useGetDataLakes } from '@client/app/hooks/data/dataLakes';

export type ManagerLake = NonNullable<ReturnType<typeof useGetDataLakes>['data']>[number];

/** The prefix's namespace segments, e.g. 'books' -> ['books']. Lake navigation seeds the
 *  path past these so clicking a lake lands directly on its categories. */
export const prefixSegments = (fileTagPrefix: string) => fileTagPrefix.replace(/:+$/, '').split(':').filter(Boolean);
