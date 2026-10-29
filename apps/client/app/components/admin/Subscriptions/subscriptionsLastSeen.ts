import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { create } from 'zustand';
import { api } from '@client/app/contexts/ApiContext';
import type { AdminSubscriptionsListResponse } from '@client/app/utils/adminSubscriptionsFilter';
import { adminSubscriptionsQueryKey } from './useAdminSubscriptionsList';

/** Newest Stripe row acknowledged by this browser, as an ISO string. Per browser on purpose. */
export const SUBSCRIPTIONS_LAST_SEEN_KEY = 'admin-subscriptions-last-seen';
export const NEW_SUBSCRIPTIONS_POLL_MS = 5 * 60_000;

// Newest Stripe-billed row first; comps are made by admins, so they never light the dot.
export const NEWEST_PAID_SUBSCRIPTION_QUERY = {
  source: 'stripe',
  page: 1,
  limit: 25,
  sortField: 'createdAt',
  sortOrder: 'desc',
} as const;

const newestPaidQueryKey = [...adminSubscriptionsQueryKey, 'newest-paid'] as const;

const fetchNewestPaid = async (): Promise<string | null> => {
  const { data } = await api.get<AdminSubscriptionsListResponse>('/api/admin/subscriptions', {
    params: NEWEST_PAID_SUBSCRIPTION_QUERY,
  });
  return data.subscriptions[0]?.createdAt ?? null;
};

const parseLastSeen = (value: string | null): string | null =>
  value && Number.isFinite(Date.parse(value)) ? value : null;

// Storage can be blocked or throw (private windows, cleared site data); the in-memory value carries on.
export const readStoredLastSeen = (): string | null => {
  try {
    return parseLastSeen(window.localStorage.getItem(SUBSCRIPTIONS_LAST_SEEN_KEY));
  } catch {
    return null;
  }
};

const writeStoredLastSeen = (value: string) => {
  try {
    window.localStorage.setItem(SUBSCRIPTIONS_LAST_SEEN_KEY, value);
  } catch {
    // Same as above: the dot still clears for this session.
  }
};

export const useSubscriptionsLastSeen = create<{ lastSeen: string | null; markSeen: (at: Date) => void }>()(set => ({
  lastSeen: readStoredLastSeen(),
  markSeen: at => {
    set(state => {
      const stored = readStoredLastSeen();
      const lastSeen = [at.toISOString(), state.lastSeen, stored]
        .filter((value): value is string => value !== null)
        .reduce((latest, value) => (Date.parse(value) > Date.parse(latest) ? value : latest));
      if (stored !== lastSeen) writeStoredLastSeen(lastSeen);
      return state.lastSeen === lastSeen ? state : { lastSeen };
    });
  },
}));

export const isNewSince = (createdAt: string | null | undefined, since: string | null): boolean =>
  !!createdAt && !!since && Date.parse(createdAt) > Date.parse(since);

/**
 * Whether a Stripe-billed subscription started after this browser last opened the tab. Polls only
 * while `enabled` and mounted (the admin sidebar). The first run on a browser stores the newest row's
 * createdAt as the baseline, so neither existing subscriptions nor browser clock skew light the dot.
 */
export function useNewSubscriptionsDot(enabled: boolean): boolean {
  const lastSeen = useSubscriptionsLastSeen(state => state.lastSeen);
  const markSeen = useSubscriptionsLastSeen(state => state.markSeen);

  const newest = useQuery({
    queryKey: newestPaidQueryKey,
    queryFn: fetchNewestPaid,
    enabled,
    refetchInterval: NEW_SUBSCRIPTIONS_POLL_MS,
    staleTime: NEW_SUBSCRIPTIONS_POLL_MS,
  });

  // With no paid rows yet, the epoch baseline makes the first one new.
  useEffect(() => {
    if (lastSeen === null && newest.isSuccess) markSeen(new Date(newest.data ?? 0));
  }, [lastSeen, newest.isSuccess, newest.data, markSeen]);

  // Opening the tab in another browser tab clears the dot in this one.
  useEffect(() => {
    if (!enabled) return;
    const onStorage = (event: StorageEvent) => {
      if (event.key !== SUBSCRIPTIONS_LAST_SEEN_KEY) return;
      const incoming = parseLastSeen(event.newValue);
      if (incoming) useSubscriptionsLastSeen.getState().markSeen(new Date(incoming));
      else useSubscriptionsLastSeen.setState({ lastSeen: null });
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [enabled]);

  return isNewSince(newest.data, lastSeen);
}

/** Capture the visit's server watermark, acknowledging it only after the list loads successfully. */
export function useSubscriptionsSeenOnOpen(listLoaded: boolean): string | null {
  const [previous] = useState(() => useSubscriptionsLastSeen.getState().lastSeen);
  const [watermark, setWatermark] = useState<string | null>();
  const marked = useRef(false);
  const queryClient = useQueryClient();

  useEffect(() => {
    let mounted = true;
    const captureWatermark = async () => {
      try {
        const newest = await queryClient.fetchQuery({
          queryKey: newestPaidQueryKey,
          queryFn: fetchNewestPaid,
          staleTime: 0,
        });
        if (mounted) setWatermark(newest);
      } catch (error) {
        console.error('Could not capture the subscriptions visit watermark:', error);
      }
    };
    void captureWatermark();
    return () => {
      mounted = false;
    };
  }, [queryClient]);

  useEffect(() => {
    if (!listLoaded || watermark === undefined || marked.current) return;
    marked.current = true;
    useSubscriptionsLastSeen.getState().markSeen(new Date(watermark ?? 0));
  }, [listLoaded, watermark]);
  return previous;
}
