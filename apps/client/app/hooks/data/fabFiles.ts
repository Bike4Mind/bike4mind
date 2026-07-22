import {
  CreateFabFileRequestInputType,
  DATA_LAKES,
  IShareableDocument,
  KnowledgeType,
  UpdateFabFileRequestInputType,
  type IFabFileDocument,
} from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import {
  chunkFileUtility,
  createFabFileOnServer,
  createFabFileOnServerWithUpload,
  deleteFileUtility,
  getContentFromFabfile,
  getFabFileByIdFromServer,
  getFabFileNameByIdFromServer,
  updateFabFileOnServer,
} from '@client/app/utils/filesAPICalls';
import { getContentFromFabfile as getContentFromFabfileInString } from '@client/app/utils/fabFileUtils';
import { isOptimisticId } from '@client/app/utils/llm';
import { getErrorMessage } from '@client/app/utils/error';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { uploadFileToUrl } from '@client/app/utils/uploadFileToUrl';
import { ActualFileObject } from 'filepond';
import { toast } from 'sonner';

export function useDeleteAllFiles(options: { onSuccess?: () => void } = {}) {
  const { onSuccess } = options;
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      return await api.delete('/api/files');
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['fabFiles'] });
      if (onSuccess) onSuccess();
    },
    onError: error => {
      console.error(error);
      toast.error('Failed to delete files');
    },
  });
}

export function useDeleteFile(options?: {
  onSuccess?: (fileId: string) => void;
  onFailure?: (fileId: string) => void;
}) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (fileId: string): Promise<boolean> => {
      return await deleteFileUtility(fileId);
    },
    onSuccess: (success, fileId) => {
      toast.success('File deleted successfully');
      options?.onSuccess?.(fileId);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['fabFiles'] });
      // Invalidate the tag query to refresh the number of files with that tag
      queryClient.invalidateQueries({ queryKey: ['file-tags'] });
    },
    onError: (error, fileId) => {
      console.error(error);
      toast.error('Failed to delete file');
      options?.onFailure?.(fileId);
    },
  });
}

interface BulkDeleteResponse {
  message: string;
  results: {
    deleted: string[];
    unshared: string[];
    /** @deprecated Use deleted/unshared instead */
    success?: string[];
    failed: {
      id: string;
      error: string;
    }[];
  };
}

export function useBulkDeleteFiles(options?: { onSuccess?: () => void; onError?: (error: Error) => void }) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (fileIds: string[]) => {
      return await api.delete<BulkDeleteResponse>('/api/files/bulk-delete', { data: { fileIds } });
    },
    onSuccess: ({ data }) => {
      queryClient.invalidateQueries({ queryKey: ['fabFiles'], exact: false });
      // Invalidate the tag query to refresh the number of files with that tag
      queryClient.invalidateQueries({ queryKey: ['file-tags'] });
      toast.success(data.message);
      options?.onSuccess?.();
    },
    onError: error => {
      console.error(error);
      toast.error('Failed to delete files');
      options?.onError?.(error);
    },
  });
}

export function useCreateFabFileWithUpload(options?: {
  onSuccess?: (data: IFabFileDocument & IShareableDocument) => void;
  onError?: (error: Error) => void;
}) {
  const queryClient = useQueryClient();

  return async (formData: CreateFabFileRequestInputType, file: ActualFileObject | File) => {
    try {
      const newFabFile = await createFabFileOnServer(formData);
      // If the file has a presigned URL, upload it to the bucket
      if (newFabFile.presignedUrl) {
        await uploadFileToUrl(newFabFile.presignedUrl, file, file.type);
      }

      // Optimistically add to the first page of fab files queries
      queryClient.setQueriesData({ queryKey: ['fabFiles', 'own'] }, (oldData: any) => {
        if (!oldData?.pages?.[0]?.data) return oldData;

        return {
          ...oldData,
          pages: oldData.pages.map((page: any, index: number) => {
            if (index === 0) {
              return {
                ...page,
                data: [newFabFile, ...page.data],
                total: page.total + 1,
              };
            }
            return page;
          }),
        };
      });

      queryClient.invalidateQueries({ queryKey: ['fabFiles'], exact: false });
      options?.onSuccess?.(newFabFile);
      return newFabFile;
    } catch (err) {
      options?.onError?.(err as Error);
      throw err;
    }
  };
}

