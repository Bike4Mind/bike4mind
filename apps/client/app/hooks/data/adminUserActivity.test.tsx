import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import { makeAuditEntry } from '@client/app/components/admin/AuditLog/shared/auditTestFixtures';
import { useUserActivity, useUserCreditHistory } from './adminUserActivity';

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: vi.fn() } }));

const get = api.get as unknown as Mock;
const USER_ID = '650000000000000000000001';

const wrapperFor = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return Wrapper;
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useUserActivity', () => {
  it('revives occurredAt to a Date and sends the next cursor on the following page', async () => {
    get
      .mockResolvedValueOnce({
        data: {
          entries: [{ ...makeAuditEntry({ id: 'a'.repeat(24) }), occurredAt: '2026-10-01T00:00:00.000Z' }],
          nextCursor: 'cursor-1',
          actorViewAvailable: true,
        },
      })
      .mockResolvedValueOnce({
        data: {
          entries: [{ ...makeAuditEntry({ id: 'b'.repeat(24) }), occurredAt: '2026-09-30T00:00:00.000Z' }],
          nextCursor: null,
          actorViewAvailable: true,
        },
      });

    const { result } = renderHook(() => useUserActivity(USER_ID, { direction: 'target', includeSecurity: true }), {
      wrapper: wrapperFor(),
    });

    await waitFor(() => expect(result.current.data?.pages[0].entries[0].occurredAt).toBeInstanceOf(Date));
    expect(result.current.data?.pages[0].actorViewAvailable).toBe(true);
    expect(result.current.hasNextPage).toBe(true);

    await act(async () => {
      await result.current.fetchNextPage();
    });

    expect(get).toHaveBeenCalledTimes(2);
    expect(get.mock.calls[0][1]).toMatchObject({
      params: { direction: 'target', includeSecurity: 'true', limit: '50' },
    });
    expect(get.mock.calls[0][1].params).not.toHaveProperty('cursor');
    expect(get.mock.calls[1][1].params).toMatchObject({ cursor: 'cursor-1' });

    await waitFor(() => expect(result.current.data?.pages).toHaveLength(2));
    expect(result.current.data?.pages[1].entries[0].occurredAt).toBeInstanceOf(Date);
    // A null nextCursor ends the sequence rather than yielding an undefined page param.
    expect(result.current.hasNextPage).toBe(false);
  });

  it('does not fetch while disabled', async () => {
    get.mockResolvedValue({ data: { entries: [], nextCursor: null, actorViewAvailable: false } });

    const { result } = renderHook(
      () => useUserActivity(USER_ID, { direction: 'actor', includeSecurity: false, enabled: false }),
      { wrapper: wrapperFor() }
    );

    await waitFor(() => expect(result.current.fetchStatus).toBe('idle'));
    expect(get).not.toHaveBeenCalled();
  });
});

describe('useUserCreditHistory', () => {
  it('requests the credit history for the user', async () => {
    const history = { windowDays: 90, currentBalance: 5, points: [], adjustments: [], adjustmentsTruncated: false };
    get.mockResolvedValue({ data: { ...history, unreliableBefore: null } });

    const { result } = renderHook(() => useUserCreditHistory(USER_ID), { wrapper: wrapperFor() });

    await waitFor(() => expect(result.current.data?.currentBalance).toBe(5));
    expect(get).toHaveBeenCalledWith(`/api/admin/users/${USER_ID}/credit-history`);
  });
});
