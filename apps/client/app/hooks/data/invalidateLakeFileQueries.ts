import type { QueryClient } from '@tanstack/react-query';
import { dataLakeKeys } from '@client/app/hooks/data/dataLakeKeys';

/** Refresh one lake's file lists and every tag count - what a connector purge or ingest makes stale. */
export function invalidateLakeFileQueries(queryClient: QueryClient, dataLakeId: string) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: dataLakeKeys.filesOf(dataLakeId) }),
    queryClient.invalidateQueries({ queryKey: dataLakeKeys.tagCountsRoot }),
  ]);
}
