import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { OrgModelPolicy, StoredOrgModelPolicy } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { catalogQueryKey } from '@client/app/hooks/data/useModelInfo';
import { getErrorMessage } from '@client/app/utils/error';

/** Mirrors OrgModelPolicyView in server/organizations/orgModelPolicy.ts. */
export type OrgModelPolicyView = {
  policy: StoredOrgModelPolicy;
  /** The stored row failed validation, so enforcement treats the org as allowing nothing. */
  invalidStored: boolean;
};

export const orgModelPolicyQueryKey = (orgId: string) => ['org-model-policy', orgId] as const;

const policyUrl = (orgId: string) => `/api/organizations/${orgId}/model-policy`;

export function useOrgModelPolicy(orgId: string) {
  return useQuery({
    queryKey: orgModelPolicyQueryKey(orgId),
    queryFn: async () => (await api.get<OrgModelPolicyView>(policyUrl(orgId))).data,
    enabled: !!orgId,
  });
}

// The picker's list is filtered by this policy, so it refetches after either mutation.
function useApplyPolicyView(orgId: string) {
  const queryClient = useQueryClient();
  return async (view: OrgModelPolicyView) => {
    queryClient.setQueryData(orgModelPolicyQueryKey(orgId), view);
    const queryKey = catalogQueryKey(orgId);
    await queryClient.cancelQueries({ queryKey, exact: true });
    await queryClient.invalidateQueries({ queryKey, exact: true, refetchType: 'active' });
  };
}

export function useSaveOrgModelPolicy(orgId: string) {
  const apply = useApplyPolicyView(orgId);
  return useMutation({
    mutationFn: async (policy: OrgModelPolicy) => (await api.put<OrgModelPolicyView>(policyUrl(orgId), policy)).data,
    onSuccess: async view => {
      await apply(view);
      toast.success('Model policy saved');
    },
    onError: (error: unknown) => {
      toast.error(getErrorMessage(error));
    },
  });
}

export function useResetOrgModelPolicy(orgId: string) {
  const apply = useApplyPolicyView(orgId);
  return useMutation({
    mutationFn: async () => (await api.delete<OrgModelPolicyView>(policyUrl(orgId))).data,
    onSuccess: async view => {
      await apply(view);
      toast.success('Model policy reset to unrestricted');
    },
    onError: (error: unknown) => {
      toast.error(getErrorMessage(error));
    },
  });
}
