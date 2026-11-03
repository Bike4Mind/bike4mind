import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import { downloadUrl } from '@client/app/utils/download';
import { AxiosError, AxiosHeaders } from 'axios';
import { makeAuditEntry } from '@client/app/components/admin/AuditLog/shared/auditTestFixtures';
import {
  downloadAuditLogCsv,
  useAuditEntry,
  useAuditLog,
  useAuditReview,
  useAuditReviewQueue,
  useMarkAuditReviewed,
  useUnmarkAuditReviewed,
  useUnreviewedAuditCount,
} from './adminAuditLog';

vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { get: vi.fn(), post: vi.fn(), delete: vi.fn() },
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));
vi.mock('@client/app/utils/download', () => ({ downloadUrl: vi.fn() }));

const get = api.get as unknown as Mock;
const post = api.post as unknown as Mock;
const del = api.delete as unknown as Mock;

const makeWrapper = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, wrapper };
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('downloadAuditLogCsv', () => {
  it('fetches the staged export and downloads it from the signed URL', async () => {
    get.mockResolvedValue({
      data: { url: 'https://storage.example.test/signed', rowCount: 3, truncated: true, fileName: 'audit-log.csv' },
    });

    const result = await downloadAuditLogCsv({ category: 'credits', severity: undefined });

    expect(get).toHaveBeenCalledWith('/api/admin/audit-log/export', { params: { category: 'credits' } });
    expect(downloadUrl).toHaveBeenCalledWith('https://storage.example.test/signed', 'audit-log.csv');
    expect(result).toEqual({ truncated: true });
  });

  it('propagates a failed request without downloading', async () => {
    get.mockRejectedValue(new Error('boom'));

    await expect(downloadAuditLogCsv({})).rejects.toThrow('boom');
    expect(downloadUrl).not.toHaveBeenCalled();
  });
});

describe('useAuditLog', () => {
  it('keys the cache by page size so lists of different limits never share an entry', async () => {
    get.mockResolvedValue({ data: { entries: [], nextCursor: null } });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    renderHook(() => useAuditLog({}), { wrapper });
    renderHook(() => useAuditLog({}, { limit: 20 }), { wrapper });

    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    const limits = get.mock.calls.map(([, options]) => (options as { params: { limit: string } }).params.limit);
    expect(limits.sort()).toEqual(['20', '50']);
  });

  it('sends the next cursor when loading another page and revives occurredAt to a Date', async () => {
    get
      .mockResolvedValueOnce({
        data: {
          entries: [{ ...makeAuditEntry(), occurredAt: '2026-10-01T00:00:00.000Z' }],
          nextCursor: 'c1',
        },
      })
      .mockResolvedValueOnce({ data: { entries: [makeAuditEntry({ id: 'entry-2' })], nextCursor: null } });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(() => useAuditLog({ category: 'credits' }), { wrapper });

    await waitFor(() => expect(result.current.data?.pages[0].entries[0].occurredAt).toBeInstanceOf(Date));
    await act(async () => {
      await result.current.fetchNextPage();
    });

    expect(get).toHaveBeenCalledTimes(2);
    expect((get.mock.calls[1][1] as { params: Record<string, string> }).params).toMatchObject({
      category: 'credits',
      cursor: 'c1',
      limit: '50',
    });
    await waitFor(() => expect(result.current.data?.pages).toHaveLength(2));
    expect(result.current.data?.pages[1].entries[0].occurredAt).toBeInstanceOf(Date);
  });
});

