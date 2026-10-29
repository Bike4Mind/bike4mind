import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import React from 'react';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AxiosError, AxiosHeaders } from 'axios';
import { toast } from 'sonner';
import { api } from '@client/app/contexts/ApiContext';
import { loopKeys, useRunLoop, useUpdateLoop } from './loops';

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { post: vi.fn(), patch: vi.fn() } }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const post = api.post as unknown as Mock;
const patch = api.patch as unknown as Mock;

const httpError = (status: number, message: string) =>
  new AxiosError(message, String(status), undefined, undefined, {
    status,
    statusText: '',
    data: { message },
    headers: {},
    config: { headers: new AxiosHeaders() },
  });

function setup() {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { invalidate, wrapper };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('loop mutations', () => {
  it('toasts the server message and reloads loops on a 409', async () => {
    patch.mockRejectedValue(httpError(409, 'Loop changed while saving; reload and try again'));
    const { invalidate, wrapper } = setup();
    const { result } = renderHook(() => useUpdateLoop(), { wrapper });

    await act(() => result.current.mutateAsync({ id: 'l1', status: 'paused' }).catch(() => undefined));

    expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/Loop changed while saving/));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: loopKeys.all });
  });

  it('toasts other errors without reloading', async () => {
    patch.mockRejectedValue(httpError(400, 'name is required'));
    const { invalidate, wrapper } = setup();
    const { result } = renderHook(() => useUpdateLoop(), { wrapper });

    await act(() => result.current.mutateAsync({ id: 'l1', name: '' }).catch(() => undefined));

    expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/name is required/));
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('confirms Run now and reloads loops', async () => {
    post.mockResolvedValue({ data: {} });
    const { invalidate, wrapper } = setup();
    const { result } = renderHook(() => useRunLoop(), { wrapper });

    await act(() => result.current.mutateAsync('l1'));

    expect(post).toHaveBeenCalledWith('/api/loops/l1/run');
    expect(toast.success).toHaveBeenCalledWith('Runs within 5 minutes');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: loopKeys.all });
  });
});
