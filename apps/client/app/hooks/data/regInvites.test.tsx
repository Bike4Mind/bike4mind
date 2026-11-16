import React from 'react';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const { submitReferral, refreshUser, calls, toast } = vi.hoisted(() => ({
  submitReferral: vi.fn(),
  refreshUser: vi.fn(),
  calls: {
    createRegInvites: vi.fn(),
    deleteRegInvites: vi.fn(),
    getRegInvitesFromServer: vi.fn(),
    submitUserInvitation: vi.fn(),
    updateRegInvites: vi.fn(),
  },
  toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock('@client/app/contexts/UserContext', () => ({ useUser: { getState: () => ({ refreshUser }) } }));
vi.mock('@client/app/utils/regInviteAPICalls', () => ({ submitReferral, ...calls }));
vi.mock('sonner', () => ({ toast }));
import {
  useCreateRegInvites,
  useDeleteRegInvites,
  useGetRegInvites,
  useSubmitReferral,
  useSubmitUserInvitation,
  useUpdateRegInvites,
} from './regInvites';
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

const renderWithClient = <T,>(hook: () => T) => {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
  const view = renderHook(hook, {
    wrapper: ({ children }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
  });
  return { ...view, queryClient };
};

it('loads the invites', async () => {
  calls.getRegInvitesFromServer.mockResolvedValue([{ id: 'i1' }]);
  const { result, queryClient } = renderWithClient(() => useGetRegInvites());
  await waitFor(() => expect(result.current.data).toEqual([{ id: 'i1' }]));
  queryClient.clear();
});

it('submits a user invitation', async () => {
  calls.submitUserInvitation.mockResolvedValue({ ok: true });
  const { result, queryClient } = renderWithClient(() => useSubmitUserInvitation());
  const data = { friendEmail: ['a@example.com'], emailTitle: 'Hi', emailBody: 'Join' };
  await act(async () => {
    await result.current.mutateAsync(data);
  });
  expect(calls.submitUserInvitation).toHaveBeenCalledWith(data);
  queryClient.clear();
});

type Callbacks = { onSuccess: () => void; onError: () => void };

describe.each([
  [
    'update',
    useUpdateRegInvites,
    calls.updateRegInvites,
    { ids: ['i1'], reason: 'Partner request' },
    'Successfully updated registration invite(s)',
    'Failed to update registration invite',
  ],
  [
    'create',
    useCreateRegInvites,
    calls.createRegInvites,
    { multiple: 1 },
    'Registration invite(s) created',
    'Failed to create registration invite',
  ],
  [
    'delete',
    useDeleteRegInvites,
    calls.deleteRegInvites,
    ['i1'],
    'Registration invite(s) deleted',
    'Failed to delete registration invite(s)',
  ],
] as const)('the %s mutation', (_kind, useHook, apiCall, input, successText, errorText) => {
  const run = async (failure: boolean, withCallbacks: boolean) => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    if (failure) apiCall.mockRejectedValue(new Error('nope'));
    else apiCall.mockResolvedValue({});
    const options = { onSuccess: vi.fn(), onError: vi.fn() };
    // Each row pairs a hook with its own input; the hooks differ only in that argument type.
    const hook = useHook as unknown as (o?: Callbacks) => { mutate: (v: unknown) => void };
    const { result, queryClient } = renderWithClient(() => hook(withCallbacks ? options : undefined));
    act(() => result.current.mutate(input));
    await waitFor(() => expect(failure ? toast.error : toast.success).toHaveBeenCalled());
    expect(apiCall).toHaveBeenCalledWith(input);
    consoleError.mockRestore();
    queryClient.clear();
    return options;
  };

  it('toasts and calls back on success', async () => {
    const options = await run(false, true);
    expect(toast.success).toHaveBeenCalledWith(successText);
    expect(options.onSuccess).toHaveBeenCalledTimes(1);
  });

  it('toasts and calls back on failure', async () => {
    const options = await run(true, true);
    expect(toast.error).toHaveBeenCalledWith(errorText);
    expect(options.onError).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('works without callbacks (failure: %s)', async failure => {
    await run(failure, false);
  });
});
