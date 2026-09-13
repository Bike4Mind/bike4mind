import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import { downloadData } from '@client/app/utils/download';
import { toast } from 'sonner';
import { useBusinessLinks, useExportCSV, usePopularTargets } from './hooks';
import { PAGE_SIZE } from './utils';

vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

vi.mock('@client/app/utils/download', () => ({ downloadData: vi.fn() }));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const ACME = {
  name: 'Acme Corp',
  ticker: 'ACME',
  url: 'https://acme.example.com',
  type: 'tech',
  category: { name: 'Earnings', description: 'Quarterly earnings' },
};

const respondWith = (links: unknown[]) =>
  vi.mocked(api.get).mockResolvedValue({
    data: {
      data: links,
      meta: {
        pagination: { total: links.length, page: 1, totalPages: 1, pagePosition: 'first' },
        overallTotal: links.length,
      },
    },
  });

function makeWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return Wrapper;
}

/** The store is a module singleton, so every test sets the filters it means to assert on. */
const setActiveFilters = (categoryId: string, searchTerm = '') =>
  usePopularTargets.getState().setState({ categoryId, searchTerm });

describe('useExportCSV', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setActiveFilters('', '');
    respondWith([ACME]);
  });

  it('requests only the active category, so the export cannot outrun the list', async () => {
    setActiveFilters('cat-1');

    renderHook(() => useExportCSV(), { wrapper: makeWrapper() });

    await waitFor(() => expect(api.get).toHaveBeenCalled());
    expect(api.get).toHaveBeenCalledWith('/api/business-links', {
      params: { pageSize: PAGE_SIZE, pageNumber: 1, filters: { search: '', categoryId: 'cat-1' } },
    });
  });

  it('carries the active search term into the request', async () => {
    setActiveFilters('cat-1', 'acme');

    renderHook(() => useExportCSV(), { wrapper: makeWrapper() });

    await waitFor(() => expect(api.get).toHaveBeenCalled());
    expect(api.get).toHaveBeenCalledWith('/api/business-links', {
      params: { pageSize: PAGE_SIZE, pageNumber: 1, filters: { search: 'acme', categoryId: 'cat-1' } },
    });
  });

  it('writes exactly the rows the list is showing, from a single shared fetch', async () => {
    setActiveFilters('cat-1');
    const { result } = renderHook(
      () => ({
        // The list's own call, verbatim from BusinessLink.tsx.
        list: useBusinessLinks(
          { pageSize: PAGE_SIZE, pageNumber: 1, filters: { search: '', categoryId: 'cat-1' } },
          true
        ),
        exportCSV: useExportCSV(),
      }),
      { wrapper: makeWrapper() }
    );

    await waitFor(() => expect(result.current.list.data).toBeDefined());
    await act(async () => {
      await result.current.exportCSV();
    });

    expect(result.current.list.data?.data).toHaveLength(1);
    expect(downloadData).toHaveBeenCalledWith(
      'Company,Ticker,URL,Type,Category,Category Description\n' +
        'Acme Corp,ACME,https://acme.example.com,tech,Earnings,Quarterly earnings',
      'business-links-export.csv',
      'text/csv'
    );
    expect(toast.success).toHaveBeenCalledWith('Exported CSV successfully');
    // Identical params collapse list and export into one cache entry, so the modal fetches once.
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it('downloads nothing before a category resolves, rather than a header-only CSV under a success toast', async () => {
    setActiveFilters('');
    const { result } = renderHook(() => useExportCSV(), { wrapper: makeWrapper() });

    await act(async () => {
      await result.current();
    });

    expect(api.get).not.toHaveBeenCalled();
    expect(downloadData).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });
});
