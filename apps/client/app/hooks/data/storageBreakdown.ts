import { useEffect, useRef } from 'react';
import { StorageBreakdownResponse } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { useUser } from '@client/app/contexts/UserContext';
import { useQuery, useQueryClient } from '@tanstack/react-query';

const STORAGE_BREAKDOWN_QUERY_KEY = ['users', 'me', 'storage-breakdown'] as const;
// The usage counter is pushed once per charged file, so a bulk ingest moves it many times a second.
// An open panel refetches at most once per window instead of once per push (the endpoint is rate limited).
export const STORAGE_BREAKDOWN_REFRESH_WINDOW_MS = 5000;

export const useGetStorageBreakdown = ({ enabled = true }: { enabled?: boolean } = {}) => {
  const { currentUser } = useUser();
  const queryClient = useQueryClient();
  const storageSize = currentUser?.currentStorageSize ?? 0;
  const lastSeenStorageSize = useRef(storageSize);
  const pendingRefresh = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (storageSize === lastSeenStorageSize.current) return;
    lastSeenStorageSize.current = storageSize;
    // A closed panel needs no timer: the query is always stale, so opening it fetches fresh data.
    if (!enabled || pendingRefresh.current) return;
    pendingRefresh.current = setTimeout(() => {
      pendingRefresh.current = null;
      void queryClient.invalidateQueries({ queryKey: STORAGE_BREAKDOWN_QUERY_KEY });
    }, STORAGE_BREAKDOWN_REFRESH_WINDOW_MS);
  }, [enabled, storageSize, queryClient]);

  useEffect(
    () => () => {
      if (pendingRefresh.current) clearTimeout(pendingRefresh.current);
      pendingRefresh.current = null;
    },
    [enabled]
  );

  return useQuery({
    queryKey: STORAGE_BREAKDOWN_QUERY_KEY,
    queryFn: async () => {
      const { data } = await api.get<StorageBreakdownResponse>('/api/users/me/storage-breakdown');
      return data;
    },
    enabled,
  });
};
