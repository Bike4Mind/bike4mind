import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { AxiosError } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VideoGeneration } from '@bike4mind/common';

const h = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  readyState: 1,
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  selectedAccount: null as { id: string; personal: boolean } | null,
}));

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: h.get, post: h.post } }));
vi.mock('@client/app/contexts/WebsocketContext', () => ({
  ReadyState: { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 },
  useWebsocket: () => ({ readyState: h.readyState, subscribeToAction: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: { success: h.toastSuccess, error: h.toastError } }));
vi.mock('@client/app/components/Credits/AccountSelector', () => ({
  useSelectedAccount: { getState: () => ({ selectedAccount: h.selectedAccount }) },
}));

import { listOf, rangeModel, readyOutput, videoJob } from './__test__/videoGenerationFixtures';
import type { VideoGenerationList } from './videoGenerationCache';
import { videoGenerationKeys } from './videoGenerationKeys';
import {
  AWAITING_OUTPUT_MAX_POLL_AGE_MS,
  DETAIL_URL_REFRESH_LEAD_MS,
  LIST_URL_REFRESH_LEAD_MS,
  PENDING_SCAN_MAX_POLL_MS,
  PENDING_SCAN_POLL_MS,
  SOCKET_DOWN_POLL_MS,
  URL_REFRESH_FLOOR_MS,
  useCancelVideoGeneration,
  useCreateVideoGeneration,
  useVideoGeneration,
  useVideoGenerations,
  useVideoModels,
  videoGenerationPollInterval,
  videoListRefreshInterval,
} from './videoGenerations';

const NOW = Date.parse('2026-10-07T00:00:00.000Z');
const EXPIRES = '2026-10-07T00:15:00.000Z';

let queryClient: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
);

beforeEach(() => {
  vi.clearAllMocks();
  h.readyState = 1;
  h.selectedAccount = null;
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
});

describe('videoGenerationPollInterval', () => {
  it('polls every 15s while the socket is down and stops when it is open', () => {
    for (const state of ['pending', 'running', 'storing'] as const) {
      expect(videoGenerationPollInterval(videoJob({ state }), false, NOW)).toBe(SOCKET_DOWN_POLL_MS);
      expect(videoGenerationPollInterval(videoJob({ state }), true, NOW)).toBe(false);
    }
  });

  it('polls every 15s, 4 detail reads a minute per job', () => {
    expect(SOCKET_DOWN_POLL_MS).toBe(15_000);
  });

  it('polls a succeeded job without output every 15s even with the socket open', () => {
    const noOutput = videoJob({ state: 'succeeded', credits: { reserved: 10, settled: 10 }, output: null });
    expect(videoGenerationPollInterval(noOutput, false, NOW)).toBe(SOCKET_DOWN_POLL_MS);
    expect(videoGenerationPollInterval(noOutput, true, NOW)).toBe(SOCKET_DOWN_POLL_MS);
    const withOutput = videoJob({
      state: 'succeeded',
      credits: { reserved: 10, settled: 10 },
      output: readyOutput({ expires_at: EXPIRES }),
    });
    expect(videoGenerationPollInterval(withOutput, false, NOW)).not.toBe(SOCKET_DOWN_POLL_MS);
  });

  it('stops polling for the output once the job has waited past the cap', () => {
    const noOutput = videoJob({ state: 'succeeded', credits: { reserved: 10, settled: 10 }, output: null });
    expect(videoGenerationPollInterval(noOutput, true, NOW + AWAITING_OUTPUT_MAX_POLL_AGE_MS - 1)).toBe(
      SOCKET_DOWN_POLL_MS
    );
    expect(videoGenerationPollInterval(noOutput, true, NOW + AWAITING_OUTPUT_MAX_POLL_AGE_MS)).toBe(false);
  });

  describe('while its file is being scanned', () => {
    const scanning = (updated_at: string) =>
      videoJob({
        state: 'succeeded',
        credits: { reserved: 10, settled: 10 },
        updated_at,
        output: readyOutput({ availability: 'pending_scan', url: null, expires_at: null }),
      });
    const ago = (ms: number) => new Date(NOW - ms).toISOString();

    it('re-reads a fresh job every 30s', () => {
      expect(videoGenerationPollInterval(scanning(ago(0)), true, NOW)).toBe(PENDING_SCAN_POLL_MS);
    });

    it('backs off with the age of the job', () => {
      expect(videoGenerationPollInterval(scanning(ago(120_000)), true, NOW)).toBe(120_000);
    });

    it('caps the back-off', () => {
      expect(videoGenerationPollInterval(scanning(ago(60 * 60_000)), true, NOW)).toBe(PENDING_SCAN_MAX_POLL_MS);
    });
  });

  it('re-signs a ready URL shortly before it expires', () => {
    const job = videoJob({
      state: 'succeeded',
      credits: { reserved: 10, settled: 10 },
      output: readyOutput({ expires_at: EXPIRES }),
    });
    expect(videoGenerationPollInterval(job, true, NOW)).toBe(Date.parse(EXPIRES) - DETAIL_URL_REFRESH_LEAD_MS - NOW);
  });

  it('falls back to the refresh floor when the refresh time is already past (fast client clock)', () => {
    const job = videoJob({
      state: 'succeeded',
      credits: { reserved: 10, settled: 10 },
      output: readyOutput({ expires_at: EXPIRES }),
    });
    expect(videoGenerationPollInterval(job, true, Date.parse(EXPIRES) + 60_000)).toBe(URL_REFRESH_FLOOR_MS);
    expect(videoGenerationPollInterval(job, true, Date.parse(EXPIRES) - DETAIL_URL_REFRESH_LEAD_MS)).toBe(
      URL_REFRESH_FLOOR_MS
    );
  });

  it('floors a short positive delay too, so clock skew cannot cause a rapid loop', () => {
    const job = videoJob({
      state: 'succeeded',
      credits: { reserved: 10, settled: 10 },
      output: readyOutput({ expires_at: EXPIRES }),
    });
    const fiveSecondsBeforeRefresh = Date.parse(EXPIRES) - DETAIL_URL_REFRESH_LEAD_MS - 5_000;
    expect(videoGenerationPollInterval(job, true, fiveSecondsBeforeRefresh)).toBe(URL_REFRESH_FLOOR_MS);
  });

  it('stops for a finished job with nothing left to refresh', () => {
    expect(
      videoGenerationPollInterval(videoJob({ state: 'failed', credits: { reserved: 10, settled: 0 } }), false, NOW)
    ).toBe(false);
    const gone = videoJob({
      state: 'succeeded',
      credits: { reserved: 10, settled: 10 },
      output: readyOutput({ availability: 'unavailable', url: null, expires_at: null }),
    });
    expect(videoGenerationPollInterval(gone, false, NOW)).toBe(false);
    expect(videoGenerationPollInterval(undefined, false, NOW)).toBe(false);
  });
});

describe('videoListRefreshInterval', () => {
  it("the list refresh fires before any card's own refresh", () => {
    const job = videoJob({
      state: 'succeeded',
      credits: { reserved: 10, settled: 10 },
      output: readyOutput({ expires_at: EXPIRES }),
    });
    const list = listOf([job, videoJob({ id: 'job-2' })]);
    const listDelay = videoListRefreshInterval(list, NOW);
    const cardDelay = videoGenerationPollInterval(job, true, NOW);
    expect(listDelay).toBe(Date.parse(EXPIRES) - LIST_URL_REFRESH_LEAD_MS - NOW);
    expect(typeof listDelay === 'number' && typeof cardDelay === 'number' && listDelay < cardDelay).toBe(true);
  });

  it('fires at the earliest expiry among several ready jobs', () => {
    const readyAt = (id: string, expires_at: string) =>
      videoJob({ id, state: 'succeeded', credits: { reserved: 10, settled: 10 }, output: readyOutput({ expires_at }) });
    const list = listOf([
      readyAt('late', '2026-10-07T00:14:00.000Z'),
      readyAt('earliest', '2026-10-07T00:05:00.000Z'),
      readyAt('middle', '2026-10-07T00:09:00.000Z'),
    ]);
    expect(videoListRefreshInterval(list, NOW)).toBe(
      Date.parse('2026-10-07T00:05:00.000Z') - LIST_URL_REFRESH_LEAD_MS - NOW
    );
  });

  it('does not refresh a list with no ready URL', () => {
    expect(videoListRefreshInterval(listOf([videoJob()]), NOW)).toBe(false);
    expect(videoListRefreshInterval(undefined, NOW)).toBe(false);
  });
});

describe('useVideoModels', () => {
  it('reads the model catalog', async () => {
    h.get.mockResolvedValue({ data: { models: [rangeModel] } });
    const { result } = renderHook(() => useVideoModels(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(h.get).toHaveBeenCalledWith('/api/v1/video-models');
    expect(result.current.data).toEqual([rangeModel]);
  });
});

describe('useVideoGenerations', () => {
  it('fetches the first page newest first and seeds every job into its detail entry', async () => {
    h.get.mockResolvedValue({ data: { data: [videoJob({ id: 'a' }), videoJob({ id: 'b' })], next_cursor: 'c1' } });
    const { result } = renderHook(() => useVideoGenerations(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(h.get).toHaveBeenCalledWith('/api/v1/video-generations', { params: { limit: 12 } });
    expect(result.current.hasNextPage).toBe(true);
    expect(queryClient.getQueryData<VideoGeneration>(videoGenerationKeys.detail('b'))?.id).toBe('b');
  });

  it('passes the cursor for the next page', async () => {
    h.get
      .mockResolvedValueOnce({ data: { data: [videoJob({ id: 'a' })], next_cursor: 'c1' } })
      .mockResolvedValueOnce({ data: { data: [videoJob({ id: 'b' })], next_cursor: null } });
    const { result } = renderHook(() => useVideoGenerations(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    // Reading hasNextPage first makes react-query track it, so the hook re-renders when the next page lands.
    expect(result.current.hasNextPage).toBe(true);
    await act(async () => {
      await result.current.fetchNextPage();
    });
    expect(h.get).toHaveBeenLastCalledWith('/api/v1/video-generations', { params: { limit: 12, cursor: 'c1' } });
    await waitFor(() => expect(result.current.hasNextPage).toBe(false));
  });
});

describe('useVideoGeneration', () => {
  const httpError = (status: number) =>
    new AxiosError('failed', 'ERR_BAD_RESPONSE', undefined, undefined, {
      status,
      data: {},
      statusText: '',
      headers: {},
      config: { headers: {} } as never,
    });

  it('does not retry a rate-limited (429) read', async () => {
    h.get.mockRejectedValue(httpError(429));
    const { result } = renderHook(() => useVideoGeneration('job-1'), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(h.get).toHaveBeenCalledTimes(1);
  });

  it('does not retry a missing (404) job', async () => {
    h.get.mockRejectedValue(httpError(404));
    const { result } = renderHook(() => useVideoGeneration('job-1'), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(h.get).toHaveBeenCalledTimes(1);
  });

  it('retries a server error (500)', async () => {
    h.get.mockRejectedValueOnce(httpError(500)).mockResolvedValue({ data: videoJob({ id: 'job-1' }) });
    const { result } = renderHook(() => useVideoGeneration('job-1'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true), { timeout: 5000 });
    expect(h.get).toHaveBeenCalledTimes(2);
  });

  it('keeps a finished job over a refetch that was read before it finished', async () => {
    queryClient.setQueryData(videoGenerationKeys.detail('job-1'), videoJob({ id: 'job-1', state: 'succeeded' }));
    h.get.mockResolvedValue({
      data: videoJob({ id: 'job-1', state: 'running', updated_at: '2026-10-07T00:01:00.000Z' }),
    });
    const { result } = renderHook(() => useVideoGeneration('job-1'), { wrapper });
    await result.current.refetch();
    expect(h.get).toHaveBeenCalled();
    expect(queryClient.getQueryData<VideoGeneration>(videoGenerationKeys.detail('job-1'))?.state).toBe('succeeded');
  });

  it('does not refetch on mount when the detail is already cached', async () => {
    queryClient.setQueryData(videoGenerationKeys.detail('job-1'), videoJob({ id: 'job-1' }), {
      updatedAt: Date.now() - 120_000,
    });
    renderHook(() => useVideoGeneration('job-1'), { wrapper });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(h.get).not.toHaveBeenCalled();
  });

  it('polls a live job every 15s while the socket is not open', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      h.readyState = 3;
      h.get.mockResolvedValue({ data: videoJob({ id: 'job-1', state: 'running' }) });
      queryClient.setQueryData(videoGenerationKeys.detail('job-1'), videoJob({ id: 'job-1', state: 'running' }));
      renderHook(() => useVideoGeneration('job-1'), { wrapper });
      expect(h.get).not.toHaveBeenCalled();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(SOCKET_DOWN_POLL_MS);
      });
      await waitFor(() => expect(h.get).toHaveBeenCalledTimes(1));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('useCreateVideoGeneration', () => {
  const body = { model: 'grok-imagine-video-1.5', prompt: 'a lighthouse', mode: 'text_to_video' as const };

  it('puts the new job at the top of the gallery and refreshes the credit balance', async () => {
    queryClient.setQueryData(videoGenerationKeys.list, listOf([videoJob({ id: 'old' })]));
    h.post.mockResolvedValue({ data: videoJob({ id: 'new', state: 'pending' }) });
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useCreateVideoGeneration(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync(body);
    });
    expect(h.post).toHaveBeenCalledWith('/api/v1/video-generations', body);
    const list = queryClient.getQueryData<VideoGenerationList>(videoGenerationKeys.list);
    expect(list?.pages[0].data.map(job => job.id)).toEqual(['new', 'old']);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['credits-balance'], refetchType: 'all' });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['organizations', 'user'], refetchType: 'all' });
    expect(h.toastSuccess).toHaveBeenCalled();
  });

  it('bills the org selected in the account switcher at submit time', async () => {
    h.post.mockResolvedValue({ data: videoJob({ id: 'new', state: 'pending' }) });
    const { result } = renderHook(() => useCreateVideoGeneration(), { wrapper });
    h.selectedAccount = { id: 'org-1', personal: false };
    await act(async () => {
      await result.current.mutateAsync(body);
    });
    expect(h.post).toHaveBeenCalledWith('/api/v1/video-generations', { ...body, organization_id: 'org-1' });
  });

  it('bills personal credits explicitly when the switcher shows the personal account', async () => {
    h.post.mockResolvedValue({ data: videoJob({ id: 'new', state: 'pending' }) });
    h.selectedAccount = { id: 'user-1', personal: true };
    const { result } = renderHook(() => useCreateVideoGeneration(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync(body);
    });
    expect(h.post).toHaveBeenCalledWith('/api/v1/video-generations', { ...body, organization_id: null });
  });

  it('omits organization_id while the switcher has no selection, so the server bills the home org', async () => {
    h.post.mockResolvedValue({ data: videoJob({ id: 'new', state: 'pending' }) });
    const { result } = renderHook(() => useCreateVideoGeneration(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync(body);
    });
    expect(h.post.mock.calls[0][1]).not.toHaveProperty('organization_id');
  });

  it('toasts the message for the refusal code, not the server text', async () => {
    h.post.mockRejectedValue(
      Object.assign(new AxiosError('Request failed'), {
        response: { status: 422, data: { error: 'raw text', request_id: 'r', errorCode: 'model_disabled' } },
      })
    );
    const { result } = renderHook(() => useCreateVideoGeneration(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync(body).catch(() => undefined);
    });
    expect(h.toastError).toHaveBeenCalledWith('This model has been turned off. Pick another model.');
  });
});

describe('useCancelVideoGeneration', () => {
  it('posts the cancel and writes the cancelled job into the detail and the list', async () => {
    queryClient.setQueryData(videoGenerationKeys.detail('job-1'), videoJob({ id: 'job-1', state: 'running' }));
    queryClient.setQueryData(videoGenerationKeys.list, listOf([videoJob({ id: 'job-1', state: 'running' })]));
    h.post.mockResolvedValue({
      data: videoJob({ id: 'job-1', state: 'cancelled', updated_at: '2026-10-07T00:01:00.000Z' }),
    });
    const { result } = renderHook(() => useCancelVideoGeneration(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync('job-1');
    });
    expect(h.post).toHaveBeenCalledWith('/api/v1/video-generations/job-1/cancel');
    expect(queryClient.getQueryData<VideoGeneration>(videoGenerationKeys.detail('job-1'))?.state).toBe('cancelled');
    const list = queryClient.getQueryData<VideoGenerationList>(videoGenerationKeys.list);
    expect(list?.pages[0].data[0].state).toBe('cancelled');
  });

  it('toasts the rate-limit message on a 429', async () => {
    h.post.mockRejectedValue(Object.assign(new AxiosError('Request failed'), { response: { status: 429, data: {} } }));
    const { result } = renderHook(() => useCancelVideoGeneration(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync('job-1').catch(() => undefined);
    });
    expect(h.toastError).toHaveBeenCalledWith('Too many requests. Wait a moment and try again.');
  });
});

describe('video generation balance settlement', () => {
  let queryClient: QueryClient;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );

  beforeEach(() => {
    h.get.mockReset();
    h.post.mockReset();
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  });

  it.each(['succeeded', 'failed', 'cancelled'] as const)(
    'refreshes balances once when detail polling observes %s settlement, with no websocket event',
    async state => {
      const job = videoJob({
        id: 'balance-job',
        state,
        credits: { reserved: 10, settled: 0 },
        updated_at: '2026-10-07T00:02:00.000Z',
      });
      queryClient.setQueryData(videoGenerationKeys.detail(job.id), videoJob({ id: job.id, state }));
      h.get
        .mockResolvedValueOnce({ data: { ...job, credits: { reserved: 10, settled: null } } })
        .mockResolvedValue({ data: job });
      const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
      const { result } = renderHook(() => useVideoGeneration(job.id), { wrapper });

      await act(() => result.current.refetch());
      expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ['organizations', 'user'], refetchType: 'all' });
      await act(async () => {
        const fetched = await result.current.refetch();
        expect(fetched.error).toBeNull();
      });
      await act(() => result.current.refetch());

      expect(queryClient.getQueryData<VideoGeneration>(videoGenerationKeys.detail(job.id))?.state).toBe(state);
      expect(invalidate.mock.calls.filter(([options]) => options?.queryKey?.[0] === 'credits-balance')).toHaveLength(1);
      expect(invalidate.mock.calls.filter(([options]) => options?.queryKey?.[0] === 'organizations')).toHaveLength(1);
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['organizations', 'user'], refetchType: 'all' });
    }
  );

  it('refreshes balances once when a gallery refetch discovers a completed job', async () => {
    const previous = videoJob({ id: 'balance-job', state: 'running' });
    const finished = videoJob({
      id: previous.id,
      state: 'failed',
      credits: { reserved: 10, settled: 0 },
      updated_at: '2026-10-07T00:02:00.000Z',
    });
    queryClient.setQueryData(videoGenerationKeys.detail(previous.id), previous);
    queryClient.setQueryData(videoGenerationKeys.list, {
      pages: [{ data: [previous], next_cursor: null }],
      pageParams: [undefined],
    });
    h.get.mockResolvedValue({ data: { data: [finished], next_cursor: null } });
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useVideoGenerations(), { wrapper });
    await waitFor(() => expect(result.current.data?.pages[0].data[0].state).toBe('failed'));

    await act(() => result.current.refetch());

    expect(invalidate.mock.calls.filter(([options]) => options?.queryKey?.[0] === 'organizations')).toHaveLength(1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['credits-balance'], refetchType: 'all' });
  });

  it('does not refresh balances for an older terminal snapshot rejected by reconciliation', async () => {
    const previous = videoJob({ id: 'balance-job', state: 'running', updated_at: '2026-10-07T00:02:00.000Z' });
    queryClient.setQueryData(videoGenerationKeys.detail(previous.id), previous);
    h.get.mockResolvedValue({
      data: videoJob({
        id: previous.id,
        state: 'failed',
        credits: { reserved: 10, settled: 0 },
        updated_at: '2026-10-07T00:01:00.000Z',
      }),
    });
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useVideoGeneration(previous.id), { wrapper });

    await act(() => result.current.refetch());

    expect(result.current.data?.state).toBe('running');
    expect(invalidate).not.toHaveBeenCalled();
  });

  it.each(['cancelled', 'running'] as const)(
    'refreshes cancellation balances only for a terminal response (%s)',
    async state => {
      h.post.mockResolvedValue({
        data: videoJob({
          id: 'balance-job',
          state,
          credits: { reserved: 10, settled: state === 'cancelled' ? 0 : null },
        }),
      });
      const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
      const { result } = renderHook(() => useCancelVideoGeneration(), { wrapper });

      await act(() => result.current.mutateAsync('balance-job'));

      const balanceRefreshes = invalidate.mock.calls.filter(([options]) => options?.queryKey?.[0] === 'organizations');
      expect(balanceRefreshes).toHaveLength(state === 'cancelled' ? 1 : 0);
    }
  );
});
