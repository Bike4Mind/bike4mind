import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AccessReviewDecision, AccessReviewDecisionValue, AdminAccessReviewRecord } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { downloadData } from '@client/app/utils/download';

type Wire<T> = { [K in keyof T]: T[K] extends Date ? string : T[K] extends Date | null ? string | null : T[K] };

export type WireAccessReviewDecision = Wire<AccessReviewDecision>;
export type WireAccessReviewRecord = Omit<Wire<AdminAccessReviewRecord>, 'decisions'> & {
  decisions: WireAccessReviewDecision[];
};

/** One row of `GET /api/admin/access-review/report`; mirrors `AccessReviewRow` in apps/client/server/admin/accessReview.ts. */
export type AccessReviewRow = {
  userId: string;
  email: string | null;
  username: string | null;
  fullAdmin: boolean;
  permissions: string[];
  directPermissions: string[];
  adminRoleIds: string[];
  lastAdminActionAt: string | null;
  lastSignInAt: string | null;
  mfaEnabled: boolean;
  grantedBy: { userId: string | null; name: string; email: string | null } | null;
  grantedAt: string | null;
  dormant: boolean;
  noMfa: boolean;
  decision: WireAccessReviewDecision | null;
};

export type AccessReviewReport = {
  quarter: string;
  generatedAt: string;
  dormantDays: number;
  overdue: boolean;
  admins: AccessReviewRow[];
  record: WireAccessReviewRecord | null;
};

export type AccessReviewStatus = { quarter: string; overdue: boolean; completedAt: string | null };

export type AccessReviewDecisionResult = {
  completed: boolean;
  pending: number;
  /** The only undecided row is the caller's own, which another full admin has to confirm. */
  pendingSelf: boolean;
};

const reportKey = ['admin', 'access-review', 'report'] as const;
const statusKey = ['admin', 'access-review', 'status'] as const;

export const useAccessReviewReport = (dormantDays: number) =>
  useQuery({
    queryKey: [...reportKey, dormantDays],
    queryFn: async () =>
      (await api.get<AccessReviewReport>('/api/admin/access-review/report', { params: { dormantDays } })).data,
  });

export const useAccessReviewStatus = (enabled: boolean) =>
  useQuery({
    queryKey: statusKey,
    queryFn: async () => (await api.get<AccessReviewStatus>('/api/admin/access-review/status')).data,
    enabled,
    staleTime: 5 * 60_000,
  });

export const useAccessReviewDecision = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { userId: string; decision: AccessReviewDecisionValue; dormantDays?: number }) =>
      (await api.post<AccessReviewDecisionResult>('/api/admin/access-review/decisions', input)).data,
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: reportKey }),
        queryClient.invalidateQueries({ queryKey: statusKey }),
      ]),
  });
};

/** The export route authenticates by bearer token, so it is fetched through the API client, not linked to. */
export const downloadAccessReviewCsv = async (quarter: string) => {
  const response = await api.get<string>('/api/admin/access-review/export', {
    params: { quarter },
    responseType: 'text',
  });
  downloadData(response.data, `access-review-${quarter}.csv`, 'text/csv');
};
