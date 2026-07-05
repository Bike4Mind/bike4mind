import { useMutation } from '@tanstack/react-query';
import { api } from '../contexts/ApiContext';

const useRefineText = (callbacks?: { onSuccess?: (text: string) => void }) => {
  return useMutation({
    mutationFn: async (values: { text: string; context?: string }) => {
      const response = await api.get<{ text: string }>('/api/ai/refineText', {
        params: values,
      });

      return response.data;
    },
    onSuccess: data => {
      callbacks?.onSuccess?.(data.text);
    },
  });
};

export default useRefineText;
