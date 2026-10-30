import { useQuery } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import { AdminActivitySummarySchema } from '@client/shared/adminActivitySummary';

export function useAdminActivitySummary() {
  return useQuery({
    queryKey: ['admin-activity-summary'],
    queryFn: async () => {
      const response = await api.get('/api/admin/activity-summary');
      return AdminActivitySummarySchema.parse(response.data);
    },
    staleTime: 60 * 1000,
  });
}
