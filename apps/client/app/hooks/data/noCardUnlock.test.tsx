import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import React from 'react';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import { CREDITS_BALANCE_KEY } from './credits';
import { useNoCardUnlock, usePhoneUnlockStart, usePhoneUnlockVerify } from './noCardUnlock';

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { post: vi.fn() } }));

const post = api.post as unknown as Mock;

const setup = () => {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { wrapper, invalidate };
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('no-card unlock hooks', () => {
  it('posts the number to the phone start route and refreshes nothing', async () => {
    post.mockResolvedValue({ data: { sent: true } });
    const { wrapper, invalidate } = setup();
    const { result } = renderHook(() => usePhoneUnlockStart(), { wrapper });
    await act(async () => {
      expect(await result.current.mutateAsync('+14155552671')).toEqual({ sent: true });
    });
    expect(post).toHaveBeenCalledWith('/api/credits/no-card-unlock/phone/start', { phoneNumber: '+14155552671' });
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('posts the code to the phone verify route and refreshes the balance only on a grant', async () => {
    const { wrapper, invalidate } = setup();
    const { result } = renderHook(() => usePhoneUnlockVerify(), { wrapper });

    post.mockResolvedValue({ data: { creditsGranted: 0, currentCredits: 0, refusal: 'phone_code_invalid' } });
    await act(async () => {
      await result.current.mutateAsync('000000');
    });
    expect(post).toHaveBeenCalledWith('/api/credits/no-card-unlock/phone/verify', { code: '000000' });
    expect(invalidate).not.toHaveBeenCalled();

    post.mockResolvedValue({ data: { creditsGranted: 3, currentCredits: 3 } });
    await act(async () => {
      await result.current.mutateAsync('123456');
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: CREDITS_BALANCE_KEY });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['credit-transactions'] });
  });

  it('keeps the one-click routes unchanged', async () => {
    post.mockResolvedValue({ data: { creditsGranted: 0, currentCredits: 0 } });
    const { wrapper } = setup();
    const { result } = renderHook(() => useNoCardUnlock(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync('github_verified');
      await result.current.mutateAsync('work_email_verified');
    });
    expect(post.mock.calls.map(call => call[0])).toEqual([
      '/api/credits/no-card-unlock/github',
      '/api/credits/no-card-unlock/work-email',
    ]);
  });
});
