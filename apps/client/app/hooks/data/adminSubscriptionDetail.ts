import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { isAxiosError } from 'axios';
import { toast } from 'sonner';
import type {
  AuditLogPage,
  SubscriptionTimelineItem,
  SubscriptionTimelineKind,
  SubscriptionTimelinePage,
} from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { getErrorMessage } from '@client/app/utils/error';
import type { AdminSubscriptionStripe } from '@client/app/utils/adminSubscriptionStripe';
import type {
  AdminCompChange,
  AdminCompChangeResponse,
  AdminStripeWriteBody,
  AdminStripeWriteResponse,
  AdminSubscriptionByStripeIdResponse,
  AdminSubscriptionDetail,
} from '@client/app/utils/adminSubscriptionDetail';
import { reviveAuditEntry, type WireAuditEntry } from './adminAuditLog';
import { ADMIN_GRANTS_KEY } from './adminOrganizations';

const ADMIN_LOG_PAGE_SIZE = 50;
const TIMELINE_PAGE_SIZE = 100;
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
export const adminSubscriptionTimelineKey = (id: string, kind: SubscriptionTimelineKind | undefined) =>
  [...adminSubscriptionDetailKey(id), 'timeline', kind ?? 'all'] as const;
const adminSubscriptionStripeKey = (id: string) => [...adminSubscriptionDetailKey(id), 'stripe'] as const;
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

const STRIPE_STALE_MS = 60_000;

// A missing record will not appear on retry, and a server or Stripe failure (502, gateway 504) already has a
// Try again button; retrying it would only add load to a degraded Stripe.
const retryStripeRead = (failureCount: number, error: unknown) =>
  !isNotFoundError(error) &&
  !(isAxiosError(error) && (error.response?.status ?? 0) >= 500) &&
  failureCount < MAX_RETRIES;

/** What the Stripe sections of the detail page need from the live read. */
export type AdminSubscriptionStripeState = {
  data: AdminSubscriptionStripe | undefined;
  isLoading: boolean;
  isError: boolean;
  isFetching: boolean;
  /** Try again: skips the server's 60 s cache. */
  refetchFresh: () => void;
};

/** The live Stripe read for one subscription; failing here never affects the detail query. */
export const useAdminSubscriptionStripe = (
  id: string,
  { enabled }: { enabled: boolean }
): AdminSubscriptionStripeState => {
  const queryClient = useQueryClient();
  const queryKey = adminSubscriptionStripeKey(id);
  const read = async (fresh: boolean): Promise<AdminSubscriptionStripe> =>
    (
      await api.get<AdminSubscriptionStripe>(`${subscriptionPath(id)}/stripe`, {
        params: fresh ? { fresh: 1 } : undefined,
      })
    ).data;
  const query = useQuery({
    queryKey,
    queryFn: () => read(false),
    enabled: enabled && isSubscriptionObjectId(id),
    staleTime: STRIPE_STALE_MS,
    retry: retryStripeRead,
  });
  return {
    data: query.data,
    isLoading: query.isLoading,
    isError: query.isError,
    isFetching: query.isFetching,
    refetchFresh: () =>
      void queryClient.fetchQuery({ queryKey, queryFn: () => read(true), staleTime: 0 }).catch(() => {}),
  };
};

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

type WireTimelineItem = Omit<SubscriptionTimelineItem, 'occurredAt' | 'audit'> & {
  occurredAt: string | Date;
  audit?: WireAuditEntry;
};

/** Dates arrive as ISO strings; admin items carry an audit row that needs the same revival. */
export const reviveSubscriptionTimelineItem = (item: WireTimelineItem): SubscriptionTimelineItem =>
  ({
    ...item,
    occurredAt: new Date(item.occurredAt),
    ...(item.audit ? { audit: reviveAuditEntry(item.audit) } : {}),
  }) as SubscriptionTimelineItem;

/** The merged Timeline feed; `kind` undefined means every source. */
export const useAdminSubscriptionTimeline = (id: string, kind: SubscriptionTimelineKind | undefined) =>
  useInfiniteQuery({
    queryKey: adminSubscriptionTimelineKey(id, kind),
    queryFn: async ({ pageParam }): Promise<SubscriptionTimelinePage> => {
      const params: Record<string, string> = { limit: String(TIMELINE_PAGE_SIZE) };
      if (kind) params.kind = kind;
      if (pageParam) params.cursor = pageParam;
      const response = await api.get<{ items: WireTimelineItem[]; nextCursor: string | null }>(
        `${subscriptionPath(id)}/timeline`,
        { params }
      );
      return { ...response.data, items: response.data.items.map(reviveSubscriptionTimelineItem) };
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

export type AdminStripeWriteRequest = AdminStripeWriteBody & { reason: string };

const useAdminStripeWrite = (id: string, path: 'cancel' | 'resume') => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: AdminStripeWriteRequest): Promise<AdminStripeWriteResponse> =>
      (await api.post<AdminStripeWriteResponse>(`${subscriptionPath(id)}/${path}`, body)).data,
    onSuccess: ({ subscription, stripe }) => {
      queryClient.setQueryData<AdminSubscriptionDetail>(adminSubscriptionDetailKey(id), current =>
        current ? { ...current, subscription, stripe } : current
      );
      void queryClient.invalidateQueries({ queryKey: ['admin', 'subscriptions'] });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'user-subscriptions'] });
    },
    // A 409 carries the server's plain-language message ("This subscription changed. Review and try again.").
    // Refetch so the retry reviews the current state instead of resending the stale token.
    onError: error => {
      toast.error(getErrorMessage(error));
      void queryClient.invalidateQueries({ queryKey: adminSubscriptionDetailKey(id) });
    },
  });
};

/** Schedules a Stripe subscription to cancel at period end. Rejects on failure so the dialog stays open. */
export const useAdminSubscriptionCancel = (id: string) => useAdminStripeWrite(id, 'cancel');

/** Clears a scheduled cancel. A separate audited write, also used as the cancel toast's undo. */
export const useAdminSubscriptionResume = (id: string) => useAdminStripeWrite(id, 'resume');
