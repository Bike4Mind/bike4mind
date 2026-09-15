import { useQuery } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import { ModelStatsResponse } from '@pages/api/models/stats';

const fetchModelStats = async (): Promise<ModelStatsResponse> => {
  const response = await api.get('/api/models/stats');
  return response.data;
};

export const useModelStats = () => {
  return useQuery({
    queryKey: ['model-stats'],
    queryFn: fetchModelStats,
    staleTime: 1000 * 60 * 60, // 1 hour
  });
};
