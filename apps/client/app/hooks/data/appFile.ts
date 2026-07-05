import { api } from '@client/app/contexts/ApiContext';
import { IAppFileGetAllApiResponse } from '@bike4mind/common';
import { useQuery } from '@tanstack/react-query';

export function useGetReports() {
  const params = {
    tags: [],
  };

  return useQuery({
    queryKey: ['app-files', params],
    queryFn: () =>
      api
        .get<IAppFileGetAllApiResponse>('/api/app-files', {
          params,
        })
        .then(res => res.data),
    staleTime: 60000, // 1 minute
  });
}
