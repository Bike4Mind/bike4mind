/**
 * Read-side fab-file hooks: paged/own lists, per-session and per-quest attachment
 * lists, single-document fetches, and content loading. Write hooks live in
 * fabFileMutations.ts, search in fabFileSearch.ts; the fabFiles.ts barrel re-exports
 * all three so existing import sites (and the premium overlay's pinned path) keep working.
 */
import type { IFabFileDocument } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { getFabFileByIdFromServer, getFabFileNameByIdFromServer } from '@client/app/utils/filesAPICalls';
import { getContentFromFabfile as getContentFromFabfileInString } from '@client/app/utils/fabFileUtils';
import { isOptimisticId } from '@client/app/utils/llm';
import { useInfiniteQuery, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { fabFileKeys, type FabFileListFilters } from '@client/app/hooks/data/fabFileKeys';

/** Seeds the per-document cache from any list/search response so a later
 *  `useGetFabFile(id)` renders instantly. Same write the inline forEach loops did. */
export function seedFabFileDocCache(queryClient: QueryClient, files: IFabFileDocument[]) {
  files.forEach(file => queryClient.setQueryData(fabFileKeys.doc(file.id), file));
}

export function useGetFabFiles(
  search: string = '',
  filters: FabFileListFilters = {},
  sort: string = 'asc',
  sortField: string = 'createdAt'
) {
  const queryClient = useQueryClient();

  return useInfiniteQuery({
    queryKey: fabFileKeys.ownList({ search, filters, sort, sortField }),
    initialPageParam: { page: 1 },
    queryFn: async params => {
      const { page = 1 } = params.pageParam || {};
      const response = await api.get<{ data: IFabFileDocument[]; hasMore: boolean; total: number }>('/api/files', {
        params: {
          search,
          filters,
          pagination: {
            page,
            limit: 20,
          },
          order: {
            by: sortField,
            direction: sort,
          },
        },
      });

      seedFabFileDocCache(queryClient, response.data.data);
      return response.data;
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

export function useGetFabFilesBySessionId(sessionId: string, options: { enabled?: boolean; queryKey?: string[] } = {}) {
  const queryClient = useQueryClient();

  return useQuery({
    queryKey: options?.queryKey || fabFileKeys.ownBySession(sessionId),
    queryFn: async () => {
      const result = await api.get<IFabFileDocument[]>(`/api/sessions/${sessionId}/files`);

      seedFabFileDocCache(queryClient, result.data);

      return result.data;
    },
    staleTime: 1000 * 60 * 30,
    // Suppress the fetch while the id is still a client-only optimistic
    // placeholder - the server's ObjectId validator rejects it 400.
    // `isOptimisticId` matches both `optimistic-session-*` and
    // `optimistic-quest-*` prefixes, so the same gate works for any by-id hook.
    enabled: (options.enabled ?? true) && !isOptimisticId(sessionId),
  });
}

export function useGetFabFilesByQuestId(questId: string, options: { enabled?: boolean } = {}) {
  const queryClient = useQueryClient();

  return useQuery({
    queryKey: fabFileKeys.quest(questId),
    queryFn: async () => {
      const result = await api.get<IFabFileDocument[]>(`/api/quests/${questId}/files`);

      seedFabFileDocCache(queryClient, result.data);

      return result.data;
    },
    staleTime: 1000 * 60 * 30,
    // Same class of bug: quest ids can be optimistic placeholders too
    // (`optimistic-quest-*`, see utils/llm.ts). Push the guard into the hook so
    // new callers can't re-introduce the 400.
    enabled: (options.enabled ?? true) && !!questId && !isOptimisticId(questId),
  });
}

export function useGetFabFile(id: string | null) {
  return useQuery({
    queryKey: fabFileKeys.doc(id),
    queryFn: () => getFabFileByIdFromServer(id!),
    staleTime: !!id ? undefined : 1000 * 60 * 30, // 30 minutes
    enabled: !!id,
  });
}

export function useGetFabFileName(id: string) {
  return useQuery({
    queryKey: fabFileKeys.name(id),
    queryFn: () => getFabFileNameByIdFromServer(id),
    staleTime: !!id ? undefined : 1000 * 60 * 30, // 30 minutes
    enabled: !!id,
  });
}

export function useGetProjectFiles(projectId: string) {
  const queryClient = useQueryClient();

  return useQuery({
    queryKey: ['projects', projectId, 'files'],
    queryFn: async () => {
      try {
        const response = await api.get<IFabFileDocument[]>(`/api/projects/${projectId}/files`);

        seedFabFileDocCache(queryClient, response.data);

        return response.data;
      } catch (e) {
        return [];
      }
    },
    staleTime: 1000 * 60 * 5, // 5 minutes
    refetchOnWindowFocus: false,
  });
}

export function useGetFabFileContent(fabFile: IFabFileDocument | null | undefined) {
  return useQuery({
    queryKey: fabFileKeys.content(fabFile?.id),
    queryFn: async () => {
      if (!fabFile) return '';

      // Lazy-fetch a signed URL on demand if the file doesn't already have one.
      // The data lake list endpoints no longer pre-sign all URLs (perf optimization),
      // so the article viewer must request a URL when the user actually opens a file.
      let fileUrl = fabFile.fileUrl;
      if (!fileUrl && fabFile.filePath) {
        try {
          const response = await api.get<{ urls: string[] }>('/api/files/presigned-url', {
            params: { 'filePaths[]': fabFile.filePath },
          });
          fileUrl = response.data.urls?.[0];
        } catch (err) {
          console.error('Failed to fetch signed URL for fab file content', err);
        }
      }

      return getContentFromFabfileInString({
        mimeType: fabFile.mimeType,
        fileUrl,
      });
    },
    enabled: !!fabFile,
    // Article content is static - cache aggressively to avoid redundant S3 fetches
    staleTime: 1000 * 60 * 10,
    refetchOnWindowFocus: false,
  });
}
