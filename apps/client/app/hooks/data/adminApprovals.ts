import { useMutation, useInfiniteQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { AdminApprovalAction, AdminApprovalStatus } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';

export const ADMIN_APPROVALS_KEY = ['admin', 'approvals'] as const;

export type AdminApprovalStatusFilter = AdminApprovalStatus | 'all';

/** One row of GET /api/admin/approvals; dates arrive as ISO strings. */
export type AdminApprovalRow = {
  id: string;
  action: AdminApprovalAction;
  /** null when the caller neither requested the row nor may decide it, like `params`. */
  summary: string | null;
  reason: string | null;
  status: AdminApprovalStatus;
  /** Absent on a row the caller neither requested nor may decide, as is everything below but the flags. */
  requestedBy?: { id: string; name: string; email: string };
  expiresAt: string;
  createdAt?: string;
  decidedBy?: { id: string; name: string };
  decisionReason?: string;
  error?: string;
  result?: unknown;
  params: unknown;
  stalled: boolean;
  canDecide: boolean;
};

/** The 202 body a gated admin action answers with instead of running. */
export type ApprovalPendingResponse = { approvalId: string; status: 'pending'; expiresAt: string };

export const isApprovalPending = (data: unknown): data is ApprovalPendingResponse =>
  typeof data === 'object' &&
  data !== null &&
  (data as { status?: unknown }).status === 'pending' &&
  typeof (data as { approvalId?: unknown }).approvalId === 'string';

export const APPROVAL_SUBMITTED_MESSAGE = 'Submitted for approval. Another admin must approve it under Approvals.';

export const notifyApprovalSubmitted = (queryClient: QueryClient) => {
  toast.info(APPROVAL_SUBMITTED_MESSAGE);
  queryClient.invalidateQueries({ queryKey: ADMIN_APPROVALS_KEY });
};

export type AdminApprovalCursor = { before: string; beforeId: string };
type AdminApprovalsPage = { approvals: AdminApprovalRow[]; nextCursor: AdminApprovalCursor | null };

export function useAdminApprovals(status: AdminApprovalStatusFilter) {
  const query = useInfiniteQuery({
    queryKey: [...ADMIN_APPROVALS_KEY, status],
    initialPageParam: null as AdminApprovalCursor | null,
    queryFn: async ({ pageParam }) => {
      const { data } = await api.get<AdminApprovalsPage>('/api/admin/approvals', {
        params: { status, ...pageParam },
      });
      return data;
    },
    getNextPageParam: page => page.nextCursor ?? undefined,
  });
  return { ...query, data: query.data?.pages.flatMap(page => page.approvals) };
}

/** An approved action may have changed users, orgs or subscriptions, so their lists refetch too. */
const invalidateAfterDecision = (queryClient: QueryClient) => {
  queryClient.invalidateQueries({ queryKey: ['admin'] });
  queryClient.invalidateQueries({ queryKey: ['users'] });
  queryClient.invalidateQueries({ queryKey: ['organizations'] });
  queryClient.invalidateQueries({ queryKey: ['subscriptions'] });
};

export function useApproveAdminApproval() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data } = await api.post<{ approval: AdminApprovalRow; result?: unknown }>(
        `/api/admin/approvals/${id}/approve`
      );
      return data;
    },
    onSettled: () => invalidateAfterDecision(queryClient),
  });
}

export function useRejectAdminApproval() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason: string }) => {
      const { data } = await api.post<{ approval: AdminApprovalRow }>(`/api/admin/approvals/${id}/reject`, {
        reason,
      });
      return data;
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ADMIN_APPROVALS_KEY }),
  });
}
