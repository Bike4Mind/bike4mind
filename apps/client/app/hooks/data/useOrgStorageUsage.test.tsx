import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactNode } from 'react';
import { useOrgStorageUsage } from './useOrgStorageUsage';

const mockGet = vi.fn();
vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { get: (...args: unknown[]) => mockGet(...args) },
}));

const wrapper = ({ children }: { children: ReactNode }) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
};

beforeEach(() => {
  mockGet.mockReset();
});

describe('useOrgStorageUsage', () => {
  it('GETs the org storage-usage route and returns its body', async () => {
    const usage = { organizationId: 'o1', usedBytes: 1, limitBytes: 2, uploaders: [], uploadersTruncated: false };
    mockGet.mockResolvedValue({ data: usage });

    const { result } = renderHook(() => useOrgStorageUsage('o1'), { wrapper });

    await waitFor(() => expect(result.current.data).toEqual(usage));
    expect(mockGet).toHaveBeenCalledWith('/api/organizations/o1/storage-usage');
  });

  it('does not fetch without an org id', () => {
    const { result } = renderHook(() => useOrgStorageUsage(null), { wrapper });

    expect(result.current.fetchStatus).toBe('idle');
    expect(mockGet).not.toHaveBeenCalled();
  });
});
