import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { IntegrationDemandResponse, IntegrationRequestersResponse } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';

// Admin reads of integration-request demand (pages/api/admin/integrations/demand/).

const REQUESTERS_PAGE_SIZE = 50;
// The route's own ceiling; "Copy emails" walks the list in as few requests as it allows.
const REQUESTERS_MAX_PAGE_SIZE = 100;

export const integrationDemandKeys = {
  all: ['admin', 'integration-demand'] as const,
  requesters: (integrationId: string) => ['admin', 'integration-demand', 'requesters', integrationId] as const,
};

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
    staleTime: 60_000,
  });
}

/** Every distinct email among an integration's requesters, across all pages rather than only the loaded ones. */
export async function fetchAllRequesterEmails(integrationId: string): Promise<string[]> {
  const emails = new Set<string>();
  let cursor: string | undefined;
  do {
    const { data } = await api.get<IntegrationRequestersResponse>(requestersPath(integrationId), {
      params: { limit: REQUESTERS_MAX_PAGE_SIZE, cursor },
    });
    for (const requester of data.data) if (requester.email) emails.add(requester.email);
    cursor = data.next_cursor ?? undefined;
  } while (cursor);
  return [...emails];
}
