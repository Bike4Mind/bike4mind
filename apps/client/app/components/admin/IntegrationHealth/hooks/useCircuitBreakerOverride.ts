import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import type { CircuitBreakerMode, IntegrationName } from '../types';

export const useCircuitBreakerOverride = () => {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: async (payload: { integration: IntegrationName; mode: CircuitBreakerMode; reason?: string }) => {
      const { data } = await api.put('/api/admin/system-health/integration-health', payload);
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-integration-health-dashboard'] });
    },
  });

  return {
    setOverride: mutation.mutate,
    isUpdating: mutation.isPending,
    updatingIntegration: mutation.variables?.integration ?? null,
    error: mutation.error,
  };
};
