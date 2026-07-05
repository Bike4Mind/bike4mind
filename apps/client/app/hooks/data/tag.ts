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
      queryClient.invalidateQueries({ queryKey: ['file-tags', 'counts'] });
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
      queryClient.setQueryData(['file-tags'], (prev: IFileTag[]) => prev.map(t => (t.id === data.id ? data : t)));
      queryClient.invalidateQueries({ queryKey: ['file-tags', 'counts'] });
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
