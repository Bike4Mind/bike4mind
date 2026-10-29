import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { create } from 'zustand';
import { api } from '@client/app/contexts/ApiContext';
import type { AdminSubscriptionsListResponse } from '@client/app/utils/adminSubscriptionsFilter';
import { adminSubscriptionsQueryKey } from './useAdminSubscriptionsList';

/** When this browser last opened the Subscriptions tab, as an ISO string. Per browser on purpose. */
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

export const useSubscriptionsLastSeen = create<{ lastSeen: string | null; markSeen: (at?: Date) => void }>()(set => ({
  lastSeen: readStoredLastSeen(),
  markSeen: (at = new Date()) => {
    const lastSeen = at.toISOString();
    writeStoredLastSeen(lastSeen);
    set({ lastSeen });
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
    queryKey: [...adminSubscriptionsQueryKey, 'newest-paid'],
    queryFn: async () => {
      const { data } = await api.get<AdminSubscriptionsListResponse>('/api/admin/subscriptions', {
        params: NEWEST_PAID_SUBSCRIPTION_QUERY,
      });
      return data.subscriptions[0]?.createdAt ?? null;
    },
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
      if (event.key === SUBSCRIPTIONS_LAST_SEEN_KEY)
        useSubscriptionsLastSeen.setState({ lastSeen: parseLastSeen(event.newValue) });
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [enabled]);

  return isNewSince(newest.data, lastSeen);
}

/**
 * For the Subscriptions tab: returns the last-seen time from before this visit (rows started after it
 * get a New chip), and stores now, which clears the sidebar dot.
 */
export function useSubscriptionsSeenOnOpen(): string | null {
  const [previous] = useState(() => useSubscriptionsLastSeen.getState().lastSeen);
  useEffect(() => {
    useSubscriptionsLastSeen.getState().markSeen();
  }, []);
  return previous;
}
