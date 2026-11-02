import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AxiosError, AxiosHeaders } from 'axios';
import { toast } from 'sonner';
import { api } from '@client/app/contexts/ApiContext';
import {
  loopKeys,
  useDeleteLoop,
  useLoop,
  useLoopEvents,
  useLoopTickets,
  useLoops,
  useResolveUnsure,
  useRunLoop,
  useUpdateLoop,
} from './loops';

vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const post = api.post as unknown as Mock;
const patch = api.patch as unknown as Mock;
const get = api.get as unknown as Mock;
const del = api.delete as unknown as Mock;

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
  return { invalidate, wrapper, queryClient };
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

describe('useDeleteLoop', () => {
  it("refetches the loop list but never the deleted loop's detail, tickets or events", async () => {
    del.mockResolvedValue({ data: {} });
    get.mockResolvedValue({ data: [] });
    const { wrapper } = setup();
    // The detail page's queries are still mounted when the delete succeeds.
    const { result } = renderHook(
      () => {
        useLoops();
        useLoop('l1');
        useLoopTickets('l1');
        useLoopEvents('l1');
        return useDeleteLoop();
      },
      { wrapper }
    );
    await waitFor(() => expect(get).toHaveBeenCalledTimes(4));
    get.mockClear();

    await act(() => result.current.mutateAsync('l1'));

    expect(del).toHaveBeenCalledWith('/api/loops/l1');
    const fetched = get.mock.calls.map(([url]) => url);
    expect(fetched).toContain('/api/loops');
    expect(fetched.filter((url: string) => url.startsWith('/api/loops/l1'))).toEqual([]);
  });
});

describe('useResolveUnsure', () => {
  it('posts the outcome and the answer', async () => {
    post.mockResolvedValue({ data: {} });
    const { wrapper } = setup();
    const { result } = renderHook(() => useResolveUnsure(), { wrapper });

    await act(() => result.current.mutateAsync({ loopId: 'l1', eventId: 'e1', outcome: 'resumed', note: 'EU' }));
    await act(() => result.current.mutateAsync({ loopId: 'l1', eventId: 'e1', outcome: 'rejected' }));

    expect(post).toHaveBeenNthCalledWith(1, '/api/loops/l1/events/e1/resolve', { outcome: 'resumed', note: 'EU' });
    expect(post).toHaveBeenNthCalledWith(2, '/api/loops/l1/events/e1/resolve', { outcome: 'rejected' });
  });
});
