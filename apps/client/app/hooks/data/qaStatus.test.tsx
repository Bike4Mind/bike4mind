import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QaTestWrapper } from '@client/app/components/QaStatus/testTheme';

const { mockGet } = vi.hoisted(() => ({ mockGet: vi.fn() }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: (...a: unknown[]) => mockGet(...a) } }));

import { parseQaStatusSearch, useQaOverview, useQaRuns, useQaTestHistory } from './qaStatus';

beforeEach(() => mockGet.mockReset().mockResolvedValue({ data: { runs: [], tiles: [], series: [], flaky: [] } }));

describe('qaStatus hooks', () => {
  it('passes testKey through as a query param, not a path segment', async () => {
    const testKey = 'e2e/notebook.spec.ts > Notebook > saves ?#';
    renderHook(() => useQaTestHistory(testKey), { wrapper: QaTestWrapper });
    await waitFor(() => expect(mockGet).toHaveBeenCalled());
    expect(mockGet).toHaveBeenCalledWith('/api/admin/qa/tests', { params: { testKey } });
  });

  it('sends normalized filters and waits for a product', async () => {
    const { rerender } = renderHook(({ product }) => useQaOverview({ product, tenant: '', range: '30d' }), {
      wrapper: QaTestWrapper,
      initialProps: { product: undefined as string | undefined },
    });
    expect(mockGet).not.toHaveBeenCalled();
    rerender({ product: 'product-a' });
    await waitFor(() =>
      expect(mockGet).toHaveBeenCalledWith('/api/admin/qa/overview', {
        params: { product: 'product-a', branch: 'main', range: '30d' },
      })
    );
  });

  it('pages runs with the before cursor', async () => {
    mockGet.mockResolvedValueOnce({ data: { runs: [], nextBefore: '2026-09-28T09:00:00.000Z' } });
    const { result } = renderHook(() => useQaRuns({ product: 'product-a' }), { wrapper: QaTestWrapper });
    await waitFor(() => expect(result.current.hasNextPage).toBe(true));
    await result.current.fetchNextPage();
    expect(mockGet).toHaveBeenLastCalledWith('/api/admin/qa/runs', {
      params: { product: 'product-a', branch: 'main', range: '7d', before: '2026-09-28T09:00:00.000Z' },
    });
  });
});

describe('parseQaStatusSearch', () => {
  it('keeps known string params and drops the rest', () => {
    expect(parseQaStatusSearch({ product: 'product-a', range: '90d', env: 3, branch: 'main' })).toEqual({
      product: 'product-a',
      branch: 'main',
    });
  });
});
