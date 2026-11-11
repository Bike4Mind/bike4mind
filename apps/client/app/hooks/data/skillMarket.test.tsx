// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn() }));
vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { get: h.get, post: h.post, put: h.put, delete: h.del },
}));

import {
  useDeleteSkillBundle,
  useListingDetail,
  useReportListing,
  useSaveSkillBundle,
  useWithdrawListing,
} from './skillMarket';

const setup = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { qc, wrapper };
};

describe('skillMarket hooks', () => {
  beforeEach(() => vi.clearAllMocks());

  it('fetches by id without sending a token, and by share-token path when only a token is given', async () => {
    h.get.mockResolvedValue({ data: { listing: { id: 'l1' } } });
    const { wrapper } = setup();
    const byId = renderHook(() => useListingDetail({ id: 'l1', token: 'abc' }), { wrapper });
    await waitFor(() => expect(byId.result.current.isSuccess).toBe(true));
    expect(h.get).toHaveBeenLastCalledWith('/api/skills/market/l1');
    const byToken = renderHook(() => useListingDetail({ token: 'abc' }), { wrapper });
    await waitFor(() => expect(byToken.result.current.isSuccess).toBe(true));
    expect(h.get).toHaveBeenLastCalledWith('/api/skills/market/by-token/abc');
  });

  it('invalidates the reports queue and listing detail after a report', async () => {
    h.post.mockResolvedValue({ data: { ok: true } });
    const { qc, wrapper } = setup();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useReportListing(), { wrapper });
    await act(() => result.current.mutateAsync({ listingId: 'l1', reason: 'spam' as never }));
    const keys = spy.mock.calls.map(c => c[0]?.queryKey);
    expect(keys).toContainEqual(['skill-market', 'review-queue', 'reports']);
    expect(keys).toContainEqual(['skill-market', 'listing']);
  });

  it('does not refetch the cached me query on a market mutation', async () => {
    const { qc, wrapper } = setup();
    qc.setQueryData(['skill-market', 'me'], { isReviewer: true });
    qc.setQueryData(['skill-market', 'mine'], []);
    h.del.mockResolvedValue(undefined);
    const { result } = renderHook(() => useWithdrawListing(), { wrapper });
    await act(() => result.current.mutateAsync('l1'));
    expect(qc.getQueryState(['skill-market', 'me'])?.isInvalidated).toBe(false);
    expect(qc.getQueryState(['skill-market', 'mine'])?.isInvalidated).toBe(true);
  });

  describe('skill bundles', () => {
    const input = { name: 'Pack', description: 'd', listingIds: ['l1'] };
    const bundlesKey = ['skill-market', 'bundles', 'org1'];

    it('creates with a POST that names the org, then refreshes the bundles', async () => {
      h.post.mockResolvedValue({ data: { id: 'b1' } });
      const { qc, wrapper } = setup();
      const spy = vi.spyOn(qc, 'invalidateQueries');
      const { result } = renderHook(() => useSaveSkillBundle('org1'), { wrapper });
      await act(() => result.current.mutateAsync(input));
      expect(h.post).toHaveBeenCalledWith('/api/skills/market/bundles', { ...input, organizationId: 'org1' });
      expect(h.put).not.toHaveBeenCalled();
      expect(spy.mock.calls.map(c => c[0]?.queryKey)).toContainEqual(bundlesKey);
    });

    it('edits with a PUT to the bundle, without the org, then refreshes the bundles', async () => {
      h.put.mockResolvedValue({ data: { id: 'b1' } });
      const { qc, wrapper } = setup();
      const spy = vi.spyOn(qc, 'invalidateQueries');
      const { result } = renderHook(() => useSaveSkillBundle('org1'), { wrapper });
      await act(() => result.current.mutateAsync({ ...input, id: 'b1' }));
      expect(h.put).toHaveBeenCalledWith('/api/skills/market/bundles/b1', input);
      expect(h.post).not.toHaveBeenCalled();
      expect(spy.mock.calls.map(c => c[0]?.queryKey)).toContainEqual(bundlesKey);
    });

    it('deletes with a DELETE, then refreshes the bundles', async () => {
      h.del.mockResolvedValue(undefined);
      const { qc, wrapper } = setup();
      const spy = vi.spyOn(qc, 'invalidateQueries');
      const { result } = renderHook(() => useDeleteSkillBundle('org1'), { wrapper });
      await act(() => result.current.mutateAsync('b1'));
      expect(h.del).toHaveBeenCalledWith('/api/skills/market/bundles/b1');
      expect(spy.mock.calls.map(c => c[0]?.queryKey)).toContainEqual(bundlesKey);
    });
  });
});
