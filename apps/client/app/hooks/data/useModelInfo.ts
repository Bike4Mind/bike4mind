import { useQuery } from '@tanstack/react-query';
import { getModels } from '@client/app/utils/llm';

export function useModelInfo() {
  return useQuery({
    queryKey: ['llm', 'models'],
    queryFn: getModels,
    staleTime: 60 * 60 * 1000, // 1 hour
    enabled: true,
    retry: false,
  });
}
