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
}));

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: h.get, post: h.post } }));
vi.mock('@client/app/contexts/WebsocketContext', () => ({
  ReadyState: { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 },
  useWebsocket: () => ({ readyState: h.readyState, subscribeToAction: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: { success: h.toastSuccess, error: h.toastError } }));

import { listOf, readyOutput, videoJob } from './__test__/videoGenerationFixtures';
import type { VideoGenerationList } from './videoGenerationCache';
import { videoGenerationKeys } from './videoGenerationKeys';
import {
  DETAIL_URL_REFRESH_LEAD_MS,
  LIST_URL_REFRESH_LEAD_MS,
  PENDING_SCAN_POLL_MS,
  SOCKET_DOWN_POLL_MS,
  URL_REFRESH_FLOOR_MS,
  useCreateVideoGeneration,
  useVideoGeneration,
  useVideoGenerations,
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
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
});

describe('videoGenerationPollInterval', () => {
  it('polls every 15s while the socket is down and stops when it is open', () => {
    for (const state of ['pending', 'running', 'storing'] as const) {
      expect(videoGenerationPollInterval(videoJob({ state }), false, NOW)).toBe(SOCKET_DOWN_POLL_MS);
      expect(videoGenerationPollInterval(videoJob({ state }), true, NOW)).toBe(false);
    }
  });

  it('keeps the socket-down poll under the 10/min per-user detail bucket', () => {
    expect(SOCKET_DOWN_POLL_MS).toBe(15_000);
  });

  it('treats a succeeded job without output as still running until the output arrives', () => {
    const noOutput = videoJob({ state: 'succeeded', output: null });
    expect(videoGenerationPollInterval(noOutput, false, NOW)).toBe(SOCKET_DOWN_POLL_MS);
    expect(videoGenerationPollInterval(noOutput, true, NOW)).toBe(false);
    const withOutput = videoJob({ state: 'succeeded', output: readyOutput({ expires_at: EXPIRES }) });
    expect(videoGenerationPollInterval(withOutput, false, NOW)).not.toBe(SOCKET_DOWN_POLL_MS);
  });

  it('re-reads a succeeded job every 30s while its file is being scanned', () => {
    const job = videoJob({
      state: 'succeeded',
      output: readyOutput({ availability: 'pending_scan', url: null, expires_at: null }),
    });
    expect(videoGenerationPollInterval(job, true, NOW)).toBe(PENDING_SCAN_POLL_MS);
  });

  it('re-signs a ready URL shortly before it expires', () => {
    const job = videoJob({ state: 'succeeded', output: readyOutput({ expires_at: EXPIRES }) });
    expect(videoGenerationPollInterval(job, true, NOW)).toBe(Date.parse(EXPIRES) - DETAIL_URL_REFRESH_LEAD_MS - NOW);
  });

  it('falls back to the refresh floor when the refresh time is already past (fast client clock)', () => {
    const job = videoJob({ state: 'succeeded', output: readyOutput({ expires_at: EXPIRES }) });
    expect(videoGenerationPollInterval(job, true, Date.parse(EXPIRES) + 60_000)).toBe(URL_REFRESH_FLOOR_MS);
    expect(videoGenerationPollInterval(job, true, Date.parse(EXPIRES) - DETAIL_URL_REFRESH_LEAD_MS)).toBe(
      URL_REFRESH_FLOOR_MS
    );
  });

  it('floors a short positive delay too, so clock skew cannot cause a rapid loop', () => {
    const job = videoJob({ state: 'succeeded', output: readyOutput({ expires_at: EXPIRES }) });
    const fiveSecondsBeforeRefresh = Date.parse(EXPIRES) - DETAIL_URL_REFRESH_LEAD_MS - 5_000;
    expect(videoGenerationPollInterval(job, true, fiveSecondsBeforeRefresh)).toBe(URL_REFRESH_FLOOR_MS);
  });

  it('stops for a finished job with nothing left to refresh', () => {
    expect(videoGenerationPollInterval(videoJob({ state: 'failed' }), false, NOW)).toBe(false);
    const gone = videoJob({
      state: 'succeeded',
      output: readyOutput({ availability: 'unavailable', url: null, expires_at: null }),
    });
    expect(videoGenerationPollInterval(gone, false, NOW)).toBe(false);
    expect(videoGenerationPollInterval(undefined, false, NOW)).toBe(false);
  });
});

describe('videoListRefreshInterval', () => {
  it("the list refresh fires before any card's own refresh", () => {
    const job = videoJob({ state: 'succeeded', output: readyOutput({ expires_at: EXPIRES }) });
    const list = listOf([job, videoJob({ id: 'job-2' })]);
    const listDelay = videoListRefreshInterval(list, NOW);
    const cardDelay = videoGenerationPollInterval(job, true, NOW);
    expect(listDelay).toBe(Date.parse(EXPIRES) - LIST_URL_REFRESH_LEAD_MS - NOW);
    expect(typeof listDelay === 'number' && typeof cardDelay === 'number' && listDelay < cardDelay).toBe(true);
  });

  it('does not refresh a list with no ready URL', () => {
    expect(videoListRefreshInterval(listOf([videoJob()]), NOW)).toBe(false);
    expect(videoListRefreshInterval(undefined, NOW)).toBe(false);
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

  it('does not refetch on mount when the detail is already cached', async () => {
    queryClient.setQueryData(videoGenerationKeys.detail('job-1'), videoJob({ id: 'job-1' }), {
      updatedAt: Date.now() - 120_000,
    });
    renderHook(() => useVideoGeneration('job-1'), { wrapper });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(h.get).not.toHaveBeenCalled();
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
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['credits-balance'] });
    expect(h.toastSuccess).toHaveBeenCalled();
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
