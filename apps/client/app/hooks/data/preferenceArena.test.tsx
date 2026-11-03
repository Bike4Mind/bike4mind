import type { ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useArenaVote } from './preferenceArena';
import { CREDITS_BALANCE_KEY } from './credits';

const { postMock } = vi.hoisted(() => ({ postMock: vi.fn() }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: vi.fn(), post: postMock, patch: vi.fn() } }));

const setup = () => {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { invalidate, ...renderHook(() => useArenaVote(), { wrapper }) };
};

const vote = { pairId: 'a'.repeat(24), choice: 'a' } as const;

describe('useArenaVote', () => {
  beforeEach(() => {
    postMock.mockReset();
  });

  it('refreshes the credits balance when credits were awarded', async () => {
    postMock.mockResolvedValue({ data: { creditsAwarded: 2 } });
    const { result, invalidate } = setup();
    await act(async () => {
      await result.current.mutateAsync(vote);
    });
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: CREDITS_BALANCE_KEY }));
  });

  it('leaves the credits balance alone when none were awarded', async () => {
    postMock.mockResolvedValue({ data: { creditsAwarded: 0 } });
    const { result, invalidate } = setup();
    await act(async () => {
      await result.current.mutateAsync(vote);
    });
    expect(invalidate).not.toHaveBeenCalled();
  });
});
