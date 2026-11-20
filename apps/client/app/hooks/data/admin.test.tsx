import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useUpdateSecurityScanSchedule } from './admin';

const mocks = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { post: mocks.post } }));

beforeEach(() => {
  vi.resetAllMocks();
});

describe('useUpdateSecurityScanSchedule', () => {
  it('refreshes the per-scan schedule, the all-scans schedules the summary table reads, and the overview', async () => {
    mocks.post.mockResolvedValue({ data: {} });
    const cache = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const invalidate = vi.spyOn(cache, 'invalidateQueries');
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={cache}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useUpdateSecurityScanSchedule('web'), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ enabled: true });
    });

    expect(mocks.post).toHaveBeenCalledWith('/api/admin/security-scan-schedule/web', { enabled: true });
    const keys = invalidate.mock.calls.map(([filters]) => filters?.queryKey);
    expect(keys).toContainEqual(['admin', 'security-scan-schedule', 'web']);
    expect(keys).toContainEqual(['admin', 'security-scan-schedules']);
    expect(keys).toContainEqual(['admin', 'security-dashboard', 'overview']);
  });
});
