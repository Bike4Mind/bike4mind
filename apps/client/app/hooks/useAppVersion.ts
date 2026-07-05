import { useQuery } from '@tanstack/react-query';

export const useAppVersion = () => {
  return useQuery({
    queryKey: ['appVersion'],
    queryFn: async () => {
      const response = await fetch('/version.json');
      return response.json();
    },
    staleTime: 3600000, // 1 hour
  });
};