describe('useAuditEntry', () => {
  it('does not retry a 404, so the page can clear the link straight away', async () => {
    const notFound = new AxiosError('Not found', '404', undefined, undefined, {
      status: 404,
      statusText: 'Not Found',
      data: {},
      headers: {},
      config: { headers: new AxiosHeaders() },
    });
    get.mockRejectedValue(notFound);
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(() => useAuditEntry('missing'), { wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(get).toHaveBeenCalledTimes(1);
  });
});

describe('review queue hooks', () => {
  it('requests the queue with status, from and cursor, and revives entry and review dates', async () => {
    const wireEntry = {
      ...makeAuditEntry({ severity: 'critical' }),
      occurredAt: '2026-10-01T00:00:00.000Z',
      review: {
        auditEntryId: 'entry-1',
        reviewer: { userId: 'u2', name: 'Rita' },
        reviewedAt: '2026-10-02T00:00:00.000Z',
      },
    };
    get
      .mockResolvedValueOnce({ data: { entries: [wireEntry], nextCursor: 'c1', total: 2 } })
      .mockResolvedValueOnce({ data: { entries: [{ ...wireEntry, review: null }], nextCursor: null, total: 2 } });
    const { wrapper } = makeWrapper();

    const { result } = renderHook(() => useAuditReviewQueue('all', { from: '2026-09-01T00:00:00.000Z', limit: 10 }), {
      wrapper,
    });

    await waitFor(() => expect(result.current.data?.pages[0].entries[0].review?.reviewedAt).toBeInstanceOf(Date));
    expect(result.current.data?.pages[0].entries[0].occurredAt).toBeInstanceOf(Date);
    expect(get).toHaveBeenCalledWith('/api/admin/audit-log/review-queue', {
      params: { status: 'all', limit: '10', from: '2026-09-01T00:00:00.000Z' },
    });
    await act(async () => {
      await result.current.fetchNextPage();
    });
    expect((get.mock.calls[1][1] as { params: Record<string, string> }).params.cursor).toBe('c1');
    await waitFor(() => expect(result.current.data?.pages).toHaveLength(2));
    expect(result.current.data?.pages[1].entries[0].review).toBeNull();
  });

  it('counts unreviewed entries from the total of a one-row page, and stays idle when disabled', async () => {
    get.mockResolvedValue({ data: { entries: [], nextCursor: null, total: 7 } });
    const { wrapper } = makeWrapper();

    const idle = renderHook(() => useUnreviewedAuditCount({ enabled: false }), { wrapper });
    expect(idle.result.current.fetchStatus).toBe('idle');
    expect(get).not.toHaveBeenCalled();

    const { result } = renderHook(() => useUnreviewedAuditCount({ enabled: true }), { wrapper });
    await waitFor(() => expect(result.current.data).toBe(7));
    expect(get).toHaveBeenCalledWith('/api/admin/audit-log/review-queue', {
      params: { status: 'unreviewed', limit: '1' },
    });
  });

  it('looks up one review by entry id and revives reviewedAt; null id does not fetch', async () => {
    get.mockResolvedValue({
      data: {
        review: { auditEntryId: 'e1', reviewer: { userId: 'u', name: 'N' }, reviewedAt: '2026-10-02T00:00:00.000Z' },
      },
    });
    const { wrapper } = makeWrapper();

    const idle = renderHook(() => useAuditReview(null), { wrapper });
    expect(idle.result.current.fetchStatus).toBe('idle');

    const { result } = renderHook(() => useAuditReview('e1'), { wrapper });
    await waitFor(() => expect(result.current.data?.reviewedAt).toBeInstanceOf(Date));
    expect(get).toHaveBeenCalledWith('/api/admin/audit-log/reviews', { params: { entryId: 'e1' } });
  });

  it('posts a review and invalidates the audit log', async () => {
    post.mockResolvedValue({ data: { reviewed: ['e1'], skipped: [] } });
    const { wrapper, queryClient } = makeWrapper();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useMarkAuditReviewed(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ entryIds: ['e1'], note: 'ok' });
    });

    expect(post).toHaveBeenCalledWith('/api/admin/audit-log/reviews', { entryIds: ['e1'], note: 'ok' });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['admin', 'audit-log'] });
  });

  it('sends the unmark ids as the DELETE body', async () => {
    del.mockResolvedValue({ data: { unreviewed: ['e1'], skipped: [] } });
    const { wrapper } = makeWrapper();

    const { result } = renderHook(() => useUnmarkAuditReviewed(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ entryIds: ['e1'] });
    });

    expect(del).toHaveBeenCalledWith('/api/admin/audit-log/reviews', { data: { entryIds: ['e1'] } });
  });
});
