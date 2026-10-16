import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { isAxiosError } from 'axios';
import type { IntegrationDemandResponse, IntegrationRequestersResponse } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';

// Admin reads of integration-request demand (pages/api/admin/integrations/demand/).

const REQUESTERS_PAGE_SIZE = 50;
// The route's own ceiling; "Copy emails" walks the list in as few requests as it allows.
const REQUESTERS_MAX_PAGE_SIZE = 100;
/** "Copy emails" gives up after this many pages and says the list is cut short. */
export const REQUESTER_EMAILS_MAX_PAGES = 50;
export const REQUESTER_EMAILS_MAX_ROWS = REQUESTER_EMAILS_MAX_PAGES * REQUESTERS_MAX_PAGE_SIZE;

export const integrationDemandKeys = {
  all: ['admin', 'integration-demand'] as const,
  requesters: (integrationId: string) => ['admin', 'integration-demand', 'requesters', integrationId] as const,
};

/** The route's per-minute limiter said no (429); worth telling the admin to wait rather than to retry at once. */
export const isRateLimited = (error: unknown): boolean => isAxiosError(error) && error.response?.status === 429;

const requestersPath = (integrationId: string) =>
  `/api/admin/integrations/demand/${encodeURIComponent(integrationId)}/requesters`;

export function useIntegrationDemand() {
  return useQuery({
    queryKey: integrationDemandKeys.all,
    queryFn: async () => {
      const { data } = await api.get<IntegrationDemandResponse>('/api/admin/integrations/demand');
      return data;
    },
    staleTime: 60_000,
  });
}

/** Requesters of one integration, newest first; disabled until an integration is picked. */
export function useIntegrationRequesters(integrationId: string | null) {
  return useInfiniteQuery({
    queryKey: integrationDemandKeys.requesters(integrationId ?? ''),
    enabled: integrationId !== null,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      const { data } = await api.get<IntegrationRequestersResponse>(requestersPath(integrationId!), {
        params: { limit: REQUESTERS_PAGE_SIZE, cursor: pageParam },
      });
      return data;
    },
    getNextPageParam: lastPage => lastPage.next_cursor ?? undefined,
    // Retrying a throttled request only spends the next minute's allowance.
    retry: (failureCount, error) => !isRateLimited(error) && failureCount < 3,
    staleTime: 60_000,
  });
}

export interface RequesterEmails {
  emails: string[];
  /** More requesters exist than REQUESTER_EMAILS_MAX_PAGES pages hold; `emails` is the newest of them. */
  truncated: boolean;
}

/**
 * Every distinct email among an integration's requesters, across pages rather than only the loaded
 * ones, newest first. Stops at REQUESTER_EMAILS_MAX_PAGES pages so a huge list cannot hold the tab
 * (or the route's limiter) hostage; `truncated` says it did. Deleted accounts are skipped.
 */
export async function fetchAllRequesterEmails(integrationId: string): Promise<RequesterEmails> {
  const emails = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < REQUESTER_EMAILS_MAX_PAGES; page++) {
    const { data } = await api.get<IntegrationRequestersResponse>(requestersPath(integrationId), {
      params: { limit: REQUESTERS_MAX_PAGE_SIZE, cursor },
    });
    for (const requester of data.data) if (requester.email && !requester.deleted) emails.add(requester.email);
    cursor = data.next_cursor ?? undefined;
    if (!cursor) return { emails: [...emails], truncated: false };
  }
  return { emails: [...emails], truncated: true };
}