export function useDownloadAllFiles() {
  return useMutation({
    mutationFn: async () => {
      const res = await api.get('/api/files/download', {
        responseType: 'blob',
      });

      const url = window.URL.createObjectURL(new Blob([res.data]));
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', 'knowledges.zip');
      document.body.appendChild(link);
      link.click();
    },
    onError: error => {
      console.error(error);
      toast.error('Failed to download files');
    },
  });
}

export function useChunkFile(options: { onSuccess?: () => void } = {}) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: { fabFileId: string; chunkSize: number }) => {
      return await chunkFileUtility(data.fabFileId, data.chunkSize);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['fabFiles'] });
      if (options.onSuccess) options.onSuccess();
    },
    onError: error => {
      console.error(error);
      toast.error('Failed to chunk files');
    },
  });
}

export function useGetFabFiles(
  search: string = '',
  filters: {
    tags?: string;
    type?: 'text' | 'pdf' | 'url' | 'image' | 'excel' | 'word' | 'json' | 'csv' | 'markdown' | 'code';
    shared?: boolean;
    projectId?: string;
  } = {},
  sort: string = 'asc',
  sortField: string = 'createdAt'
) {
  const queryClient = useQueryClient();

  return useInfiniteQuery({
    queryKey: ['fabFiles', 'own', { search, filters, sort, sortField }],
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

      response.data.data.forEach(files => {
        queryClient.setQueryData(['fabFiles', files.id], () => files);
      });
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
    queryKey: options?.queryKey || ['fabFiles', 'own', { sessionId }],
    queryFn: async () => {
      const result = await api.get<IFabFileDocument[]>(`/api/sessions/${sessionId}/files`);

      result.data.forEach(file => {
        queryClient.setQueryData(['fabFiles', file.id], file);
      });

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
    queryKey: ['fabFiles', 'quest', questId],
    queryFn: async () => {
      const result = await api.get<IFabFileDocument[]>(`/api/quests/${questId}/files`);

      result.data.forEach(file => {
        queryClient.setQueryData(['fabFiles', file.id], file);
      });

      return result.data;
    },
    staleTime: 1000 * 60 * 30,
    // Same class of bug: quest ids can be optimistic placeholders too
    // (`optimistic-quest-*`, see utils/llm.ts). Push the guard into the hook so
    // new callers can't re-introduce the 400.
    enabled: (options.enabled ?? true) && !!questId && !isOptimisticId(questId),
  });
}

export function useUploadKnowledgeFromUrl() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (url: string) => {
      const response = await api.post<IFabFileDocument>('/api/files/createFabFileURL', { url });
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['fabFiles'] });
    },
  });
}

export function useGetFabFile(id: string | null) {
  return useQuery({
    queryKey: ['fabFiles', id],
    queryFn: () => getFabFileByIdFromServer(id!),
    staleTime: !!id ? undefined : 1000 * 60 * 30, // 30 minutes
    enabled: !!id,
  });
}

export function useGetFabFileName(id: string) {
  return useQuery({
    queryKey: ['fabFiles', 'name', id],
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

        response.data.forEach(file => {
          queryClient.setQueryData(['fabFiles', file.id], () => file);
        });

        return response.data;
      } catch (e) {
        return [];
      }
    },
    staleTime: 1000 * 60 * 5, // 5 minutes
    refetchOnWindowFocus: false,
  });
}

