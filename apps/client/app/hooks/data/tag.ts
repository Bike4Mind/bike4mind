import { api } from '@client/app/contexts/ApiContext';
import { IFabFileDocument, IFileTag, ITag } from '@bike4mind/common';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
    queryFn: () => api.get<IFileTag[]>('/api/files/tags').then(res => res.data),
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
      queryClient.setQueryData(['file-tags'], (prev: IFileTag[]) => [...prev, data]);
      // The create response carries the seeded fileCount of 0, which is wrong the moment the name
      // matches files that already exist - tag documents are auto-created by name elsewhere, and
      // deleting one never untags the files. Invalidate the list, not just the counts endpoint.
      queryClient.invalidateQueries({ queryKey: ['file-tags'] });
      toast.success('Tag created successfully');
    },
    onError: () => {
      toast.error('Failed to create tag');
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
      // of the row. This is optimistic only - a rename retags the files and can merge two tags into
      // one, so fileCount here is a guess and the invalidation below is what settles it.
      queryClient.setQueryData(['file-tags'], (prev: IFileTag[]) =>
        prev.map(t => (t.id === data.id ? { ...t, ...data } : t))
      );
      // The bare prefix: invalidating ['file-tags','counts'] alone leaves the longer key matched
      // and the list itself - which is what carries fileCount - stale. A merge also removes the
      // collided row entirely, which only a refetch of the list can reflect.
      queryClient.invalidateQueries({ queryKey: ['file-tags'] });
      // A rename rewrites the tag names stored on the files, so cached file rows are stale too.
      queryClient.invalidateQueries({ queryKey: ['fabFiles'] });
      toast.success('Tag updated successfully');
    },
    onError: () => {
      toast.error('Failed to update tag');
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
      queryClient.invalidateQueries({ queryKey: ['fabFiles'] });
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
      queryClient.invalidateQueries({ queryKey: ['fabFiles'] });
      queryClient.invalidateQueries({ queryKey: ['file-tags'] });
    },
    onError: () => {
      toast.error(t('file_actions.failed_to_add_tag'));
    },
  });
}
