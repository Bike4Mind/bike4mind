import type { ReactNode } from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import { useSpendFeatures, useSpendFeatureUsers } from './useFeatureCost';

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: vi.fn() } }));
const get = vi.mocked(api.get);

const RANGE = { from: new Date('2026-03-08T00:00:00Z'), to: new Date('2026-03-11T00:00:00Z') };

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const requestedUrl = () => new URL(String(get.mock.calls[0][0]), 'http://admin.test');

beforeEach(() => {
  get.mockReset();
  get.mockResolvedValue({ data: {} });
});

describe('useSpendFeatures', () => {
  it('sends the range, audience and user the server validates', async () => {
    renderHook(() => useSpendFeatures({ range: RANGE, audience: 'external', userId: 'user-1' }), { wrapper });
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));

    const url = requestedUrl();
    expect(url.pathname).toBe('/api/admin/spend-explorer/features');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      from: '2026-03-08T00:00:00.000Z',
      to: '2026-03-11T00:00:00.000Z',
      audience: 'external',
      userId: 'user-1',
    });
  });
});

describe('useSpendFeatureUsers', () => {
  it('turns a 1-based page into limit and offset', async () => {
    renderHook(
      () => useSpendFeatureUsers({ range: RANGE, audience: 'all', feature: 'music_generation', page: 3, pageSize: 25 }),
      { wrapper }
    );
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));

    const url = requestedUrl();
    expect(url.pathname).toBe('/api/admin/spend-explorer/feature-users');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      audience: 'all',
      feature: 'music_generation',
      limit: '25',
      offset: '50',
    });
  });
});
