import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { isAxiosError } from 'axios';
import { api } from '@client/app/contexts/ApiContext';
import { toast } from 'sonner';

const ADMIN_GRANTS_KEY = ['admin', 'organizations', 'grants'] as const;

/**
 * Unwrap the server's error message from an axios error so users see the
 * actual reason (e.g. "Cannot reduce seats below current team size...")
 * instead of the generic "Request failed with status code 400".
 */
const apiErrorMessage = (err: unknown, fallback: string): string => {
  if (isAxiosError(err)) {
    return err.response?.data?.error || err.response?.data?.message || err.message || fallback;
  }
  return err instanceof Error ? err.message : fallback;
};

type GrantSummary = {
  id: string;
  ownerId: string; // organization id
  grantedBy?: string;
  grantedReason?: string;
  quantity: number;
  periodEndsAt: string;
};

/**
 * Active admin_grant Subscriptions across all Organizations. Used by the
 * admin UI to render a "Granted" badge per org row.
 */
export function useAdminOrgGrants() {
  return useQuery({
    queryKey: ADMIN_GRANTS_KEY,
    queryFn: async () => {
      const res = await api.get<{ grants: GrantSummary[] }>('/api/admin/organizations/grants');
      return res.data.grants;
    },
    staleTime: 1000 * 30,
  });
}

export function useGrantOrganization() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: {
      name: string;
      ownerEmail: string;
      seats: number;
      initialCredits: number;
      reason: string;
    }) => {
      const res = await api.post<{ organizationId: string }>('/api/admin/organizations/grant', params);
      return res.data;
    },
    onSuccess: () => {
      toast.success('Free organization granted');
      queryClient.invalidateQueries({ queryKey: ['organizations'] });
      queryClient.invalidateQueries({ queryKey: ADMIN_GRANTS_KEY });
    },
    onError: err => toast.error(apiErrorMessage(err, 'Grant failed')),
  });
}

export function useTopUpOrganization() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: { organizationId: string; credits: number; reason?: string }) => {
      const { organizationId, ...body } = params;
      // Generate a fresh idempotency key for each mutation so the API can
      // safely no-op on double-clicks / retries.
      const idempotencyKey =
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const res = await api.post(`/api/admin/organizations/${organizationId}/top-up`, {
        ...body,
        idempotencyKey,
      });
      return res.data;
    },
    onSuccess: () => {
      toast.success('Credits added');
      queryClient.invalidateQueries({ queryKey: ['organizations'] });
    },
    onError: err => toast.error(apiErrorMessage(err, 'Top-up failed')),
  });
}

export function useAdjustOrgSeats() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: { organizationId: string; seats: number }) => {
      const { organizationId, seats } = params;
      const res = await api.patch(`/api/admin/organizations/${organizationId}/seats`, { seats });
      return res.data;
    },
    onSuccess: () => {
      toast.success('Seats updated');
      queryClient.invalidateQueries({ queryKey: ['organizations'] });
    },
    onError: err => toast.error(apiErrorMessage(err, 'Seat update failed')),
  });
}

export function useConvertOrgToPaid() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: { organizationId: string; callbackUrl: string }) => {
      const { organizationId, callbackUrl } = params;
      const res = await api.post<{ checkoutUrl: string }>(
        `/api/admin/organizations/${organizationId}/convert-to-paid`,
        { callbackUrl }
      );
      return res.data;
    },
    onSuccess: () => {
      // The Granted badge keys off ADMIN_GRANTS_KEY; refresh so it disappears
      // once the conversion webhook lands. Without this it sticks around for
      // the full staleTime (30s) after the user has already paid.
      queryClient.invalidateQueries({ queryKey: ADMIN_GRANTS_KEY });
      queryClient.invalidateQueries({ queryKey: ['organizations'] });
    },
    onError: err => toast.error(apiErrorMessage(err, 'Conversion failed')),
  });
}

export function useRevokeOrganization() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: { organizationId: string; reason?: string }) => {
      const { organizationId, ...body } = params;
      const res = await api.post(`/api/admin/organizations/${organizationId}/revoke`, body);
      return res.data;
    },
    onSuccess: () => {
      toast.success('Grant revoked');
      queryClient.invalidateQueries({ queryKey: ['organizations'] });
      queryClient.invalidateQueries({ queryKey: ADMIN_GRANTS_KEY });
    },
    onError: err => toast.error(apiErrorMessage(err, 'Revoke failed')),
  });
}
