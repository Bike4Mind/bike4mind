import { StorageBreakdownResponse } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { useUser } from '@client/app/contexts/UserContext';
import { useQuery } from '@tanstack/react-query';

export const useGetStorageBreakdown = ({ enabled = true }: { enabled?: boolean } = {}) => {
  const { currentUser } = useUser();
  return useQuery({
    // Keyed on the live counter so any upload, delete or refund that moves it refetches an open panel.
    queryKey: ['users', 'me', 'storage-breakdown', currentUser?.currentStorageSize ?? 0],
    queryFn: async () => {
      const { data } = await api.get<StorageBreakdownResponse>('/api/users/me/storage-breakdown');
      return data;
    },
    enabled,
    placeholderData: previous => previous,
  });
};
