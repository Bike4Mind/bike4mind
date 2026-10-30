import React from 'react';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, expect, it, vi } from 'vitest';
const { submitReferral, refreshUser } = vi.hoisted(() => ({ submitReferral: vi.fn(), refreshUser: vi.fn() }));
vi.mock('@client/app/contexts/UserContext', () => ({ useUser: { getState: () => ({ refreshUser }) } }));
vi.mock('@client/app/utils/regInviteAPICalls', () => ({
  submitReferral,
  createRegInvites: vi.fn(),
  deleteRegInvites: vi.fn(),
  getRegInvitesFromServer: vi.fn(),
  submitUserInvitation: vi.fn(),
  updateRegInvites: vi.fn(),
}));
import { useSubmitReferral } from './regInvites';
beforeEach(() => {
  vi.resetAllMocks();
});
it.each([false, true])('refreshes persisted quota after a referral request (failure: %s)', async failure => {
  const error = new Error('delivery failed');
  if (failure) submitReferral.mockRejectedValue(error);
  else submitReferral.mockResolvedValue({ sent: ['friend@example.com'], failed: [] });
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const { result } = renderHook(() => useSubmitReferral(), {
    wrapper: ({ children }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
  });
  await act(async () => {
    const request = result.current.mutateAsync({
      friendEmail: ['friend@example.com'],
      emailTitle: 'Join',
      emailBody: 'Hello',
    });
    if (failure) await expect(request).rejects.toThrow(error);
    else await request;
  });
  expect(refreshUser).toHaveBeenCalledTimes(1);
  queryClient.clear();
});
