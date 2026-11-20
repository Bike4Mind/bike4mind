import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AxiosError, AxiosHeaders, type AxiosResponse } from 'axios';
import { api } from '@client/app/contexts/ApiContext';
import {
  useResolveStripeDispute,
  useStripeDisputes,
  useUndoContainStripeDispute,
  type StripeDisputeRow,
} from './stripeDisputes';

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { post: vi.fn(), get: vi.fn() } }));

const post = api.post as unknown as Mock;
const get = api.get as unknown as Mock;

const createWrapper = () => {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  return Wrapper;
};

const DISPUTE_ID = 'a'.repeat(24);

const row = (over: Partial<StripeDisputeRow> = {}): StripeDisputeRow => ({
  id: DISPUTE_ID,
  stripeDisputeId: 'dp_123',
  chargeId: 'ch_1',
  paymentIntentId: null,
  amount: 2500,
  currency: 'usd',
  reason: 'fraudulent',
  stripeStatus: 'needs_response',
  subject: 'organization',
  subjectId: 'b'.repeat(24),
  state: 'open',
  openedAt: '2026-10-01T00:00:00.000Z',
  closedAt: null,
  resolution: null,
  contain: null,
  ...over,
});

describe('useStripeDisputes', () => {
  beforeEach(() => {
    get.mockReset();
    get.mockResolvedValue({ data: { data: [], truncated: false } });
  });

  it('sends the filters as params and refetches when they change', async () => {
    const { result, rerender } = renderHook(({ query }) => useStripeDisputes(query), {
      wrapper: createWrapper(),
      initialProps: { query: { state: 'open', subject: 'unmatched' } as const } as {
        query: Parameters<typeof useStripeDisputes>[0];
      },
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(get).toHaveBeenCalledWith('/api/admin/stripe-disputes', { params: { state: 'open', subject: 'unmatched' } });

    rerender({ query: { state: 'resolved' } });
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    expect(get).toHaveBeenLastCalledWith('/api/admin/stripe-disputes', { params: { state: 'resolved' } });
  });
});

const REQUEST = { id: DISPUTE_ID, reason: 'Handled in Stripe' };

const httpError = (status: number, data: unknown) => {
  const config = { headers: new AxiosHeaders() };
  const response: AxiosResponse = { status, statusText: '', data, headers: {}, config };
  return new AxiosError(`Request failed with status code ${status}`, 'ERR_BAD_REQUEST', config, null, response);
};

const submit = async (hook: typeof useResolveStripeDispute) => {
  const { result } = renderHook(() => hook(), { wrapper: createWrapper() });
  let outcome: Promise<unknown> = Promise.resolve();
  act(() => {
    outcome = result.current.mutateAsync(REQUEST);
  });
  return outcome;
};

describe.each([
  ['useResolveStripeDispute', useResolveStripeDispute, 'resolve'],
  ['useUndoContainStripeDispute', useUndoContainStripeDispute, 'undo-contain'],
] as const)('%s', (_name, hook, path) => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves the updated dispute on a 200', async () => {
    const updated = row({ state: 'resolved' });
    post.mockResolvedValue({ data: updated });

    await expect(submit(hook)).resolves.toEqual({ status: 'done', item: updated });
    expect(post).toHaveBeenCalledExactlyOnceWith(`/api/admin/stripe-disputes/${path}`, REQUEST);
  });

  it('resolves a 409 as a conflict carrying the current dispute and the server message', async () => {
    const current = row({ state: 'resolved' });
    post.mockRejectedValue(httpError(409, { error: 'Already resolved.', item: current }));

    await expect(submit(hook)).resolves.toEqual({ status: 'conflict', item: current, message: 'Already resolved.' });
  });

  it('resolves a 409 without an item as a conflict with only the message', async () => {
    post.mockRejectedValue(httpError(409, { error: 'A later action changed the user.' }));

    await expect(submit(hook)).resolves.toEqual({
      status: 'conflict',
      item: null,
      message: 'A later action changed the user.',
    });
  });

  it('rejects a 409 whose item is malformed', async () => {
    const error = httpError(409, { error: 'x', item: { id: DISPUTE_ID } });
    post.mockRejectedValue(error);

    await expect(submit(hook)).rejects.toBe(error);
  });

  it('rejects any other failure, such as a 404', async () => {
    const error = httpError(404, { error: 'Dispute not found' });
    post.mockRejectedValue(error);

    await expect(submit(hook)).rejects.toBe(error);
  });
});

describe('cache refresh after an action', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const settle = async (hook: typeof useResolveStripeDispute) => {
    const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children);
    const { result } = renderHook(() => hook(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync(REQUEST);
    });
    return invalidate.mock.calls.map(([filters]) => filters?.queryKey);
  };

  it.each([
    ['a success', () => post.mockResolvedValue({ data: row({ state: 'resolved' }) })],
    ['a conflict', () => post.mockRejectedValue(httpError(409, { error: 'Already resolved.', item: row() }))],
  ])('refreshes the dispute list after %s', async (_name, arrange) => {
    arrange();
    expect(await settle(useResolveStripeDispute)).toEqual([['admin-stripe-disputes']]);
  });

  it('also refreshes the contained user after an undo', async () => {
    const userId = 'c'.repeat(24);
    post.mockResolvedValue({ data: row({ subject: 'user', subjectId: userId, state: 'resolved' }) });

    expect(await settle(useUndoContainStripeDispute)).toEqual([
      ['admin-stripe-disputes'],
      ['users'],
      ['admin', 'users', userId],
      ['admin', 'user-api-keys', userId],
    ]);
  });
});
