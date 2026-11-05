import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AxiosError, AxiosHeaders } from 'axios';
import { toast } from 'sonner';
import { api } from '@client/app/contexts/ApiContext';
import {
  loopKeys,
  useCreateLoop,
  useCreateLoopTicket,
  useDeleteLoop,
  useLoop,
  useLoopEvents,
  useLoopTickets,
  useLoops,
  useMoveLoopTicket,
  useResolveUnsure,
  useRunLoop,
  useSetLoopsBudget,
  useUpdateLoop,
  type ILoopTicket,
  type ILoopTicketsResponse,
} from './loops';

vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const post = api.post as unknown as Mock;
const patch = api.patch as unknown as Mock;
const get = api.get as unknown as Mock;
const put = api.put as unknown as Mock;
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

  it('confirms Run now and reloads only that loop and the list', async () => {
    post.mockResolvedValue({ data: {} });
    const { invalidate, wrapper } = setup();
    const { result } = renderHook(() => useRunLoop(), { wrapper });

    await act(() => result.current.mutateAsync('l1'));

    expect(post).toHaveBeenCalledWith('/api/loops/l1/run');
    expect(toast.success).toHaveBeenCalledWith('Starting now');
    expect(invalidate.mock.calls.map(([filters]) => filters)).toEqual([
      { queryKey: loopKeys.detail('l1') },
      { queryKey: loopKeys.all, exact: true },
    ]);
  });

  it('says why Run now cannot start yet', async () => {
    post.mockResolvedValue({ data: { waitingReason: 'Already running; the next run starts when this one ends' } });
    const { wrapper } = setup();
    const { result } = renderHook(() => useRunLoop(), { wrapper });

    await act(() => result.current.mutateAsync('l1'));

    expect(toast.info).toHaveBeenCalledWith('Already running; the next run starts when this one ends');
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('scopes each mutation to the queries it touched', async () => {
    post.mockResolvedValue({ data: {} });
    put.mockResolvedValue({ data: {} });
    patch.mockResolvedValue({ data: {} });
    const { invalidate, wrapper } = setup();
    const keysAfter = async (run: () => Promise<unknown>) => {
      invalidate.mockClear();
      await act(run);
      return invalidate.mock.calls.map(([filters]) => filters);
    };
    const { result } = renderHook(
      () => ({
        create: useCreateLoop(),
        budget: useSetLoopsBudget(),
        update: useUpdateLoop(),
        ticket: useCreateLoopTicket(),
      }),
      { wrapper }
    );

    expect(await keysAfter(() => result.current.create.mutateAsync({} as never))).toEqual([
      { queryKey: loopKeys.all, exact: true },
    ]);
    expect(await keysAfter(() => result.current.budget.mutateAsync(50))).toEqual([
      { queryKey: loopKeys.budget },
      { queryKey: loopKeys.all, exact: true },
    ]);
    expect(await keysAfter(() => result.current.update.mutateAsync({ id: 'l2', status: 'paused' }))).toEqual([
      { queryKey: loopKeys.detail('l2') },
      { queryKey: loopKeys.all, exact: true },
    ]);
    expect(
      await keysAfter(() =>
        result.current.ticket.mutateAsync({ loopId: 'l3', title: 't', stage: 'todo', priority: 'p2' })
      )
    ).toEqual([{ queryKey: loopKeys.tickets('l3') }, { queryKey: loopKeys.detail('l3') }]);
  });

  it('does not wait for the refetch to settle', async () => {
    patch.mockResolvedValue({ data: {} });
    const { queryClient, wrapper } = setup();
    vi.spyOn(queryClient, 'invalidateQueries').mockReturnValue(new Promise(() => undefined));
    const { result } = renderHook(() => useUpdateLoop(), { wrapper });

    await act(() => result.current.mutateAsync({ id: 'l1', status: 'paused' }));

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });
});

describe('useMoveLoopTicket', () => {
  const card = (id: string, stage: string): ILoopTicket => ({
    id,
    title: id,
    stage,
    status: 'open',
    dependencies: [],
    runCount: 0,
    priority: 'p2',
    ready: true,
    createdAt: '2026-11-05T10:00:00.000Z',
    updatedAt: '2026-11-05T10:00:00.000Z',
  });
  const board: ILoopTicketsResponse = {
    stages: [
      { stage: 'todo', tickets: [card('t1', 'todo'), card('t2', 'todo')] },
      { stage: 'doing', tickets: [] },
    ],
    runLimit: 6,
  };
  const where = (data?: ILoopTicketsResponse) =>
    Object.fromEntries(
      (data?.stages ?? []).map(group => [group.stage, group.tickets.map(t => `${t.id}:${t.priority}`)])
    );

  function seeded() {
    const ctx = setup();
    ctx.queryClient.setQueryData(loopKeys.tickets('l1'), board);
    const { result } = renderHook(() => useMoveLoopTicket(), { wrapper: ctx.wrapper });
    const cached = () => where(ctx.queryClient.getQueryData<ILoopTicketsResponse>(loopKeys.tickets('l1')));
    return { ...ctx, result, cached };
  }

  it('moves the card in the cache before the save returns, then refetches only that loop', async () => {
    let resolve!: (value: unknown) => void;
    patch.mockReturnValue(new Promise(r => (resolve = r)));
    const { result, cached, invalidate } = seeded();

    act(() => result.current.mutate({ loopId: 'l1', id: 't1', stage: 'doing' }));

    await waitFor(() => expect(cached()).toEqual({ todo: ['t2:p2'], doing: ['t1:p2'] }));
    expect(patch).toHaveBeenCalledWith('/api/work-items/t1', { stage: 'doing' });
    expect(invalidate).not.toHaveBeenCalled();

    await act(async () => resolve({ data: {} }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidate.mock.calls.map(([filters]) => filters)).toEqual([
      { queryKey: loopKeys.tickets('l1') },
      { queryKey: loopKeys.detail('l1'), exact: true },
    ]);
  });

  it('changes priority in place', async () => {
    patch.mockReturnValue(new Promise(() => undefined));
    const { result, cached } = seeded();

    act(() => result.current.mutate({ loopId: 'l1', id: 't2', priority: 'p0' }));

    await waitFor(() => expect(cached()).toEqual({ todo: ['t1:p2', 't2:p0'], doing: [] }));
  });

  it('rolls the card back and toasts when the save fails', async () => {
    patch.mockRejectedValue(httpError(500, 'boom'));
    const { result, cached, invalidate } = seeded();

    await act(() => result.current.mutateAsync({ loopId: 'l1', id: 't1', stage: 'doing' }).catch(() => undefined));

    expect(cached()).toEqual({ todo: ['t1:p2', 't2:p2'], doing: [] });
    expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/boom/));
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: loopKeys.all });
  });

  it('reloads every loop on a 409', async () => {
    patch.mockRejectedValue(httpError(409, 'Ticket changed while saving'));
    const { result, cached, invalidate } = seeded();

    await act(() => result.current.mutateAsync({ loopId: 'l1', id: 't1', stage: 'doing' }).catch(() => undefined));

    expect(cached()).toEqual({ todo: ['t1:p2', 't2:p2'], doing: [] });
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
