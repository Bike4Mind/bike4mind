import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import React from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import { fetchCreditLedgerExport, useAdminCreditLedger } from './adminUserCredits';

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: vi.fn() } }));

const get = api.get as unknown as Mock;

const createWrapper = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return wrapper;
};

// Param names must match what pages/api/admin/users/[userId]/credit-ledger(-export).ts read from req.query.
const FILTER = { kind: 'usage', model: 'm1', source: 'cli', from: '2026-01-01', to: '2026-01-02' } as const;

describe('admin credit ledger requests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends every filter field as a query param the ledger route reads', async () => {
    get.mockResolvedValue({ data: { rows: [], nextCursor: null } });
    const { result } = renderHook(() => useAdminCreditLedger('u1', FILTER), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(get).toHaveBeenCalledExactlyOnceWith('/api/admin/users/u1/credit-ledger', {
      params: { ...FILTER, limit: '50' },
    });
  });

  it('sends nothing while disabled', async () => {
    const { result } = renderHook(() => useAdminCreditLedger('u1', FILTER, { enabled: false }), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.fetchStatus).toBe('idle'));
    expect(get).not.toHaveBeenCalled();
  });

  it('exports with the same params and reads the file name from the response', async () => {
    get.mockResolvedValue({
      data: new Blob(['Time\n']),
      headers: { 'content-disposition': 'attachment; filename="credits-u1-usage-filtered-2026-01-03.csv"' },
    });

    const file = await fetchCreditLedgerExport('u1', FILTER);

    expect(get).toHaveBeenCalledExactlyOnceWith('/api/admin/users/u1/credit-ledger-export', {
      params: FILTER,
      responseType: 'blob',
    });
    expect(file).toMatchObject({ fileName: 'credits-u1-usage-filtered-2026-01-03.csv', truncated: false });
  });

  it('marks a narrowed export in the fallback file name when the header is missing', async () => {
    get.mockResolvedValue({ data: new Blob(['Time\n']), headers: {} });

    expect((await fetchCreditLedgerExport('u1', FILTER)).fileName).toBe('credits-u1-usage-filtered.csv');
    expect((await fetchCreditLedgerExport('u1', { kind: 'usage' })).fileName).toBe('credits-u1-usage.csv');
    expect((await fetchCreditLedgerExport('u1', {})).fileName).toBe('credits-u1-all.csv');
  });
});
