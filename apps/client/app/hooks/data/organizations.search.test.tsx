import type { ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: mocks.get } }));
vi.mock('./user', () => ({ useGetOrganizationUsers: vi.fn() }));
import { useSearchOrganizations } from './organizations';
beforeEach(() => mocks.get.mockReset());
const setup = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return renderHook(() => useSearchOrganizations({ page: 1, limit: 25, search: '' }), { wrapper });
};
it('propagates a failed HTTP search to the retry surface', async () => {
  mocks.get.mockRejectedValue(new Error('Search unavailable'));
  const { result } = setup();
  await waitFor(() => expect(result.current.isError).toBe(true));
  expect(result.current.data).toBeUndefined();
  mocks.get.mockResolvedValue({ data: { data: [], total: 0 } });
  await result.current.refetch();
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(result.current.data).toEqual({ data: [], totalPages: 0, totalOrganizations: 0 });
});
it('keeps a genuine successful empty result distinct from failure', async () => {
  mocks.get.mockResolvedValue({ data: { data: [], total: 0 } });
  const { result } = setup();
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(result.current.isError).toBe(false);
  expect(result.current.data?.totalOrganizations).toBe(0);
});
