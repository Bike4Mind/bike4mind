import type { ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@client/app/contexts/apiClient', () => ({ api: { get } }));
import { useAdminEntitySearch } from './useAdminEntitySearch';

let client: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={client}>{children}</QueryClientProvider>
);
const userResult = { type: 'user', id: 'a'.repeat(24), displayName: 'Example user', secondary: 'e***@example.com' };

beforeEach(() => {
  vi.useFakeTimers();
  client = new QueryClient();
  get.mockReset();
  get.mockResolvedValue({ data: { results: [userResult] } });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('useAdminEntitySearch', () => {
  it('does not fetch before the 500ms debounce elapses', async () => {
    const { result } = renderHook(() => useAdminEntitySearch('someone@example.com'), { wrapper });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(499);
    });
    expect(get).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(get).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(result.current.results).toHaveLength(1);
    expect(result.current.loading).toBe(false);
  });

  it('clears stale results immediately when the query is edited', async () => {
    const { result, rerender } = renderHook(({ q }) => useAdminEntitySearch(q), {
      wrapper,
      initialProps: { q: 'first@example.com' },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(result.current.results).toHaveLength(1);
    rerender({ q: 'second@example.com' });
    expect(result.current.results).toEqual([]);
    expect(result.current.loading).toBe(true);
  });

  it.each(['', ' a ', 'b4m_live_' + 'a'.repeat(32)])('is not loading and never fetches for %j', async q => {
    const { result } = renderHook(() => useAdminEntitySearch(q), { wrapper });
    expect(result.current.loading).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.results).toEqual([]);
    expect(get).not.toHaveBeenCalled();
  });
});
