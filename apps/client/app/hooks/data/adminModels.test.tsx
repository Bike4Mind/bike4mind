import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mockGet = vi.hoisted(() => vi.fn());
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: (...a: unknown[]) => mockGet(...a) } }));

import { useAdminModelsOfType } from './adminModels';

const row = (id: string) => ({ id, name: id, type: 'text' });

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    {children}
  </QueryClientProvider>
);

beforeEach(() => vi.clearAllMocks());

describe('useAdminModelsOfType', () => {
  it('pages until the server has no rows left, so a type past one page is whole', async () => {
    const first = Array.from({ length: 500 }, (_, i) => row(`model-${i}`));
    mockGet.mockImplementation(async (_url: string, { params }: { params: Record<string, string> }) => ({
      data:
        params.page === '1'
          ? { models: first, total: 502 }
          : { models: [row('model-500'), row('model-501')], total: 502 },
    }));

    const { result } = renderHook(() => useAdminModelsOfType('text'), { wrapper });

    await waitFor(() => expect(result.current.data?.rows).toHaveLength(502));
    expect(result.current.data?.truncated).toBe(false);
    expect(mockGet).toHaveBeenCalledTimes(2);
    expect(mockGet.mock.calls.map(([, config]) => config.params)).toEqual([
      expect.objectContaining({ types: 'text', page: '1', pageSize: '500', sort: 'name' }),
      expect.objectContaining({ types: 'text', page: '2', pageSize: '500', sort: 'name' }),
    ]);
  });

  it('stops after one request when the first page holds everything', async () => {
    mockGet.mockResolvedValue({ data: { models: [row('a')], total: 1 } });

    const { result } = renderHook(() => useAdminModelsOfType('text'), { wrapper });

    await waitFor(() => expect(result.current.data?.rows).toHaveLength(1));
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it('says the result was cut when the page cap stops it before the server runs out', async () => {
    mockGet.mockImplementation(async (_url: string, { params }: { params: Record<string, string> }) => ({
      data: { models: [row(`model-${params.page}`)], total: 6000 },
    }));

    const { result } = renderHook(() => useAdminModelsOfType('text'), { wrapper });

    await waitFor(() => expect(result.current.data?.truncated).toBe(true));
    expect(result.current.data?.rows).toHaveLength(10);
    expect(mockGet).toHaveBeenCalledTimes(10);
  });
});
