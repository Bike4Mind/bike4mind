/**
 * Write-side fab-file hooks: create/upload, delete (single, bulk, all), chunk, clone,
 * rename, update, download, and presigned-url minting. Every mutation that changes
 * which files exist or what tags they carry invalidates fabFileKeys.all plus the
 * cross-domain ['file-tags'] key (owned by tag.ts - per-tag counts derive from files).
 */
import {
  CreateFabFileRequestInputType,
  IShareableDocument,
  KnowledgeType,
  UpdateFabFileRequestInputType,
  type IFabFileDocument,
} from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { setPendingMessageFiles } from '@client/app/hooks/useSessionLayout';
import {
  chunkFileUtility,
  createFabFileOnServer,
  createFabFileOnServerWithUpload,
  deleteFileUtility,
  getContentFromFabfile,
  getFabFileByIdFromServer,
  updateFabFileOnServer,
} from '@client/app/utils/filesAPICalls';
import { getErrorMessage } from '@client/app/utils/error';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { uploadFileToUrl } from '@client/app/utils/uploadFileToUrl';
import { ActualFileObject } from 'filepond';
import { toast } from 'sonner';
import { fabFileKeys } from '@client/app/hooks/data/fabFileKeys';

export function useDeleteAllFiles(options: { onSuccess?: () => void } = {}) {
  const { onSuccess } = options;
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      return await api.delete('/api/files');
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: fabFileKeys.all });
      // Deleting all files zeroes every tag's file count - invalidate so the tag browser
      // doesn't keep showing stale counts (matches useDeleteFile/useBulkDeleteFiles below).
      queryClient.invalidateQueries({ queryKey: ['file-tags'] });
      // The composer's pending-attachment chips are a denormalized Zustand snapshot, not
      // backed by the fabFiles query cache, so invalidation above doesn't reach them - clear
      // them explicitly or they keep rendering chips for now-deleted files (see #1279).
      setPendingMessageFiles([]);
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
      queryClient.invalidateQueries({ queryKey: fabFileKeys.all });
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
    notFound: string[];
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
      queryClient.invalidateQueries({ queryKey: fabFileKeys.all, exact: false });
      // Invalidate the tag query to refresh the number of files with that tag
      queryClient.invalidateQueries({ queryKey: ['file-tags'] });
      // A batch that only hit notFound/failed removed nothing - don't show a green toast for it,
      // and a batch that removed some files but also had errors isn't a clean success either.
      const removedSomething = data.results.deleted.length > 0 || data.results.unshared.length > 0;
      const hasFailures = data.results.failed.length > 0;
      if (!removedSomething) {
        toast.error(data.message);
      } else if (hasFailures) {
        toast.warning(data.message);
      } else {
        toast.success(data.message);
      }
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
      queryClient.setQueriesData({ queryKey: fabFileKeys.own }, (oldData: any) => {
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

      queryClient.invalidateQueries({ queryKey: fabFileKeys.all, exact: false });
      // A created file can carry tags, and per-tag counts are derived from the files holding each
      // tag. This hook has no callers today; the invalidation is here so wiring it up later cannot
      // silently reintroduce the stale-count bug the other write paths were fixed for.
      queryClient.invalidateQueries({ queryKey: ['file-tags'] });
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
      queryClient.invalidateQueries({ queryKey: fabFileKeys.all });
      if (options.onSuccess) options.onSuccess();
    },
    onError: error => {
      console.error(error);
      toast.error('Failed to chunk files');
    },
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
      queryClient.invalidateQueries({ queryKey: fabFileKeys.all });
    },
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

      queryClient.invalidateQueries({ queryKey: fabFileKeys.all });
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
        queryClient.setQueryData(fabFileKeys.doc(variables.id), result);
      }
      // Invalidate all fabFiles queries (lists, searches, etc.)
      queryClient.invalidateQueries({ queryKey: fabFileKeys.all, exact: false });
      // Invalidate and force refetch system prompt files (they have long staleTime)
      queryClient.invalidateQueries({ queryKey: ['system-prompt-files'], exact: false, refetchType: 'all' });
      // This route replaces the whole tags array, so any tag surface showing a per-tag file count
      // is stale afterwards. The bare prefix also covers ['file-tags','counts'].
      queryClient.invalidateQueries({ queryKey: ['file-tags'] });
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
      queryClient.invalidateQueries({ queryKey: fabFileKeys.all });
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
      queryClient.invalidateQueries({ queryKey: fabFileKeys.all });
      toast.success(`File renamed to "${result.fileName}"`);
    },
    onError: error => {
      console.error(error);
      toast.error('Failed to apply rename');
    },
  });
}
