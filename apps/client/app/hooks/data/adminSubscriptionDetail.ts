import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { isAxiosError } from 'axios';
import { toast } from 'sonner';
import type { AuditLogPage } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { getErrorMessage } from '@client/app/utils/error';
import type {
  AdminCompChange,
  AdminCompChangeResponse,
  AdminSubscriptionByStripeIdResponse,
  AdminSubscriptionDetail,
} from '@client/app/utils/adminSubscriptionDetail';
import { reviveAuditEntry, type WireAuditEntry } from './adminAuditLog';
import { ADMIN_GRANTS_KEY } from './adminOrganizations';

const ADMIN_LOG_PAGE_SIZE = 50;
const MAX_RETRIES = 3;

export const isNotFoundError = (error: unknown): boolean => isAxiosError(error) && error.response?.status === 404;

// A missing record will not appear on retry.
const retryUnlessNotFound = (failureCount: number, error: unknown) =>
  !isNotFoundError(error) && failureCount < MAX_RETRIES;

/** Ids are interpolated into API paths, so only an ObjectId is ever fetched. */
export const isSubscriptionObjectId = (value: string): boolean => /^[0-9a-f]{24}$/i.test(value);

// Everything sits under ['admin', 'subscriptions'], so invalidating that prefix (as every subscription
// write does) refreshes the detail, its admin log and the list together.
export const adminSubscriptionDetailKey = (id: string) => ['admin', 'subscriptions', 'detail', id] as const;
export const adminSubscriptionAdminLogKey = (id: string) => [...adminSubscriptionDetailKey(id), 'admin-log'] as const;
const adminSubscriptionByStripeIdKey = (stripeSubscriptionId: string) =>
  ['admin', 'subscriptions', 'by-stripe', stripeSubscriptionId] as const;

const subscriptionPath = (id: string) => `/api/admin/subscriptions/${encodeURIComponent(id)}`;

export const useAdminSubscriptionDetail = (id: string) =>
  useQuery({
    queryKey: adminSubscriptionDetailKey(id),
    queryFn: async (): Promise<AdminSubscriptionDetail> =>
      (await api.get<AdminSubscriptionDetail>(subscriptionPath(id))).data,
    enabled: isSubscriptionObjectId(id),
    retry: retryUnlessNotFound,
  });

/** Resolves a Stripe subscription id (`sub_...`) to the Mongo id the detail page is keyed on. */
export const useAdminSubscriptionIdByStripeId = (stripeSubscriptionId: string) =>
  useQuery({
    queryKey: adminSubscriptionByStripeIdKey(stripeSubscriptionId),
    queryFn: async (): Promise<AdminSubscriptionByStripeIdResponse> =>
      (
        await api.get<AdminSubscriptionByStripeIdResponse>(
          `/api/admin/subscriptions/by-stripe/${encodeURIComponent(stripeSubscriptionId)}`
        )
      ).data,
    enabled: stripeSubscriptionId.length > 0,
    retry: retryUnlessNotFound,
  });

export const useAdminSubscriptionAdminLog = (id: string) =>
  useInfiniteQuery({
    queryKey: adminSubscriptionAdminLogKey(id),
    queryFn: async ({ pageParam }): Promise<AuditLogPage> => {
      const params: Record<string, string> = { limit: String(ADMIN_LOG_PAGE_SIZE) };
      if (pageParam) params.cursor = pageParam;
      const response = await api.get<{ entries: WireAuditEntry[]; nextCursor: string | null }>(
        `${subscriptionPath(id)}/admin-log`,
        { params }
      );
      return { ...response.data, entries: response.data.entries.map(reviveAuditEntry) };
    },
    getNextPageParam: lastPage => lastPage.nextCursor ?? undefined,
    initialPageParam: undefined as string | undefined,
    enabled: isSubscriptionObjectId(id),
  });

export type AdminCompChangeRequest = AdminCompChange & { reason: string };

/**
 * Extend, end or reopen a comp. Failures toast here and reject, so an ActionDialog stays open; success
 * shows nothing, because the caller confirms with an UndoToast.
 */
export const useAdminSubscriptionCompChange = (id: string) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: AdminCompChangeRequest): Promise<AdminCompChangeResponse> =>
      (await api.post<AdminCompChangeResponse>(`${subscriptionPath(id)}/comp`, body)).data,
    onSuccess: ({ subscription }) => {
      // Show the new row at once; the invalidation below then refreshes the derived fields.
      queryClient.setQueryData<AdminSubscriptionDetail>(adminSubscriptionDetailKey(id), current =>
        current ? { ...current, subscription } : current
      );
      // Covers this detail and its admin log too (see the key comment above).
      void queryClient.invalidateQueries({ queryKey: ['admin', 'subscriptions'] });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'user-subscriptions'] });
      void queryClient.invalidateQueries({ queryKey: ADMIN_GRANTS_KEY });
    },
    onError: error => {
      toast.error(getErrorMessage(error));
    },
  });
};
