/**
 * Search-side fab-file hooks. The combined search fans out filename + tag queries in
 * parallel and merges them; the /api/files/search hooks come in one-shot, infinite,
 * and paginated flavors keyed under the 'search' namespace of fabFileKeys.
 */
import type { IFabFileDocument } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { keepPreviousData, useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { fabFileKeys } from '@client/app/hooks/data/fabFileKeys';
import { seedFabFileDocCache } from '@client/app/hooks/data/fabFileQueries';

export function useGetFabFilesWithCombinedSearch(
  searchTerm: string = '',
  filters: { type?: 'text' | 'pdf' | 'url' | 'image'; shared?: boolean } = {},
  sort: string = 'asc',
  sortField: string = 'createdAt',
  page: number = 1,
  options: { enabled?: boolean } = {}
) {
  const queryClient = useQueryClient();
  const { enabled } = options;

  const queryKey = fabFileKeys.combined({ searchTerm, filters, sort, sortField, page });

  return useQuery({
    queryKey,
    queryFn: async () => {
      // If search is empty, do a single API call
      if (!searchTerm.trim()) {
        const response = await api.get<{ data: IFabFileDocument[]; hasMore: boolean; total: number }>('/api/files', {
          params: {
            search: '',
            filters,
            pagination: { page, limit: 20 },
            order: { by: sortField, direction: sort },
          },
        });

        // Cache individual file data
        seedFabFileDocCache(queryClient, response.data.data);

        return response.data;
      }

      // Make both API calls in parallel for better performance
      const [filenameResponse, tagResponse] = await Promise.all([
        // First search: by filename
        api.get<{ data: IFabFileDocument[]; hasMore: boolean; total: number }>('/api/files', {
          params: {
            search: searchTerm,
            filters: { ...filters, tag: undefined }, // Exclude tag search
            pagination: { page, limit: 20 },
            order: { by: sortField, direction: sort },
          },
        }),

        // Second search: by tag
        api.get<{ data: IFabFileDocument[]; hasMore: boolean; total: number }>('/api/files', {
          params: {
            search: '', // No filename search
            filters: { ...filters, tag: searchTerm }, // Only tag search
            pagination: { page, limit: 20 },
            order: { by: sortField, direction: sort },
          },
        }),
      ]);

      // Combine results and remove duplicates
      const filenameResults = filenameResponse.data.data || [];
      const tagResults = tagResponse.data.data || [];

      // Use a Map to deduplicate by file ID
      const combinedMap = new Map();

      [...filenameResults, ...tagResults].forEach(file => {
        combinedMap.set(file.id, file);
      });

      const combinedResults = Array.from(combinedMap.values());

      // Cache individual file data
      seedFabFileDocCache(queryClient, combinedResults);

      // Determine if there's more data to fetch
      const hasMore = filenameResponse.data.hasMore || tagResponse.data.hasMore;

      // Calculate combined total from both searches
      // Since results can overlap, we use the max of both totals as a floor estimate,
      // but add any unique tag results that weren't in the filename results
      const filenameTotal = filenameResponse.data.total || 0;
      const tagTotal = tagResponse.data.total || 0;
      // Use max of both totals so pagination shows when either search has enough results
      // In practice, overlap is common so this is a reasonable estimate
      const total = Math.max(filenameTotal, tagTotal, combinedResults.length);

      return {
        data: combinedResults,
        hasMore,
        total,
      };
    },
    refetchOnWindowFocus: false,
    staleTime: 1000 * 60 * 5, // Cache results for 5 minutes
    gcTime: 1000 * 60 * 10, // Keep cache for 10 minutes (formerly cacheTime)
    enabled,
  });
}

export interface ISearchFabFilesParams {
  search?: string;
  filters?: {
    tags?: string[];
    type?: 'text' | 'pdf' | 'url' | 'image' | 'excel' | 'word' | 'json' | 'csv' | 'markdown' | 'code' | 'audio';
    shared?: boolean;
    curated?: boolean;
  };
  pagination?: { page: number; limit: number };
  order?: { by: 'fileName' | 'fileSize' | 'createdAt'; direction: 'asc' | 'desc' };
}
export function useSearchFabFiles(parameters?: ISearchFabFilesParams, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: fabFileKeys.search(parameters),
    queryFn: async () => {
      const response = await api.get<{ data: IFabFileDocument[]; total: number; hasMore: boolean }>(
        '/api/files/search',
        {
          params: {
            ...parameters,
          },
        }
      );

      return response.data;
    },
    refetchOnWindowFocus: false,
    enabled: options?.enabled, // undefined => defaults to true (existing callers unaffected)
  });
}

export function useInfiniteSearchFabFiles(parameters?: ISearchFabFilesParams) {
  return useInfiniteQuery({
    queryKey: fabFileKeys.searchInfinite(parameters),
    initialPageParam: { page: 1 },
    queryFn: async params => {
      const { page = 1 } = params.pageParam || {};
      const result = await api.get<{ data: IFabFileDocument[]; total: number; hasMore: boolean }>('/api/files/search', {
        params: {
          ...parameters,
          pagination: {
            page,
            limit: 20,
          },
        },
      });
      return result.data;
    },
    getNextPageParam: (lastPage, _allPages, { page }) => {
      if (lastPage.hasMore) {
        return {
          page: page + 1,
        };
      }
      return undefined;
    },
    refetchOnWindowFocus: false,
  });
}

export function usePaginatedSearchFabFiles(parameters?: ISearchFabFilesParams & { page?: number }) {
  const { page = 1, ...restParams } = parameters || {};

  return useQuery({
    queryKey: fabFileKeys.searchPaginated({ ...restParams, page }),
    queryFn: async () => {
      const result = await api.get<{ data: IFabFileDocument[]; total: number; hasMore: boolean }>('/api/files/search', {
        params: {
          ...restParams,
          pagination: {
            page,
            limit: 20,
          },
        },
      });
      return result.data;
    },
    refetchOnWindowFocus: false,
    staleTime: 1000 * 60 * 5, // Cache results for 5 minutes
    // Search text and page number are part of the query key, so without this every
    // keystroke or page change would drop `data` to undefined and unmount every row.
    // That flickers the list and destroys per-row local state mid-interaction (an
    // in-progress inline rename loses its edit mode - see Browser/Item.tsx ToggleRename).
    placeholderData: keepPreviousData,
  });
}
