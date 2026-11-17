import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { mockGet, mockPatch } = vi.hoisted(() => ({ mockGet: vi.fn(), mockPatch: vi.fn() }));
vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { get: (...a: unknown[]) => mockGet(...a), patch: (...a: unknown[]) => mockPatch(...a) },
}));

import { patchModelAccess, useAdminModelsOfType, useInvalidateModelAccess } from './adminModels';
import { MODEL_CONFIGURATIONS_QUERY_KEY } from './modelAccessRevision';

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

describe('patchModelAccess', () => {
  const result = { entry: null, changed: true, revision: 'r2' };
  const body = { change: { enabled: false }, reason: 'Retire the model' };

  it('makes the write conditional on the stamp of the entry as loaded', async () => {
    mockPatch.mockResolvedValue({ data: result });
    const loaded = {
      enabled: true,
      allowedUserTags: [],
      allowedEntitlements: ['base'],
      updatedAt: '2026-11-01T00:00:00.000Z',
    };

    await patchModelAccess('model-a', loaded, body);

    expect(mockPatch).toHaveBeenCalledWith(
      '/api/admin/models/access',
      { ...body, expectedUpdatedAt: '2026-11-01T00:00:00.000Z' },
      { params: { id: 'model-a' } }
    );
  });

  it('sends a null stamp for a model with no entry or an unstamped one', async () => {
    mockPatch.mockResolvedValue({ data: result });

    await patchModelAccess('model-a', null, body);
    await patchModelAccess('model-b', { enabled: true, allowedUserTags: [], allowedEntitlements: [] }, body);

    expect(mockPatch.mock.calls.map(([, sent]) => sent.expectedUpdatedAt)).toEqual([null, null]);
  });
});

describe('useInvalidateModelAccess', () => {
  it('refetches a picker query no mounted observer is watching', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    const queryFn = vi.fn().mockResolvedValue({ configurations: [], revision: 'r1' });
    await client.fetchQuery({ queryKey: MODEL_CONFIGURATIONS_QUERY_KEY, queryFn });
    expect(client.getQueryCache().find({ queryKey: MODEL_CONFIGURATIONS_QUERY_KEY })?.isActive()).toBe(false);
    const { result } = renderHook(() => useInvalidateModelAccess(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    });

    await result.current();

    expect(queryFn).toHaveBeenCalledTimes(2);
    client.clear();
  });
});
