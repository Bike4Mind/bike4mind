import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import React from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import { downloadUrl } from '@client/app/utils/download';
import { downloadAuditLogCsv, useAuditLog } from './adminAuditLog';

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: vi.fn() } }));
vi.mock('@client/app/utils/download', () => ({ downloadUrl: vi.fn() }));

const get = api.get as unknown as Mock;

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
});
