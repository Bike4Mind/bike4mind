import { IMementoDocument } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { useQuery } from '@tanstack/react-query';

export function useGetMementos() {
  return useQuery({
    queryKey: ['mementos'],
    queryFn: async () => {
      const response = await api.get<IMementoDocument[]>('/api/mementos');
      return response.data;
    },
  });
}
