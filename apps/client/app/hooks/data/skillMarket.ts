import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import type {
  ISkillHonestSummary,
  ISkillListing,
  ISkillListingVersion,
  ISkillSnapshot,
  SkillListingReportReason,
  SkillListingVisibility,
  SkillRiskTier,
} from '@bike4mind/common';

/** A listing as the market API returns it (share token only for its author / reviewers). */
export type MarketListing = Omit<ISkillListing, 'shareToken'> & {
  shareToken?: string;
  ratingAvg: number;
  /** Set on recommendation and "similar" items. */
  reason?: string;
};

export type MarketVersionView = {
  id: string;
  version: number;
  snapshot: ISkillSnapshot;
  honestSummary?: ISkillHonestSummary;
  riskTier?: SkillRiskTier;
  createdAt: string;
};

export type ListingDetail = {
  listing: MarketListing;
  version: MarketVersionView | null;
  ratings: Array<{ stars: number; review?: string; ratedAt: string; mine: boolean }>;
  myImport: {
    version: number;
    stars?: number;
    review?: string;
    skill: { id: string; name: string } | null;
  } | null;
  viewer: { isAuthor: boolean; canReview: boolean; canDelist: boolean; canImport: boolean; canRate: boolean };
  similar: MarketListing[];
};

export type MarketFilters = {
  q: string;
  scope: '' | 'public' | 'org';
  tools: '' | 'with' | 'without';
  minRating: number;
  sort: 'relevance' | 'top' | 'imports' | 'new' | 'updated';
  tags: string[];
};

export type MyListing = MarketListing & { versions: ISkillListingVersion[] };

export type MarketMe = { organizations: Array<{ id: string; name: string }>; isReviewer: boolean; isAdmin: boolean };

export type SubmitResult = { listing: MarketListing; version: ISkillListingVersion };

const PAGE_SIZE = 24;

export const useMarketMe = () =>
  useQuery({
    queryKey: ['skill-market', 'me'],
    queryFn: async () => (await api.get<MarketMe>('/api/skills/market/me')).data,
    staleTime: 5 * 60 * 1000,
  });

export const useMarketListings = (filters: MarketFilters) =>
  useInfiniteQuery({
    queryKey: ['skill-market', 'browse', filters],
    initialPageParam: 1,
    queryFn: async ({ pageParam }) => {
      const params = new URLSearchParams({ page: String(pageParam), limit: String(PAGE_SIZE), sort: filters.sort });
      if (filters.q.trim()) params.set('q', filters.q.trim());
      if (filters.scope) params.set('scope', filters.scope);
      if (filters.tools) params.set('tools', filters.tools);
      if (filters.minRating) params.set('minRating', String(filters.minRating));
      if (filters.tags.length) params.set('tags', filters.tags.join(','));
      const res = await api.get<{ data: MarketListing[]; hasMore: boolean }>(`/api/skills/market?${params}`);
      return res.data;
    },
    getNextPageParam: (last, pages) => (last.hasMore ? pages.length + 1 : undefined),
    staleTime: 60 * 1000,
  });

export const useRecommendedListings = (enabled = true) =>
  useQuery({
    queryKey: ['skill-market', 'recommended'],
    queryFn: async () => (await api.get<{ data: MarketListing[] }>('/api/skills/market/recommended')).data.data,
    enabled,
    staleTime: 5 * 60 * 1000,
  });

/** Detail by id, or by unlisted share token when `token` is given without an id. */
export const useListingDetail = (args: { id?: string; token?: string }) =>
  useQuery({
    queryKey: ['skill-market', 'listing', args.id ?? `token:${args.token}`],
    queryFn: async () => {
      const url = args.id
        ? `/api/skills/market/${args.id}${args.token ? `?token=${encodeURIComponent(args.token)}` : ''}`
        : `/api/skills/market/by-token/${encodeURIComponent(args.token ?? '')}`;
      return (await api.get<ListingDetail>(url)).data;
    },
    enabled: Boolean(args.id || args.token),
    retry: false,
  });

export const useMyListings = () =>
  useQuery({
    queryKey: ['skill-market', 'mine'],
    queryFn: async () => (await api.get<{ data: MyListing[] }>('/api/skills/market/mine')).data.data,
  });

export type ReviewQueueFilter = 'pending' | 'audit' | 'reports' | 'legacy';

export type ReviewQueueVersionItem = {
  version: ISkillListingVersion;
  listing: MarketListing;
  previous: { version: number; snapshot: ISkillSnapshot } | null;
  canDecide: boolean;
};
export type ReviewQueueReportItem = {
  listing: MarketListing;
  count: number;
  reports: Array<{ reason: SkillListingReportReason; details?: string; createdAt: string }>;
};
export type LegacyGlobalSkill = {
  id: string;
  name: string;
  description: string;
  body: string;
  allowedTools: string[];
  userId?: string;
  organizationId?: string;
  isGlobalWrite: boolean;
  updatedAt: string;
};