export function useCreateFabFile(callbacks?: {
  onSuccess?: (files: IFabFileDocument[]) => void;
  onError?: (error: Error) => void;
}) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (
      data: {
        file: File;
        type: KnowledgeType;
        fileName: string;
        mimeType: string;
        fileSize: number;
      }[]
    ) => {
      const result = await Promise.all(
        data.map(async item => {
          const { file, ...rest } = item;
          const fabfile = await createFabFileOnServerWithUpload(rest, file);
          return fabfile;
        })
      );

      queryClient.invalidateQueries({ queryKey: ['fabFiles'] });
      return result;
    },
    onSuccess: files => {
      callbacks?.onSuccess?.(files);

      toast.success(`Uploaded: ${files.length} file${files.length === 1 ? '' : 's'}`);
    },
    onError: error => {
      console.error(error);
      toast.error(getErrorMessage(error));
    },
  });
}

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

  const queryKey = ['fabFiles', 'combined', { searchTerm, filters, sort, sortField, page }];

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
        response.data.data.forEach(file => {
          queryClient.setQueryData(['fabFiles', file.id], file);
        });

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
      combinedResults.forEach(file => {
        queryClient.setQueryData(['fabFiles', file.id], file);
      });

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
    type?: 'text' | 'pdf' | 'url' | 'image' | 'excel' | 'word' | 'json' | 'csv' | 'markdown' | 'code';
    shared?: boolean;
    curated?: boolean;
  };
  pagination?: { page: number; limit: number };
  order?: { by: 'fileName' | 'fileSize' | 'createdAt'; direction: 'asc' | 'desc' };
}
export function useSearchFabFiles(parameters?: ISearchFabFilesParams, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ['fabFiles', 'search', parameters],
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
    queryKey: ['fabFiles', 'search', 'infinite', parameters],
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
    queryKey: ['fabFiles', 'search', 'paginated', { ...restParams, page }],
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
  });
}

export function useUpdateFabFile(callback?: { onSuccess?: () => void }) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (val: UpdateFabFileRequestInputType & { id: string }) => {
      const result = await updateFabFileOnServer(val.id, val);
      return result;
    },
    onSuccess: (result, variables) => {
      // Update the specific file in cache immediately for faster UI update
      if (result) {
        queryClient.setQueryData(['fabFiles', variables.id], result);
      }
      // Invalidate all fabFiles queries (lists, searches, etc.)
      queryClient.invalidateQueries({ queryKey: ['fabFiles'], exact: false });
      // Invalidate and force refetch system prompt files (they have long staleTime)
      queryClient.invalidateQueries({ queryKey: ['system-prompt-files'], exact: false, refetchType: 'all' });
      callback?.onSuccess?.();
    },
  });
}

export function useCloneFabFile(callback?: { onSuccess?: () => void }) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (file: IFabFileDocument) => {
      if (!file || !file.fileUrl) return;

      // Always fetch from the API to refresh signed url
      const fullFabFile = await getFabFileByIdFromServer(file.id);
      if (!fullFabFile.fileUrl) {
        throw new Error('File URL not found');
      }

      const content = await getContentFromFabfile(fullFabFile);
      if (!content.ok) throw new Error('Failed to fetch file content');
      const blob = await content.blob();

      const newFile = new File([blob], 'Copy of ' + fullFabFile.fileName, { type: fullFabFile.mimeType });

      const data = {
        type: fullFabFile.type,
        fileName: newFile.name,
        mimeType: newFile.type,
        fileSize: newFile.size,
      };

      const result = await createFabFileOnServerWithUpload(data, newFile);

      toast.success(`Cloned file: "${file.fileName}" to "${newFile.name}".`);
      return result;
    },
    onSuccess: result => {
      queryClient.invalidateQueries({ queryKey: ['fabFiles'] });
      callback?.onSuccess?.();
    },
    onError: e => {
      console.log(e);
      toast.error('Failed to copy file');
    },
  });
}

export function useGetPresignedUrl() {
  return useMutation({
    mutationFn: async ({ filePaths, expiresIn }: { filePaths: string[]; expiresIn?: number }) => {
      const response = await api.get<{ urls: string[] }>('/api/files/presigned-url', {
        params: {
          filePaths,
          expiresIn,
        },
      });
      return response.data.urls;
    },
    onError: error => {
      console.error(error);
      // Toast removed: Components should handle user-facing error messages
      // This hook is too low-level to show UI notifications
    },
  });
}

export function useGetFabFileContent(fabFile: IFabFileDocument | null | undefined) {
  return useQuery({
    queryKey: ['fabFiles', fabFile?.id, 'content'],
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

export function useAutoRenameFabFile() {
  return useMutation({
    mutationFn: async (fileId: string) => {
      const result = await api
        .post<{
          fileId: string;
          currentName: string;
          suggestedName: string;
          model: string;
        }>(`/api/fabfiles/${fileId}/auto-rename`)
        .then(data => data.data);
      return result;
    },
    onError: error => {
      console.error(error);
      toast.error('Failed to generate filename suggestion');
    },
  });
}

export function useApplyAutoRenameFabFile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ fileId, newFileName }: { fileId: string; newFileName: string }) => {
      const result = await api
        .post<IFabFileDocument>(`/api/fabfiles/${fileId}/apply-auto-rename`, { newFileName })
        .then(data => data.data);
      return result;
    },
    onSuccess: result => {
      queryClient.invalidateQueries({ queryKey: ['fabFiles'] });
      toast.success(`File renamed to "${result.fileName}"`);
    },
    onError: error => {
      console.error(error);
      toast.error('Failed to apply rename');
    },
  });
}

