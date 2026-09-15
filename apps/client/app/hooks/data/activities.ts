import { IActivityDocument } from '@bike4mind/common';
import { PaginatedResponse } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { useQuery } from '@tanstack/react-query';

interface GetActivitiesParams {
  projectId?: string;
  page?: number;
  limit?: number;
}

export function useGetActivities(params: GetActivitiesParams = {}) {
  return useQuery({
    queryKey: ['activities', params],
    queryFn: async () => {
      const { data } = await api.get<PaginatedResponse<IActivityDocument>>('/api/activities', {
        params,
      });
      return data;
    },
    staleTime: 1000 * 30, // 30 seconds
  });
}
