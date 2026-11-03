import { adminRiskEvidenceViewSchema, type AdminRiskEvidenceView } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { useQuery } from '@tanstack/react-query';

export const adminRiskEvidenceQueryKey = (userId: string) => ['admin-user-risk-evidence', userId];

/** Shadow-only behavioral evidence for one account; read-only, admin endpoint. */
export function useAdminRiskEvidence(userId: string) {
  return useQuery({
    queryKey: adminRiskEvidenceQueryKey(userId),
    queryFn: async (): Promise<AdminRiskEvidenceView> => {
      const response = await api.get<unknown>(`/api/admin/users/${encodeURIComponent(userId)}/risk-evidence`);
      return adminRiskEvidenceViewSchema.parse(response.data);
    },
    enabled: Boolean(userId),
  });
}