export interface DataLakeArticlesParams {
  id?: string;
  tags?: string[];
  search?: string;
  page?: number;
  limit?: number;
  sortBy?: 'fileName' | 'createdAt';
  sortDir?: 'asc' | 'desc';
}

/**
 * Fetches tag counts for the Data Lake Explorer tag tree via server-side aggregation.
 * Much lighter than fetching all articles - returns ~50 tag/count pairs instead of 2000 documents.
 */
export interface DataLakeTagCountsResponse {
  /** Tag-occurrence sums that drive the Data Lake Explorer's tag tree. */
  tagCounts: { tag: string; count: number }[];
  /** Distinct-file counts: combined total + per-prefix breakdown (keyed by lake tag prefix, e.g. 'opti:'). */
  uniqueArticleCounts: { total: number; byPrefix: Record<string, number> };
}

/**
 * Which browse surface is reading. Both sources now hit the SAME consolidated
 * `/api/data-lakes/*` endpoints (the former product-gated `/api/opti/*` twins
 * were consolidated away - access is lake-scoped via each lake's declared
 * tag/entitlement gate, so the caller's accessible scope is identical either
 * way). The source is kept as a cache-key discriminator for the two UIs.
 */
export type DataLakeBrowseSource = 'opti' | 'datalakes';
const browseBase = (_source: DataLakeBrowseSource) => '/api/data-lakes';

export function useGetDataLakeTagCounts(source: DataLakeBrowseSource = 'opti') {
  return useQuery({
    queryKey: ['dataLakeTagCounts', source],
    queryFn: async () => {
      const response = await api.get<DataLakeTagCountsResponse>(`${browseBase(source)}/tag-counts`);
      return response.data;
    },
    refetchOnWindowFocus: false,
    staleTime: 1000 * 60 * 5,
  });
}

/**
 * Truthful Data-Lake article counts (distinct files, NOT tag occurrences) for the hero
 * tickers + mission chips, sourced from the same query the Explorer uses. `total` is the
 * combined unique count; the per-prefix fields are the individual per-lake unique counts.
 * Returns 0 for users without data-lake access (the endpoint yields an empty set); callers
 * fall back to a placeholder rather than rendering "0".
 *
 * `sales` is the unique count for the premium (overlay-contributed) lake - its tag prefix is
 * read from the lake config (DATA_LAKES) rather than hardcoded, so no customer-specific prefix
 * lives in open-core; it is 0 in the fork where no premium lake is contributed.
 */
export function useDataLakeArticleCounts(): { total: number; sales: number; opti: number } {
  const { data } = useGetDataLakeTagCounts();
  const unique = data?.uniqueArticleCounts;
  // The premium lake (if any) is whatever the overlay contributes beyond the base opti lake.
  const premiumLake = DATA_LAKES.find(l => l.id !== 'opti-knowledge');
  return {
    total: unique?.total ?? 0,
    sales: premiumLake ? (unique?.byPrefix[premiumLake.fileTagPrefix] ?? 0) : 0,
    opti: unique?.byPrefix['opti:'] ?? 0,
  };
}

export function useGetDataLakeArticles(params?: DataLakeArticlesParams | null, source: DataLakeBrowseSource = 'opti') {
  return useQuery({
    queryKey: ['dataLakeArticles', source, params],
    queryFn: async () => {
      const response = await api.get<{ data: IFabFileDocument[]; total: number; hasMore: boolean }>(
        `${browseBase(source)}/articles`,
        { params: params ?? undefined }
      );
      return response.data;
    },
    // Disabled when params is null/undefined (lazy-load pattern)
    enabled: params != null,
    refetchOnWindowFocus: false,
    staleTime: 1000 * 60 * 5,
  });
}