export function useReviewQueue(filter: 'pending' | 'audit'): ReturnType<typeof useQuery<ReviewQueueVersionItem[]>>;
export function useReviewQueue(filter: 'reports'): ReturnType<typeof useQuery<ReviewQueueReportItem[]>>;
export function useReviewQueue(filter: 'legacy'): ReturnType<typeof useQuery<LegacyGlobalSkill[]>>;
export function useReviewQueue(filter: ReviewQueueFilter) {
  return useQuery({
    queryKey: ['skill-market', 'review-queue', filter],
    queryFn: async () =>
      (await api.get<{ data: unknown[] }>(`/api/skills/market/review-queue?filter=${filter}`)).data.data,
  });
}

/** Invalidates everything market-shaped plus the skills list (staleness badges live there). */
const useInvalidateMarket = () => {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['skill-market'] });
    void qc.invalidateQueries({ queryKey: ['skills'] });
    void qc.invalidateQueries({ queryKey: ['skill'] });
  };
};

export const usePublishSkill = () => {
  const invalidate = useInvalidateMarket();
  return useMutation({
    mutationFn: async (input: {
      skillId: string;
      visibility: SkillListingVisibility;
      organizationId?: string;
      tags: string[];
    }) => (await api.post<SubmitResult>('/api/skills/market/publish', input)).data,
    onSuccess: invalidate,
  });
};

export const useSubmitNewVersion = () => {
  const invalidate = useInvalidateMarket();
  return useMutation({
    mutationFn: async ({ listingId, tags }: { listingId: string; tags?: string[] }) =>
      (await api.post<SubmitResult>(`/api/skills/market/${listingId}/versions`, tags ? { tags } : {})).data,
    onSuccess: invalidate,
  });
};

export const useRescanVersion = () => {
  const invalidate = useInvalidateMarket();
  return useMutation({
    mutationFn: async (versionId: string) =>
      (await api.post<{ version: ISkillListingVersion }>(`/api/skills/market/versions/${versionId}/rescan`)).data,
    onSuccess: invalidate,
  });
};

export const useWithdrawListing = () => {
  const invalidate = useInvalidateMarket();
  return useMutation({
    mutationFn: async (listingId: string) => {
      await api.delete(`/api/skills/market/${listingId}`);
    },
    onSuccess: invalidate,
  });
};

export const useImportListing = () => {
  const invalidate = useInvalidateMarket();
  return useMutation({
    mutationFn: async ({
      listingId,
      ...body
    }: {
      listingId: string;
      token?: string;
      name?: string;
      targetSkillId?: string;
      overwrite?: boolean;
      expectedVersionId?: string;
    }) =>
      (await api.post<{ skill: { id: string; name: string } }>(`/api/skills/market/${listingId}/import`, body)).data,
    onSuccess: invalidate,
    // A 409 version_changed means the detail behind the diff is stale; refetch it.
    onError: invalidate,
  });
};

export const useRateListing = () => {
  const invalidate = useInvalidateMarket();
  return useMutation({
    mutationFn: async ({
      listingId,
      ...body
    }: {
      listingId: string;
      stars: number;
      review?: string;
      token?: string;
    }) => {
      await api.put(`/api/skills/market/${listingId}/rating`, body);
    },
    onSuccess: invalidate,
  });
};

export const useReportListing = () =>
  useMutation({
    mutationFn: async ({
      listingId,
      ...body
    }: {
      listingId: string;
      reason: SkillListingReportReason;
      details?: string;
      token?: string;
    }) =>
      (await api.post<{ ok: boolean; alreadyReported?: boolean }>(`/api/skills/market/${listingId}/report`, body)).data,
  });

export const useModerateListing = () => {
  const invalidate = useInvalidateMarket();
  return useMutation({
    mutationFn: async ({
      listingId,
      ...body
    }: { listingId: string } & ({ action: 'delist'; reason: string } | { action: 'restore' })) => {
      await api.post(`/api/skills/market/${listingId}/moderate`, body);
    },
    onSuccess: invalidate,
  });
};

export const useReviewVersion = () => {
  const invalidate = useInvalidateMarket();
  return useMutation({
    mutationFn: async ({
      versionId,
      ...body
    }: { versionId: string } & (
      | { action: 'approve'; ackHighRisk?: boolean; ackMismatch?: boolean; note?: string }
      | { action: 'reject'; note: string }
      | { action: 'audit' }
    )) => {
      await api.post(`/api/skills/market/versions/${versionId}/review`, body);
    },
    onSuccess: invalidate,
  });
};

/** Pull the server's `{ code, suggestedName }` extras off a 409 so the UI can offer a rename / overwrite. */
export const conflictInfo = (error: unknown): { code?: string; suggestedName?: string } | null => {
  const res = (error as { response?: { status?: number; data?: { code?: string; suggestedName?: string } } })?.response;
  return res?.status === 409 ? (res.data ?? {}) : null;
};
