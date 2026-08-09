import { api } from '@client/app/contexts/ApiContext';
import { IFabFileDocument, IFileTag, IFileTagWithFileCount, ITag } from '@bike4mind/common';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getErrorMessage } from '@client/app/utils/error';
import { fabFileKeys } from '@client/app/hooks/data/fabFileKeys';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';

interface TagCountsResponse {
  tagCounts: { tag: string; count: number }[];
  namespaceCounts: { namespace: string; fileCount: number }[];
}

export const useGetTagCounts = () => {
  return useQuery({
    queryKey: ['file-tags', 'counts'],
    queryFn: () => api.get<TagCountsResponse>('/api/files/tags/counts').then(res => res.data),
    refetchOnWindowFocus: false,
  });
};

export const useGetFileTags = () => {
  return useQuery({
    queryKey: ['file-tags'],
    // The only endpoint that carries a fileCount: the tag document stores none, so listFileTags
    // derives it per read. Anything wanting a count has to come through this query.
    queryFn: () => api.get<IFileTagWithFileCount[]>('/api/files/tags').then(res => res.data),
    refetchOnWindowFocus: false,
  });
};

export const useCreateFileTag = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: Omit<ITag, 'id' | 'userId' | 'createdAt' | 'updatedAt' | 'type'>) => {
      const result = await api.post<IFileTag>('/api/files/tags', params);

      return result.data;
    },
    onSuccess: data => {
      // The create response carries no count - only listFileTags derives one - so the new row is
      // seeded at 0 here. Right for a genuinely new name and wrong the moment files already carry
      // it (tag documents are auto-created by name elsewhere, and deleting one never untags the
      // files), which is what the invalidation below settles. The list, not just the counts endpoint.
      // Defaulted, not just annotated: react-query hands the updater `undefined` when the key has no
      // cached entry yet, and spreading that throws inside onSuccess - so the tag is created and the
      // mutation still surfaces as a failure.
      queryClient.setQueryData(['file-tags'], (prev: IFileTagWithFileCount[] = []) => [
        ...prev,
        { ...data, fileCount: 0 },
      ]);
      queryClient.invalidateQueries({ queryKey: ['file-tags'] });
      toast.success('Tag created successfully');
    },
    // The server's own reason, not a fixed string: a create is refused when the name already exists
    // in another casing, and "Failed to create tag" left the user retrying the same name.
    onError: error => {
      toast.error(getErrorMessage(error));
    },
  });
};

export const useUpdateFileTag = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: ITag) => {
      const result = await api.put<IFileTag>(`/api/files/tags/${params.id}`, params);

      return result.data;
    },
    onSuccess: data => {
      // Merge rather than replace so the edited fields show immediately: PUT /api/files/tags/[id]
      // echoes back only what tagUpdateSchema accepted, and a wholesale swap would blank the rest
      // of the row. The response carries no count, so the merge keeps the derived one - still only
      // optimistic, because a rename retags the files and can merge two tags into one.
      // Defaulted for the same reason as the create above: an uncached key yields `undefined`.
      queryClient.setQueryData(['file-tags'], (prev: IFileTagWithFileCount[] = []) =>
        prev.map(t => (t.id === data.id ? { ...t, ...data } : t))
      );
      // The bare prefix: invalidating ['file-tags','counts'] alone leaves the longer key matched
      // and the list itself - which is what carries fileCount - stale. A merge also removes the
      // collided row entirely, which only a refetch of the list can reflect.
      queryClient.invalidateQueries({ queryKey: ['file-tags'] });
      // A rename rewrites the tag names stored on the files, so cached file rows are stale too.
      queryClient.invalidateQueries({ queryKey: fabFileKeys.all });
      toast.success('Tag updated successfully');
    },
    onError: error => {
      toast.error(getErrorMessage(error));
    },
  });
};

export const useDeleteFileTag = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/api/files/tags/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['file-tags'] });
      // Deleting a tag now strips its name off the files too, so cached file rows carry tags the
      // server has already removed.
      queryClient.invalidateQueries({ queryKey: fabFileKeys.all });
    },
    onError: () => {
      toast.error('Failed to delete tag');
    },
  });
};

export function useToggleTagToFiles() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  return useMutation({
    mutationFn: async (params: { ids: string[]; tags: IFileTag[] }) => {
      const response = await api.post<IFabFileDocument[]>(`/api/files/tags/toggle`, {
        ids: params.ids,
        tags: params.tags.map(tag => tag.name),
      });
      return response.data;
    },
    onSuccess: data => {
      toast.success(t('file_actions.add_tag', { count: data.length }));
      queryClient.invalidateQueries({ queryKey: fabFileKeys.all });
      queryClient.invalidateQueries({ queryKey: ['file-tags'] });
    },
    onError: () => {
      toast.error(t('file_actions.failed_to_add_tag'));
    },
  });
}
