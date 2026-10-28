import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import type {
  UserSignIn,
  UserSignInsPage,
  UserSignupCluster,
  UserTimelineEntry,
  UserTimelinePage,
  UserTimelineType,
} from '@bike4mind/common';
import { reviveAuditEntry, type WireAuditEntry } from './adminAuditLog';

const TIMELINE_PAGE_SIZE = 30;
const SIGN_IN_PAGE_SIZE = 50;

type Wire<T> = Omit<T, 'at'> & { at: string | Date };
type WireTimelineEntry = Wire<UserTimelineEntry> & { audit?: WireAuditEntry };

/** Dates arrive as ISO strings; audit-backed entries carry an audit row that needs the same revival. */
export const reviveTimelineEntry = (entry: WireTimelineEntry): UserTimelineEntry =>
  ({
    ...entry,
    at: new Date(entry.at),
    ...(entry.audit ? { audit: reviveAuditEntry(entry.audit) } : {}),
  }) as UserTimelineEntry;

export type UserTimelineFilters = {
  types: readonly UserTimelineType[];
  /** Inclusive UTC calendar days, YYYY-MM-DD. */
  from?: string;
  to?: string;
};

/** The day bounds as the endpoint's inclusive ISO instants. */
export const timelineRangeParams = ({ from, to }: Pick<UserTimelineFilters, 'from' | 'to'>) => ({
  ...(from ? { from: `${from}T00:00:00.000Z` } : {}),
  ...(to ? { to: `${to}T23:59:59.999Z` } : {}),
});

export const useUserTimeline = (
  userId: string,
  filters: UserTimelineFilters,
  options: { pageSize?: number; enabled?: boolean } = {}
) => {
  const { pageSize = TIMELINE_PAGE_SIZE, enabled = true } = options;
  const types = [...filters.types].sort().join(',');
  return useInfiniteQuery({
    queryKey: ['admin', 'users', userId, 'timeline', types, filters.from ?? '', filters.to ?? '', pageSize],
    queryFn: async ({ pageParam }): Promise<UserTimelinePage> => {
      const params: Record<string, string> = { types, limit: String(pageSize), ...timelineRangeParams(filters) };
      if (pageParam) params.cursor = pageParam;
      const response = await api.get<{ entries: WireTimelineEntry[]; nextCursor: string | null }>(
        `/api/admin/users/${encodeURIComponent(userId)}/timeline`,
        { params }
      );
      return { ...response.data, entries: response.data.entries.map(reviveTimelineEntry) };
    },
    getNextPageParam: lastPage => lastPage.nextCursor ?? undefined,
    initialPageParam: undefined as string | undefined,
    staleTime: 1000 * 30,
    enabled: enabled && types !== '',
  });
};

export const useUserSignIns = (userId: string) =>
  useInfiniteQuery({
    queryKey: ['admin', 'users', userId, 'sign-ins'],
    queryFn: async ({ pageParam }): Promise<UserSignInsPage> => {
      const params: Record<string, string> = { limit: String(SIGN_IN_PAGE_SIZE) };
      if (pageParam) params.cursor = pageParam;
      const response = await api.get<{ entries: Array<Wire<UserSignIn>>; nextCursor: string | null }>(
        `/api/admin/users/${encodeURIComponent(userId)}/sign-ins`,
        { params }
      );
      return {
        ...response.data,
        entries: response.data.entries.map(entry => ({ ...entry, at: new Date(entry.at) })),
      };
    },
    getNextPageParam: lastPage => lastPage.nextCursor ?? undefined,
    initialPageParam: undefined as string | undefined,
    staleTime: 1000 * 30,
  });

type WireSignupCluster = Omit<UserSignupCluster, 'matches'> & {
  matches: Array<Omit<UserSignupCluster['matches'][number], 'createdAt'> & { createdAt: string }>;
};

export const useUserSignupCluster = (userId: string) =>
  useQuery({
    queryKey: ['admin', 'users', userId, 'signup-cluster'],
    queryFn: async (): Promise<UserSignupCluster> => {
      const response = await api.get<WireSignupCluster>(
        `/api/admin/users/${encodeURIComponent(userId)}/signup-cluster`
      );
      return {
        ...response.data,
        matches: response.data.matches.map(match => ({ ...match, createdAt: new Date(match.createdAt) })),
      };
    },
    staleTime: 1000 * 60 * 5,
  });
