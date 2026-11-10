import { api } from '@client/app/contexts/ApiContext';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  PAGE_QUERY_KEY,
  PAGES_LIST_QUERY_KEY,
  type CreateCustomPageInputType,
  type ICustomPageDocument,
  type ICustomPageSummary,
  type UpdateCustomPageInputType,
} from '@bike4mind/common';

export function useCustomPages(enabled = true) {
  return useQuery({
    queryKey: PAGES_LIST_QUERY_KEY,
    queryFn: async () => {
      const { data } = await api.get<{ pages: ICustomPageSummary[] }>('/api/pages');
      return data.pages;
    },
    enabled,
  });
}

export function useCustomPage(id: string | undefined) {
  return useQuery({
    queryKey: PAGE_QUERY_KEY(id ?? ''),
    queryFn: async () => {
      const { data } = await api.get<{ page: ICustomPageDocument }>(`/api/pages/${id}`);
      return data.page;
    },
    enabled: !!id,
  });
}

export function useCreateCustomPage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateCustomPageInputType) => {
      const { data } = await api.post<{ page: ICustomPageDocument }>('/api/pages', input);
      return data.page;
    },
    onSuccess: page => {
      qc.setQueryData(PAGE_QUERY_KEY(page.id), page);
      return qc.invalidateQueries({ queryKey: PAGES_LIST_QUERY_KEY });
    },
  });
}

export function useUpdateCustomPage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...patch }: UpdateCustomPageInputType & { id: string }) => {
      const { data } = await api.patch<{ page: ICustomPageDocument }>(`/api/pages/${id}`, patch);
      return data.page;
    },
    onSuccess: page => {
      qc.setQueryData(PAGE_QUERY_KEY(page.id), page);
      return qc.invalidateQueries({ queryKey: PAGES_LIST_QUERY_KEY });
    },
  });
}

export function useDeleteCustomPage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/api/pages/${id}`);
    },
    onSuccess: (_data, id) => {
      qc.removeQueries({ queryKey: PAGE_QUERY_KEY(id) });
      return qc.invalidateQueries({ queryKey: PAGES_LIST_QUERY_KEY });
    },
  });
}

interface ToggleChecklistItemVars {
  widgetId: string;
  itemId: string;
  checked: boolean;
}

export function useToggleChecklistItem(pageId: string) {
  const qc = useQueryClient();
  const key = PAGE_QUERY_KEY(pageId);
  return useMutation({
    mutationFn: async ({ widgetId, itemId, checked }: ToggleChecklistItemVars) => {
      const { data } = await api.patch<{ page: ICustomPageDocument }>(
        `/api/pages/${pageId}/widgets/${encodeURIComponent(widgetId)}/items/${encodeURIComponent(itemId)}`,
        { checked }
      );
      return data.page;
    },
    onMutate: async ({ widgetId, itemId, checked }) => {
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueryData<ICustomPageDocument>(key);
      if (previous) {
        qc.setQueryData<ICustomPageDocument>(key, {
          ...previous,
          widgets: previous.widgets.map(widget =>
            widget.id === widgetId && widget.type === 'checklist'
              ? { ...widget, items: widget.items.map(item => (item.id === itemId ? { ...item, checked } : item)) }
              : widget
          ),
        });
      }
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) qc.setQueryData(key, context.previous);
    },
    onSuccess: page => {
      qc.setQueryData(key, page);
    },
  });
}

export function useRemovePageWidget(pageId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (widgetId: string) => {
      const { data } = await api.delete<{ page: ICustomPageDocument }>(
        `/api/pages/${pageId}/widgets/${encodeURIComponent(widgetId)}`
      );
      return data.page;
    },
    onSuccess: page => {
      qc.setQueryData(PAGE_QUERY_KEY(pageId), page);
    },
  });
}
