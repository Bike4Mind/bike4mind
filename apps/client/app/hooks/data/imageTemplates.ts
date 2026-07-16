import { api } from '@client/app/contexts/ApiContext';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  IImageGenerationTemplateDocument,
  ImageGenerationTemplateInputType,
  ImageGenerationTemplateUpdateInputType,
} from '@bike4mind/common';

const LIST_KEY = 'image-templates';

/** The caller's templates (usageCount desc, then newest). Server returns only owned rows. */
export function useImageTemplates(enabled = true) {
  return useQuery({
    queryKey: [LIST_KEY],
    queryFn: async () => {
      const { data } = await api.get<{ templates: IImageGenerationTemplateDocument[] }>('/api/image-templates');
      return data.templates;
    },
    enabled,
  });
}

export function useCreateImageTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: ImageGenerationTemplateInputType) => {
      const { data } = await api.post<{ template: IImageGenerationTemplateDocument }>('/api/image-templates', input);
      return data.template;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: [LIST_KEY] }),
  });
}

export function useUpdateImageTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...patch }: ImageGenerationTemplateUpdateInputType & { id: string }) => {
      const { data } = await api.put<{ template: IImageGenerationTemplateDocument }>(
        `/api/image-templates/${id}`,
        patch
      );
      return data.template;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: [LIST_KEY] }),
  });
}

export function useDeleteImageTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/api/image-templates/${id}`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: [LIST_KEY] }),
  });
}

/**
 * Apply: bumps usageCount server-side and returns the fresh template for the
 * caller to load into LLMContext. `model` is the active model - the server 422s
 * on an exact-model mismatch (defense-in-depth; the picker also hides mismatches).
 */
export function useApplyImageTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, model }: { id: string; model: string }) => {
      const { data } = await api.post<{ template: IImageGenerationTemplateDocument }>(
        `/api/image-templates/${id}/apply`,
        { model }
      );
      return data.template;
    },
    // Refresh so the new usageCount (and default sort order) is reflected.
    onSuccess: () => qc.invalidateQueries({ queryKey: [LIST_KEY] }),
  });
}
