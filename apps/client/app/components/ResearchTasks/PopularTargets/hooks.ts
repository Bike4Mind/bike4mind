import { api } from '@client/app/contexts/ApiContext';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { IResearchLinkCategoryDocument, IResearchLinkDocument } from '@bike4mind/common';
import { IResearchLinkCategoriesQuery, IResearchLinkWithCategory, IResearchLinksQuery } from './types';
import { create } from 'zustand';
import { toast } from 'sonner';
import { downloadData } from '@client/app/utils/download';
import { downloadTemplateData, PAGE_SIZE } from './utils';

interface IPagination {
  total: number;
  page: number;
  totalPages: number;
  pagePosition: 'first' | 'middle' | 'last';
}

interface IPopularTargetState {
  categoryId: string;
  categoryName: string;
  categoryDescription: string;
  categoryLoading: boolean;
  categoryGradient: string;
  categoryAccentColor: string;
  sources: number;
  total: number;
  searchTerm: string;
  businessLinksLoading: boolean;
  fieldIndex: number;
}

export const usePopularTargets = create<{
  state: IPopularTargetState;
  setState: (state: Partial<IPopularTargetState>) => void;
}>((set, get) => ({
  state: {
    categoryId: '',
    categoryName: '',
    categoryDescription: '',
    categoryLoading: false,
    categoryGradient: '',
    categoryAccentColor: '',
    sources: 0,
    total: 0,
    searchTerm: '',
    businessLinksLoading: false,
    fieldIndex: 0,
  },
  setState: state =>
    set({
      state: {
        ...get().state,
        ...state,
      },
    }),
}));

export function useBusinessLinkCategories(params: IResearchLinkCategoriesQuery, enabled = true) {
  return useQuery({
    queryKey: ['business-link-categories', JSON.stringify(params)],
    queryFn: async () => {
      const { data } = await api.get<{
        data: IResearchLinkCategoryDocument[];
        meta: { pagination: IPagination; overallTotal: number };
      }>('/api/business-links/category', { params });
      return data;
    },
    staleTime: 1000 * 60 * 60, // 1 hour
    placeholderData: prev => prev,
    enabled,
  });
}

export function useBusinessLinks(params: IResearchLinksQuery, enabled = true) {
  return useQuery({
    queryKey: ['business-links', JSON.stringify(params)],
    queryFn: async () => {
      const { data } = await api.get<{
        data: IResearchLinkWithCategory[];
        meta: { pagination: IPagination; overallTotal: number };
      }>('/api/business-links', { params });
      return data;
    },
    staleTime: 1000 * 60 * 60, // 1 hour
    placeholderData: prev => prev,
    enabled,
  });
}

export function useCreateBusinessLinkCategory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: Partial<IResearchLinkCategoryDocument>) => {
      const { data } = await api.post('/api/business-links/category', payload);
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['business-link-categories'] });
    },
  });
}

export function useUpdateBusinessLinkCategory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...payload }: Partial<IResearchLinkCategoryDocument> & { id: string }) => {
      const { data } = await api.put(`/api/business-links/category/${id}`, payload);
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['business-link-categories'] });
    },
  });
}

export function useDeleteBusinessLinkCategory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/api/business-links/category/${id}`);
      return id;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['business-link-categories'] });
    },
  });
}

export function useCreateBusinessLink() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: Partial<IResearchLinkDocument>) => {
      const { data } = await api.post('/api/business-links', payload);
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['business-links'] });
    },
  });
}

export function useUpdateBusinessLink() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...payload }: Partial<IResearchLinkDocument> & { id: string }) => {
      const { data } = await api.put(`/api/business-links/${id}`, payload);
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['business-links'] });
    },
  });
}

export function useDeleteBusinessLink() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/api/business-links/${id}`);
      return id;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['business-links'] });
    },
  });
}

function csvEscape(value: string) {
  if (value == null) return '';
  const needsQuotes = /[",\n]/.test(value);
  let escaped = value.replace(/"/g, '""');
  if (needsQuotes) {
    escaped = `"${escaped}"`;
  }
  return escaped;
}

export function useExportCSV() {
  const { data: linksData } = useBusinessLinks({ pageSize: PAGE_SIZE, pageNumber: 1 }, true);

  return async () => {
    try {
      const links = linksData?.data || [];
      const header = 'Company,Ticker,URL,Type,Category,Category Description';
      const rows = links.map((link: IResearchLinkWithCategory) => {
        const values = [
          link.name,
          link.ticker,
          link.url,
          link.type,
          link.category?.name ?? '',
          link.category?.description ?? '',
        ].map(v => csvEscape(String(v ?? '')));
        return values.join(',');
      });
      const csv = [header, ...rows].join('\n');
      downloadData(csv, 'business-links-export.csv', 'text/csv');
      toast.success('Exported CSV successfully');
    } catch (e) {
      toast.error('Failed to export CSV');
    }
  };
}

export function useDownloadTemplate() {
  return async () => {
    try {
      const csv = downloadTemplateData();
      downloadData(csv, 'business-links-template.csv', 'text/csv');
      toast.success('Downloaded template');
    } catch (e) {
      toast.error('Failed to download template');
    }
  };
}

export function useImportCSV() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (csv: string) => {
      const res = await api.post('/api/business-links/import', { csv });
      return res.data;
    },
    onSuccess: () => {
      toast.success('Imported CSV successfully');
      queryClient.invalidateQueries({ queryKey: ['business-link-categories'] });
      queryClient.invalidateQueries({ queryKey: ['business-links'] });
    },
    onError: () => {
      toast.error('Failed to import CSV');
    },
  });
}
